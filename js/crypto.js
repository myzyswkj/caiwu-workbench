/* ============================================================
 * 本地加密模块（Web Crypto：PBKDF2 + AES-GCM）
 * - 主密码 → PBKDF2 派生 AES-256 密钥
 * - 数据用 AES-GCM 加密（含完整性校验）
 * - 密钥只存在于内存，永不上传；云端只存密文
 * - 浏览器需在安全上下文（HTTPS / localhost）下才有 crypto.subtle
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW = global.FW || {};

  // 优先选具备 subtle 的 crypto 实现
  // 顺序：webkitCrypto 优先（老 Safari / 测试注入） → 标准 crypto
  function pickCrypto() {
    var list = [global.webkitCrypto, global.crypto];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].subtle) return list[i];
    }
    return null;
  }
  var c = pickCrypto();
  var subtle = c ? c.subtle : null;

  // 纯 JS Base64（不依赖 btoa/atob，规避 jsdom 环境不一致）
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64Index(c) { return B64.indexOf(c); }
  function b64enc(buf) {
    var u = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < u.length; i += 3) {
      var b0 = u[i];
      var b1 = (i + 1 < u.length) ? u[i + 1] : 0;
      var b2 = (i + 2 < u.length) ? u[i + 2] : 0;
      var n = (b0 << 16) | (b1 << 8) | b2;
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      s += (i + 1 < u.length) ? B64[(n >> 6) & 63] : '=';
      s += (i + 2 < u.length) ? B64[n & 63] : '=';
    }
    return s;
  }
  function b64dec(str) {
    // 去掉末尾的 = 填充，避免负值污染整组字节
    str = String(str).replace(/=+$/, '');
    var outLen = Math.floor(str.length * 3 / 4);
    var u = new Uint8Array(outLen);
    var p = 0;
    for (var i = 0; i < str.length; i += 4) {
      var a = b64Index(str.charAt(i));
      var b = b64Index(str.charAt(i + 1));
      var c = (i + 2 < str.length) ? b64Index(str.charAt(i + 2)) : 0;
      var d = (i + 3 < str.length) ? b64Index(str.charAt(i + 3)) : 0;
      var n = (a << 18) | (b << 12) | (c << 6) | d;
      if (p < outLen) u[p++] = (n >> 16) & 255;
      if (p < outLen) u[p++] = (n >> 8) & 255;
      if (p < outLen) u[p++] = n & 255;
    }
    return u;
  }
  // 不依赖 TextEncoder 的 UTF-8 编解码（兼容 jsdom）
  function toU8(str) {
    var s = unescape(encodeURIComponent(str));
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function fromU8(buf) {
    // subtle.decrypt 返回 ArrayBuffer，需先转成 Uint8Array
    var u = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return decodeURIComponent(escape(s));
  }
  function rand(n) {
    var a = new Uint8Array(n);
    (c || global.webkitCrypto).getRandomValues(a);
    return a;
  }

  // 由主密码派生密钥；saltB64 不传则随机生成（跨设备用同一 salt 保证密钥一致）
  function deriveKey(password, saltB64) {
    var salt = saltB64 ? b64dec(saltB64) : rand(16);
    return subtle.importKey('raw', toU8(password), 'PBKDF2', false, ['deriveKey']).then(function (km) {
      return subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: 120000, hash: 'SHA-256' },
        km,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      ).then(function (key) { return { key: key, saltB64: b64enc(salt) }; });
    });
  }

  function encrypt(key, obj) {
    var iv = rand(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, toU8(JSON.stringify(obj))).then(function (ct) {
      return { iv: b64enc(iv), ct: b64enc(ct) };
    });
  }

  function decrypt(key, payload) {
    if (!payload || !payload.iv || !payload.ct) return Promise.reject(new Error('密文缺失'));
    return subtle.decrypt({ name: 'AES-GCM', iv: b64dec(payload.iv) }, key, b64dec(payload.ct)).then(function (pt) {
      return JSON.parse(fromU8(pt));
    }).catch(function () { return Promise.reject(new Error('密码错误')); });
  }

  FW.crypto = {
    available: !!subtle,
    deriveKey: deriveKey,
    encrypt: encrypt,
    decrypt: decrypt,
    b64enc: b64enc,
    b64dec: b64dec
  };
})(window);
