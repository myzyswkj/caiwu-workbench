/* 凭证图云同步回归测试 —— 走 fetch REST，mock global.fetch（不依赖 sb.storage） */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('./setup').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><body><div id="authArea"></div></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
// 测试沙箱里 jsdom/Node 的 atob 比浏览器原生更严格，用 Buffer 兜底（仅测试环境）
global.atob = function (s) { return Buffer.from(String(s), 'base64').toString('binary'); };
global.btoa = function (s) { return Buffer.from(String(s), 'binary').toString('base64'); };
global.Blob = dom.window.Blob || global.Blob;
global.FileReader = dom.window.FileReader;
global.confirm = function () { return true; };

// 合法 base64
var SAMPLE = 'data:image/png;base64,iVBORw0KGgo=';

var cloudList = [];       // 云端清单（pid 列表）
var cloudError = null;    // 模拟云端 404/Bucket not found
var uploadError = null;   // 模拟上传失败
var calls = { list: 0, upload: 0, download: 0, remove: 0 };
var photoStore = {};
var localPhotoIds = [];

// mock fetch：按 URL+method 分发到 4 个 REST 端点
function okJson(data, status) { return { ok: true, status: status || 200, json: function () { return Promise.resolve(data); }, blob: function () { return Promise.resolve(new dom.window.Blob(['x'])); }, text: function () { return Promise.resolve(JSON.stringify(data || [])); } }; }
function errJson(status, msg) { return { ok: false, status: status, json: function () { return Promise.resolve({ message: msg }); }, blob: function () { return Promise.reject(new Error(msg)); }, text: function () { return Promise.resolve('{"message":"' + msg + '"}'); } }; }
global.fetch = function (u, opts) {
  var method = (opts && opts.method) || 'GET';
  var url = String(u);
  if (url.indexOf('/list/vouchers') >= 0) {
    // 列表端点（不分 GET/POST：之前误用 GET /object/list/{b}?prefix=... 实际不存在路径，
    // 现改为 POST /object/list/{b} + JSON body，与 supabase-js 客户端 storage.from().list() 一致）
    calls.list++;
    if (cloudError) return Promise.resolve(errJson(cloudError.statusCode || 404, cloudError.message || 'Bucket not found'));
    return Promise.resolve(okJson(cloudList));
  }
  if (url.indexOf('/object/vouchers/') >= 0 && method === 'POST') {
    calls.upload++;
    if (uploadError) return Promise.resolve(errJson(500, 'upload failed'));
    return Promise.resolve(okJson({ Key: 'ok' }));
  }
  if (url.indexOf('/object/vouchers/') >= 0 && method === 'GET') {
    calls.download++;
    if (cloudError) return Promise.resolve(errJson(cloudError.statusCode || 404, cloudError.message || 'Bucket not found'));
    return Promise.resolve(okJson({}));
  }
  if (url.indexOf('/object/vouchers') >= 0 && method === 'DELETE') {
    calls.remove++;
    return Promise.resolve(okJson([]));
  }
  return Promise.resolve(errJson(404, 'unmocked ' + method + ' ' + url));
};

// fakeSb：保留 auth session() 让 getAccessToken 走真实分支
var fakeSb = {
  from: function () {
    var o = {};
    o.select = function () { return o; };
    o.eq = function () { return o; };
    o.order = function () { return o; };
    o.maybeSingle = function () { return Promise.resolve({ data: null, error: { code: 'PGRST116' } }); };
    o.single = function () { return o; };
    // pushOnce 走 sb.from('snapshots').upsert(...) 并交给 withTimeout（期望 Promise）
    o.upsert = function () { return Promise.resolve({ error: null }); };
    o.insert = function () { return Promise.resolve({ error: null }); };
    o.update = function () { return o; };
    o.delete = function () { return o; };
    o.neq = function () { return o; };
    return o;
  },
  auth: {
    session: function () { return { access_token: 'fake-token' }; },
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.c' }, access_token: 'fake-token' } } }); },
    onAuthStateChange: function () {},
    signOut: function () { return Promise.resolve(); }
  }
};
global.supabase = { createClient: function () { return fakeSb; } };

