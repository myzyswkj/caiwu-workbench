/* ============================================================
 * Supabase 反代边缘函数（EdgeOne Pages Functions · 标准 Fetch API）
 * 路由：/proxy/* → https://uuvgvocusrpfakjevbnt.supabase.co/*
 * onRequest 由平台直接调用，无启动脚本/端口/base64 等坑。
 * ============================================================ */
const ORIGIN = 'https://uuvgvocusrpfakjevbnt.supabase.co';
const ORIGIN_HOST = 'uuvgvocusrpfakjevbnt.supabase.co';

export async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/proxy/, '') || '/';
  const target = ORIGIN + path + url.search;

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': '*',
    'access-control-allow-headers': '*'
  };

  // 预检请求直接放行
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // 透传请求头；关键：Host 改成源站，否则 Cloudflare 404/522
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
    headers.set(lk, v);
  }
  headers.set('host', ORIGIN_HOST);

  const init = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  try {
    const resp = await fetch(target, init);
    const respHeaders = new Headers(resp.headers);
    // fetch 已解压且 body 重新打包，这些头必须删，否则浏览器判畸形响应
    ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']
      .forEach(function (h) { respHeaders.delete(h); });
    respHeaders.set('access-control-allow-origin', '*');
    respHeaders.set('access-control-allow-methods', '*');
    respHeaders.set('access-control-allow-headers', '*');
    return new Response(resp.body, { status: resp.status, headers: respHeaders });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'proxy_error', message: String((e && e.message) || e) }),
      { status: 502, headers: Object.assign({ 'content-type': 'application/json' }, CORS) }
    );
  }
}
