/* 凭证图云同步（Supabase Storage）回归测试 —— 严格断言版（失败即中断） */
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
// 测试沙箱里 jsdom/Node 的 atob 比浏览器原生更严格，会拒绝合法 base64 而抛错，
// 导致 dataUrlToBlob 失败、上传分支不触发。用 Node Buffer 解码器替换，仅影响测试环境。
// 生产环境用浏览器原生 atob（真实凭证图 dataUrl 均合法）。
global.atob = function (s) { return Buffer.from(String(s), 'base64').toString('binary'); };
global.btoa = function (s) { return Buffer.from(String(s), 'binary').toString('base64'); };
global.Blob = dom.window.Blob || global.Blob;
global.FileReader = dom.window.FileReader;
global.confirm = function () { return true; };

// 合法 base64（长度须为 4 的倍数，否则 atob 会抛错导致上传分支不触发）
var SAMPLE = 'data:image/png;base64,iVBORw0KGgo=';

var cloudList = [];
var cloudError = null;
var uploadError = null;
var calls = { list: 0, upload: 0, download: 0, remove: 0 };
var photoStore = {};
var localPhotoIds = [];

function chain() {
  var o = {};
  o.select = function () { return o; };
  o.eq = function () { return o; };
  o.order = function () { return o; };
  o.maybeSingle = function () { return Promise.resolve({ data: null, error: { code: 'PGRST116' } }); };
  o.single = function () { return o; };
  return o;
}
var snapshotStub = chain();
var fakeStorage = {
  from: function () {
    return {
      list: function () { calls.list++; return Promise.resolve({ data: cloudList, error: cloudError }); },
      upload: function (key, blob) { calls.upload++; if (uploadError) return Promise.resolve({ error: uploadError }); return Promise.resolve({ data: { key: key }, error: null }); },
      download: function () { calls.download++; if (cloudError) return Promise.resolve({ data: null, error: cloudError }); return Promise.resolve({ data: new dom.window.Blob(['x']), error: null }); },
      remove: function () { calls.remove++; return Promise.resolve({ data: [], error: null }); }
    };
  }
};
var fakeSb = {
  storage: function () { return fakeStorage; },
  from: function () { return snapshotStub; },
  auth: { getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.c' } } } }); }, onAuthStateChange: function () {}, signOut: function () { return Promise.resolve(); } }
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

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'));
// 确保 init 已执行（挂上 sb client，使 storageReady 为 true）
if (global.FW.sync.init) global.FW.sync.init();

function reset() { calls = { list: 0, upload: 0, download: 0, remove: 0 }; cloudError = null; uploadError = null; photoStore = {}; localPhotoIds = []; toasts = []; }
var pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); }

(async function () {
  await new Promise(function (r) { setTimeout(r, 20); });
  ok('syncPhotos 已导出', typeof global.FW.sync.syncPhotos === 'function');

  // 场景1：桶未建 → needSetup，不触发任何传输
  reset();
  cloudError = { statusCode: 404, message: 'Bucket not found', error: 'NoSuchBucket' };
  var r1 = await global.FW.sync.syncPhotos();
  ok('场景1 桶未建返回 needSetup', r1 && r1.needSetup === true);
  ok('场景1 未触发任何上传/下载/删除', calls.upload === 0 && calls.download === 0 && calls.remove === 0);

  // 场景2：双向合并（默认，非 mirror）—— 上传本地独有(L1,L2)、下载云端独有(C1,C2)，不删
  reset();
  localPhotoIds = ['L1', 'L2'];
  photoStore = { L1: SAMPLE, L2: SAMPLE };
  cloudList = [{ name: 'C1' }, { name: 'C2' }];
  var r2 = await global.FW.sync.syncPhotos();
  ok('场景2 上传本地缺失(L1,L2)=2', calls.upload === 2);
  ok('场景2 下载云端缺失(C1,C2)=2', calls.download === 2);
  ok('场景2 合并模式不清理云端', calls.remove === 0);
  ok('场景2 本地已补齐 C1/C2', !!photoStore.C1 && !!photoStore.C2);
  ok('场景2 结果含 up/dl 计数', r2 && r2.up === 2 && r2.dl === 2 && !('del' in r2));

  // 场景3：上传失败不抛错，且仍尝试了上传
  reset();
  localPhotoIds = ['L1'];
  photoStore = { L1: SAMPLE };
  cloudList = [];
  uploadError = { message: 'network fail' };
  var r3 = await global.FW.sync.syncPhotos();
  ok('场景3 上传失败不抛错', r3 && !r3.error);
  ok('场景3 仍尝试了上传', calls.upload === 1);

  // 场景4：已对齐无需传输
  reset();
  localPhotoIds = ['X1'];
  photoStore = { X1: SAMPLE };
  cloudList = [{ name: 'X1' }];
  var r4 = await global.FW.sync.syncPhotos();
  ok('场景4 已对齐无需传输', calls.upload === 0 && calls.download === 0 && calls.remove === 0);

  // 场景5：mirror 模式（本机为准覆盖云端）—— 上传本地独有、删除云端独有、不下载
  reset();
  localPhotoIds = ['L1'];
  photoStore = { L1: SAMPLE };
  cloudList = [{ name: 'C1' }, { name: 'C2' }];
  var r5 = await global.FW.sync.syncPhotos({ mirror: true });
  ok('场景5 mirror 上传本地独有(L1)=1', calls.upload === 1);
  ok('场景5 mirror 不下载云端独有', calls.download === 0);
  ok('场景5 mirror 清理云端独有(C1,C2)=2', calls.remove === 2);
  ok('场景5 结果含 del 计数', r5 && r5.up === 1 && r5.dl === 0 && r5.del === 2);

  console.log('\nALL_OK photo_sync_test (' + pass + ' passed)');
})().catch(function (e) {
  console.error('\nFAIL photo_sync_test:', e && e.message || e);
  process.exit(1);
});
