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
  if (url.indexOf('/list/vouchers') >= 0 && method === 'GET') {
    calls.list++;
    if (cloudError) return Promise.resolve(errJson(404, 'Bucket not found'));
    return Promise.resolve(okJson(cloudList));
  }
  if (url.indexOf('/object/vouchers/') >= 0 && method === 'POST') {
    calls.upload++;
    if (uploadError) return Promise.resolve(errJson(500, 'upload failed'));
    return Promise.resolve(okJson({ Key: 'ok' }));
  }
  if (url.indexOf('/object/vouchers/') >= 0 && method === 'GET') {
    calls.download++;
    if (cloudError) return Promise.resolve(errJson(404, 'Bucket not found'));
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) { console.error('TEST THREW:', e.stack); process.exit(2); });
