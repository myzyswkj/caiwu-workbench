'use strict';
/* ============================================================
 * Supabase 反代云函数（腾讯云 SCF · Web 函数 · Node.js 18+）
 * 浏览器只访问本函数（国内可达），由本函数转发到 Supabase 海外源站。
 * 无第三方依赖，使用 Node 18 全局 fetch。
 *
 * 部署：腾讯云 SCF 控制台 → 香港 → 新建 Web 函数 → 运行环境 Node.js 18
 *       把本文件内容贴到 index.js → 部署 → 复制访问 URL
 * ============================================================ */
const http = require('http');

const ORIGIN = 'https://uuvgvocusrpfakjevbnt.supabase.co';
const ORIGIN_HOST = 'uuvgvocusrpfakjevbnt.supabase.co';

const server = http.createServer(function (req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', async function () {
    var body = chunks.length ? Buffer.concat(chunks) : null;

    // 透传请求头；关键：把 Host 改成源站，否则 Cloudflare 返回 404/522
    var headers = Object.assign({}, req.headers, { host: ORIGIN_HOST });
    delete headers['content-length'];     // 由 fetch 按实际 body 重新计算
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];
    delete headers['x-real-ip'];

    var url = ORIGIN + req.url;
    var opt = { method: req.method, headers: headers };
    if (body && req.method !== 'GET' && req.method !== 'HEAD') opt.body = body;

    try {
      var r = await fetch(url, opt);
      var buf = Buffer.from(await r.arrayBuffer());
      var respHeaders = {};
      r.headers.forEach(function (v, k) { respHeaders[k] = v; });
      // fetch 已自动解压 gzip/br 且 body 已重新打包，逐字透传下面这些头
      // 会让响应头与实际 body 不符（畸形响应，浏览器 ERR_INVALID_RESPONSE），必须删
      delete respHeaders['content-encoding'];
      delete respHeaders['content-length'];
      delete respHeaders['transfer-encoding'];
      delete respHeaders['connection'];
      // 确保 CORS 开放（Supabase 源站本身就是 *，这里兜底）
      if (!respHeaders['access-control-allow-origin']) {
        respHeaders['access-control-allow-origin'] = '*';
      }
      res.writeHead(r.status, respHeaders);
      res.end(buf);
    } catch (e) {
      console.error('[supabase-proxy] error', e && e.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_error', message: String(e && e.message || e) }));
    }
  });
  req.on('error', function (e) {
    try { res.writeHead(400); res.end('bad request: ' + e.message); } catch (_) {}
  });
});

var port = process.env.PORT || 9000;
server.listen(port, '0.0.0.0', function () {
  console.log('[supabase-proxy] listening on ' + port);
});