var toasts = [];
global.FW = {
  toast: function (m) { toasts.push(m); },
  db: {
    cryptoEnabled: function () { return false; },
    isUnlocked: function () { return true; },
    listLocalPhotoIds: function () { return Promise.resolve(localPhotoIds); },
    getPhoto: function (id) { return Promise.resolve(photoStore[id] || null); },
    putPhotoById: function (id, d) { photoStore[id] = d; return Promise.resolve(); },
    saveList: function () { return Promise.resolve(); }, upsert: function () { return Promise.resolve(); }, remove: function () { return Promise.resolve(); },
    getList: function () { return Promise.resolve([]); }, getById: function () { return Promise.resolve(null); },
    savePhoto: function () { return Promise.resolve(); }, deletePhoto: function () { return Promise.resolve(); }, deletePhotos: function () { return Promise.resolve(); },
    getAllPhotos: function () { return Promise.resolve([]); }, exportSyncSnapshot: function () { return Promise.resolve({ raw: {} }); }, importAll: function () { return Promise.resolve(); },
    enableCrypto: function () {}, unlock: function () {}, lock: function () {}, getCurrentLedger: function () { return 'L1'; }, setCurrentLedger: function () {},
    encryptSnapshot: function (s) { return Promise.resolve(s); }, decryptSnapshot: function (s) { return Promise.resolve(s); }
  }
};
global.APP_CONFIG = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' };
dom.window.FW = global.FW;
dom.window.supabase = global.supabase;
dom.window.APP_CONFIG = global.APP_CONFIG;

var passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  OK ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}
function reset() {
  calls = { list: 0, upload: 0, download: 0, remove: 0 };
  cloudError = null; uploadError = null; photoStore = {}; localPhotoIds = []; toasts = [];
}

// 加载 sync.js（IIFE，挂到 FW.sync）
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'));
dom.window.FW.sync = FW.sync;

// 等异步 init 完成
function ready() { return FW.sync.init ? Promise.resolve() : Promise.reject(new Error('FW.sync.init missing')); }

