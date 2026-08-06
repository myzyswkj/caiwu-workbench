/* 回归测试：云端同步快照不再携带凭证图（避免 POST 大体积超时/失败）
 * - exportSyncSnapshot() 返回的对象不含 photos 字段（即使本地有凭证图）
 * - 该精简快照仍可被 importAll 正常还原业务数据（local-wins 合并）
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('./setup').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.TextDecoder = dom.window.TextDecoder;
global.confirm = function () { return true; };
// localStorage 桩需提供 length/key 供 scanLocalRaw 遍历
global.localStorage = (function () {
  var s = {};
  return {
    getItem: function (k) { return k in s ? s[k] : null; },
    setItem: function (k, v) { s[k] = String(v); },
    removeItem: function (k) { delete s[k]; },
    clear: function () { s = {}; },
    get length() { return Object.keys(s).length; },
    key: function (i) { return Object.keys(s)[i] || null; }
  };
})();
global.FW = global.window.FW = { cryptoEnabled: function () { return false; }, isUnlocked: function () { return false; } };

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));

var pass = 0;
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name);
  pass++;
  console.log('  ✓ ' + name);
}

// 1) exportSyncSnapshot 不含 photos 字段（即使本地存在凭证图，getAllPhotos 也不会进同步快照）
FW.db.upsert('internal', { id: 't1', date: '2026-08-01', type: 'expense', project: '测试', amount: 100 });
FW.db.putPhotoById('p1', 'data:image/png;base64,AAAA'); // 模拟本地有凭证图
FW.db.exportSyncSnapshot().then(function (snap) {
  ok('exportSyncSnapshot 不携带 photos 字段（体积可控）', !('photos' in snap));
  ok('exportSyncSnapshot 仍含业务 raw', snap && snap.raw && Object.keys(snap.raw).length > 0);

  // 2) 精简快照能被 importAll 正常还原（local-wins 合并，不丢本地改动）
  var keep = FW.db.getList('internal').map(function (t) { return t.id; });
  var cloudSnap = { raw: {}, photos: [] };
  var KEY = Object.keys(snap.raw)[0]; // 真实命名空间 key
  cloudSnap.raw[KEY] = [{ id: 't1', date: '2026-08-01', type: 'expense', project: '云端旧值', amount: 100 }, { id: 't2', project: '云端独有', amount: 50 }];
  return FW.db.importAll(cloudSnap, true).then(function () {
    var after = FW.db.getList('internal');
    ok('本地 t1 的改动被保留（local-wins）', after.some(function (t) { return t.id === 't1' && t.project === '测试'; }));
    ok('云端独有 t2 被补入', after.some(function (t) { return t.id === 't2'; }));
    console.log('\nALL_OK sync_snapshot_test (' + pass + ' assertions)');
  });
}).catch(function (e) {
  console.error('TEST ERROR:', e && e.stack || e);
  process.exit(1);
});
