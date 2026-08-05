'use strict';
/* ============================================================
 * Supabase 反代云函数（腾讯云 SCF · 事件函数 · Node.js 16/18）
 * 入口 main_handler，由平台直接调用。
 * 无需 scf_bootstrap / 端口监听 / 启动命令 —— Web 函数形态的坑全不涉及。
 *
 * 部署：SCF 控制台 → 香港 → 新建「事件函数」→ 上传本文件(命名 index.js)的 zip
 *       → 函数 URL 开公网 + CORS(*) + 授权「开放」→ 复制公网 URL
 * ============================================================ */
const ORIGIN = 'https://uuvgvocusrpfakjevbnt.supabase.co';
const ORIGIN_HOST = 'uuvgvocusrpfakjevbnt.supabase.co';

function pickMethod(event) {
  if (event.httpMethod) return String(event.httpMethod).toUpperCase();
  var rc = event.requestContext;
  if (rc && rc.http && rc.http.method) return String(rc.http.method).toUpperCase();
  if (rc && rc.method) return String(rc.method).toUpperCase();
  return 'GET';
}

function pickPath(event) {
  if (typeof event.path === 'string' && event.path) return event.path;
  var rc = event.requestContext;
  if (rc && rc.http && rc.http.path) return rc.http.path;
  return '/';
}

function pickQuery(event) {
  // 腾讯云函数 URL 默认模式下 queryString 可能是「对象」而非字符串，两种都要处理
  var q = event.queryString;
  if (typeof q === 'string' && q) return '?' + q;
  if (q && typeof q === 'object') {
    var parts = [];
    for (var k in q) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
    if (parts.length) return '?' + parts.join('&');
  }
  var q2 = event.queryStringParameters;
  if (q2 && typeof q2 === 'object') {
    var parts2 = [];
    for (var k2 in q2) parts2.push(encodeURIComponent(k2) + '=' + encodeURIComponent(q2[k2]));
    if (parts2.length) return '?' + parts2.join('&');
  }
  return '';
}

exports.main_handler = async function (event) {
  var CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': '*',
    'access-control-allow-headers': '*'
  };
  try {
    event = event || {};
    var method = pickMethod(event);

    // 预检请求直接放行
    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: CORS, body: '', isBase64Encoded: false };
    }

    var url = ORIGIN + pickPath(event) + pickQuery(event);

    var headers = {};
    var h = event.headers || {};
    for (var k in h) {
      var lk = String(k).toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
      if (lk.indexOf('x-scf-') === 0) continue; // 去掉 SCF 注入头
      headers[lk] = h[k];
    }
    headers['host'] = ORIGIN_HOST; // 关键：Host 改成源站，否则 Cloudflare 404/522

    var opt = { method: method, headers: headers };
    if (event.body && method !== 'GET' && method !== 'HEAD') {
      opt.body = event.isBase64Encoded ? Buffer.from(String(event.body), 'base64') : String(event.body);
    }

    var r = await fetch(url, opt);
    var buf = Buffer.from(await r.arrayBuffer());

    var respHeaders = {};
    r.headers.forEach(function (v, k) { respHeaders[k] = v; });
    // fetch 已解压且 body 重新打包，这些头必须删，否则浏览器判畸形响应
    delete respHeaders['content-encoding'];
    delete respHeaders['content-length'];
    delete respHeaders['transfer-encoding'];
    delete respHeaders['connection'];
    delete respHeaders['set-cookie']; // Domain=supabase.co 在本域下无效，删掉
    respHeaders['access-control-allow-origin'] = '*';
    respHeaders['access-control-allow-methods'] = '*';
    respHeaders['access-control-allow-headers'] = '*';

    // 函数 URL 默认模式不处理 isBase64Encoded（会把 base64 原文当附件返回，
    // 加 Content-Disposition: attachment → 浏览器 ERR_INVALID_RESPONSE）。
    // Supabase 响应全是 JSON 文本，直接 UTF-8 字符串返回。
    return {
      statusCode: r.status,
      headers: respHeaders,
      body: buf.toString('utf8'),
      isBase64Encoded: false
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: 'proxy_error', message: String((e && e.message) || e) }),
      isBase64Encoded: false
    };
  }
};