(async () => {
  await ready();
  // 主动 fire DOMContentLoaded 触发 sync.js 末尾注册的 init listener
  // （jsdom 在 evaluate 同步阶段 readyState 还是 'loading'，会等 DOMContentLoaded）
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  // 等 init 内的 withTimeout().then() 把 user 设上
  await new Promise(function (r) { setTimeout(r, 50); });

  // 场景1：桶未建 → needSetup=true，无任何上传/下载/删除
  reset();
  cloudError = { statusCode: 404, message: 'Bucket not found' };
  var r1 = await FW.sync.syncPhotos();
  ok('场景1 返回 needSetup', r1 && r1.needSetup === true);
  ok('场景1 仅触发 1 次 list fetch', calls.list === 1);
  ok('场景1 未触发任何上传/下载/删除', calls.upload === 0 && calls.download === 0 && calls.remove === 0);

  // 场景2：本地 L1,L2 + 云端 C1,C2 → 上传 L1,L2，下载 C1,C2，不删
  reset();
  localPhotoIds = ['L1', 'L2'];
  cloudList = [{ name: 'C1' }, { name: 'C2' }];
  photoStore = { L1: SAMPLE, L2: SAMPLE };
  var r2 = await FW.sync.syncPhotos();
  ok('场景2 上传本地缺失(L1,L2)=2', calls.upload === 2 && r2.up === 2);
  ok('场景2 下载云端缺失(C1,C2)=2', calls.download === 2 && r2.dl === 2);
  ok('场景2 合并模式不清理云端', calls.remove === 0);
  ok('场景2 本地已补齐 C1/C2', !!photoStore.C1 && !!photoStore.C2);

  // 场景3：上传失败不抛错、不阻塞批
  reset();
  localPhotoIds = ['L1'];
  photoStore = { L1: SAMPLE };
  uploadError = { message: 'network fail' };
  var r3 = await FW.sync.syncPhotos();
  ok('场景3 仍尝试了上传', calls.upload === 1);
  ok('场景3 失败被吞、up=0', r3.up === 0);

  // 场景4：完全对齐 → 零传输
  reset();
  localPhotoIds = ['X1'];
  photoStore = { X1: SAMPLE };
  cloudList = [{ name: 'X1' }];
  var r4 = await FW.sync.syncPhotos();
  ok('场景4 已对齐、无上传/下载/删除', calls.upload === 0 && calls.download === 0 && calls.remove === 0);

  // 场景5：mirror 模式 → 上传本地独有 + 删除云端多余，不下载
  reset();
  localPhotoIds = ['L1'];
  photoStore = { L1: SAMPLE };
  cloudList = [{ name: 'L1' }, { name: 'X1' }, { name: 'X2' }];
  var r5 = await FW.sync.syncPhotos({ mirror: true });
  ok('场景5 mirror 上传本地独有(L1)', calls.upload === 0);  // L1 已在云端，无须上传
  ok('场景5 mirror 清理云端多余(X1,X2)=2', calls.remove === 2 && r5.del === 2);
  ok('场景5 mirror 不下载云端独有', calls.download === 0);

  // 场景6：Supabase 实际桶缺失错误码（400 + "Bucket not found"，不是 404）也要判 needSetup
  // （2026-08-07 真实案例：用户跑 SQL 时 CREATE POLICY 报错 42710 导致整事务回滚，
  //  桶没建好，list 接口实际返回 statusCode=400 + "Bucket not found"，不是 404）
  reset();
  cloudError = { statusCode: 400, message: 'Bucket not found' };
  var r6 = await FW.sync.syncPhotos();
  ok('场景6 (400+Bucket not found) 返回 needSetup', r6 && r6.needSetup === true);
  ok('场景6 未触发任何上传/下载/删除', calls.upload === 0 && calls.download === 0 && calls.remove === 0);

  // 场景7：list 报 RLS / auth 错（不含 Bucket not found）应走 pr.error，不误判 needSetup
  // （防止 2026-08-07 的"误报未开启"回归——RLS/auth 错也可能含 Bucket 字样，但 message 不是 "Bucket not found"）
  reset();
  cloudError = { statusCode: 403, message: 'new row violates row level security policy' };
  var r7 = await FW.sync.syncPhotos();
  ok('场景7 (RLS 403) 不返回 needSetup', !(r7 && r7.needSetup === true));
  ok('场景7 返回 pr.error 含真实信息', r7 && r7.error && /row.level.security/i.test(r7.error));


  // 场景8：_getAccessToken 正向 —— 正常登录态下应返回「真实用户 token」而非 anon
  // （证明 getAccessToken 不再因 sb.auth.session() 废弃而静默回退 anon）
  var tok8 = FW.sync._getAccessToken();
  ok('场景8 _getAccessToken 返回真实 token（非 anon）', tok8 && tok8 !== 'anon');

  // 场景9（关键回归锁）：模拟 supabase-js v2.110.8 已移除 sb.auth.session()（typeof!=='function'），
  // 且 init 的 getSession 因网络超时未缓存 session（cachedSession 保持 null）。
  // 验证 getAccessToken 仍能从 localStorage 兜底拿到真实用户 token（不回退 anon）。
  // 这正是「桶已建好却报凭证图同步未开启」的根因：旧代码 sb.auth.session() 返回 null → 回退 anon →
  // anon 调私有桶被 Supabase 一律返回 Bucket not found → 误判 needSetup。
  (function () {
    fakeSb.auth.session = undefined;  // 模拟方法被移除
    fakeSb.auth.getSession = function () { return Promise.reject(new Error('timeout')); }; // 模拟恢复会话超时
    global.localStorage = dom.window.localStorage;  // 测试环境把 jsdom localStorage 暴露给 global
    dom.window.localStorage.setItem('sb-x-auth-token', JSON.stringify({ access_token: 'LS_TOKEN_999' }));
    // 重置模块级 cachedSession：重新加载 sync.js（IIFE 会把 inited/cachedSession 等复位）
    delete dom.window.FW.sync;
    eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'));
    dom.window.FW.sync = global.FW.sync;
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  })();
  await new Promise(function (r) { setTimeout(r, 50); });
  var tok9 = FW.sync._getAccessToken();
  ok('场景9 移除 session()+getSession超时 仍从 localStorage 取真实 token', tok9 === 'LS_TOKEN_999');
  ok('场景9 未回退 anon', tok9 !== 'anon');
  // 场景10：_diagnose 一键诊断（用户遇到「凭证图云同步未开启」时跑这一行，把 console 输出的 JSON 复制给我即可）
  // 在场景 9 的状态（fakeSb.session=undefined, getSession 仍 reject, localStorage 注入完整 session）下：
  //   重新加载 sync.js 让 cachedSession 复位为 null；再手动注入含 user.id 的完整 session；
  //   _diagnose 应当能从 localStorage 兜底取到真实 token，并能真实调一次 list 接口拿到 status。
  dom.window.localStorage.setItem('sb-x-auth-token', JSON.stringify({
    access_token: 'LS_TOKEN_FULL',
    user: { id: 'u1', email: 'a@b.c' }
  }));
  delete dom.window.FW.sync;
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'));
  dom.window.FW.sync = global.FW.sync;
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise(function (r) { setTimeout(r, 30); });

  var d10 = await FW.sync._diagnose();
  ok('场景10 _diagnose 返回对象', d10 && typeof d10 === 'object');
  ok('场景10 tokenPrefix 已打印', typeof d10.tokenPrefix === 'string' && d10.tokenPrefix.length > 0);
  ok('场景10 tokenIsAnon=false（不是 anon）', d10.tokenIsAnon === false);
  ok('场景10 localStorageHasAccessToken=true', d10.localStorageHasAccessToken === true);
  ok('场景10 userId=u1（从 localStorage 恢复）', d10.userId === 'u1');
  ok('场景10 listStatus 命中合法值', [200, 400, 403, 404, 500].indexOf(d10.listStatus) >= 0);

  ok('场景10 listIsBucketMissing 字段存在', typeof d10.listIsBucketMissing === 'boolean');

  // 场景11：reasonFromDiag 纯函数（把 _diagnose 输出翻译成人话，无需网络）
  ok('场景11 tokenIsAnon → 提示匿名登录态', /匿名/.test(FW.sync._reasonFromDiag({ tokenIsAnon: true })));
  // 新版 reasonFromDiag 把 listStatus + body 一并打出来，所以断言应同时命中 "HTTP 400" 与 "Bucket not found"
  var diag400 = FW.sync._reasonFromDiag({ listStatus: 400, listBodyShort: '{"error":"Bucket not found"}', tokenLen: 10 });
  ok('场景11 400+Bucket not found → 提示 HTTP400+Body', /HTTP\s*400/.test(diag400) && /Bucket not found/.test(diag400));
  ok('场景11 403+RLS → 提示 RLS', /RLS/.test(FW.sync._reasonFromDiag({ listStatus: 403, listBodyShort: '{"message":"new row violates row level security policy"}' })));
  ok('场景11 200 → 提示桶可访问', /桶可访问/.test(FW.sync._reasonFromDiag({ listStatus: 200 })));

  // 场景12（集成）：needSetup 时 toast 自动带诊断原因，用户不打开 Console 也能看到
  fakeSb.auth.getSession = function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.c' }, access_token: 'fake-token' } } }); };
  fakeSb.auth.session = function () { return { access_token: 'fake-token' }; };
  dom.window.localStorage.setItem('sb-x-auth-token', JSON.stringify({ access_token: 'LS_TOKEN_FULL', user: { id: 'u1', email: 'a@b.c' } }));
  dom.window.confirm = function () { return true; };
  delete dom.window.FW.sync;
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'));
  dom.window.FW.sync = global.FW.sync;
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise(function (r) { setTimeout(r, 30); });
  cloudError = { statusCode: 400, message: 'Bucket not found' };
  toasts.length = 0;
  await FW.sync.forcePushLocal();
  await new Promise(function (r) { setTimeout(r, 80); });
  var hit12 = toasts.find(function (t) { return /凭证图云同步未开启/.test(t) && /HTTP\s*400/.test(t) && /Bucket not found/.test(t); });
  ok('场景12 forcePushLocal needSetup 时 toast 含诊断原因(HTTP400+Body)', !!hit12);
  if (!hit12) console.log('    实际 toasts =', JSON.stringify(toasts));

  // 场景13：不开 Console 的诊断入口（FW.sync.photoDiag 应是函数；openSyncMenu 菜单 HTML 含 id="smDiag"）
  ok('场景13 FW.sync.photoDiag 是函数', typeof FW.sync.photoDiag === 'function');

  // 场景14：uploadPhoto 必须走 ?upsert=true query param（不是 x-upsert header，否则重传覆盖同名凭证图会 409）
  var captured14 = null;
  var realFetch14 = global.fetch;
  global.fetch = function (u, opts) {
    if (/\/object\/vouchers\//.test(String(u)) && opts && opts.method === 'POST') captured14 = String(u);
    return realFetch14(u, opts);
  };
  localPhotoIds = ['P_REUPLOAD'];
  photoStore['P_REUPLOAD'] = SAMPLE;
  cloudList = [];          // 云端无此图 → 触发上传
  cloudError = null;
  await FW.sync.syncPhotos({});
  await new Promise(function (r) { setTimeout(r, 30); });
  ok('场景14 重传覆盖：upload 走 ?upsert=true query param', !!captured14 && /\?upsert=true/.test(captured14));
  global.fetch = realFetch14;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');

  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) { console.error('TEST THREW:', e.stack); process.exit(2); });
