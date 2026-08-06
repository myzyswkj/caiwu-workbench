// 回归测试：云端同步合并策略 = 本地优先（local-wins）
// 验证：importAll(snap, true) 在双向合并时
//   1) 保留本机已修改的同 id 流水（不被云端旧值覆盖）
//   2) 仍补充云端独有（本机没有的 id）的流水
//   3) 覆盖式导入 importAll(snap, false) 仍整行覆盖（"以云端为准覆盖本机"按钮依赖此语义）
// 同时断言 sync.js 推送超时已从 15s 提升到 45s + 重试（修"本机覆盖云端"超时失败）。
//
// 关键：云端快照的 key 必须是 db.js 真实使用的命名空间 key（internal_<账本ID>），
// 与 exportAll() 导出的 raw 键一致；用裸 'internal' 会读错 key，无法真正测到合并逻辑。
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
global.localStorage = (function () {
  var s = {}; return {
    getItem: function (k) { return k in s ? s[k] : null; },
    setItem: function (k, v) { s[k] = String(v); },
    removeItem: function (k) { delete s[k]; },
    clear: function () { s = {}; },
    get length() { return Object.keys(s).length; },
    key: function (i) { return Object.keys(s)[i] || null; }
  };
})();

// 最小 FW 桩（db.js 仅依赖 cryptoEnabled/isUnlocked，本测试走非加密模式）
global.FW = global.window.FW = { cryptoEnabled: function () { return false; }, isUnlocked: function () { return false; } };

// 加载真实 db.js
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));

// 用真实 upsert 写入本地种子（与运行时一致，落到命名空间 key）
FW.db.upsert('internal', { id: 'a1', date: '2026-08-01', type: 'expense', project: '用户本地改过的项目', amount: 50 });
FW.db.upsert('internal', { id: 'a2', date: '2026-08-02', type: 'income', project: '红包', amount: 100 });

// 动态取得真实命名空间 key（exportAll 导出的 raw 键即 importAll 用的 key）
FW.db.exportAll().then(function (snapSeed) {
  var KEY = null;
  Object.keys(snapSeed.raw).forEach(function (k) { if (k.indexOf('internal') === 0) KEY = k; });
  assert.ok(KEY, '应能找到 internal 命名空间 key（而非裸 internal）');
  assert.notStrictEqual(KEY, 'internal', '命名空间 key 不应是裸 internal');

  // 云端快照：a1 是旧值（project 不同），a3 是云端独有
  var cloudSnap = { raw: {}, photos: [] };
  cloudSnap.raw[KEY] = [
    { id: 'a1', date: '2026-08-01', type: 'expense', project: '云端旧项目', amount: 50 },
    { id: 'a3', date: '2026-08-03', type: 'expense', project: '云端独有', amount: 20 }
  ];

  // 1) 双向合并：应保留本地 a1 的新值，并补充云端独有 a3
  return FW.db.importAll(cloudSnap, true).then(function () {
    var after = FW.db.getList('internal');
    var map = {}; after.forEach(function (t) { map[t.id] = t; });

    assert.strictEqual(after.length, 3, '[local-wins] 合并后共 3 条（a1/a2/a3）');
    assert.strictEqual(map['a1'].project, '用户本地改过的项目', '[local-wins] 本地修改的 a1 未被云端旧值覆盖');
    assert.strictEqual(map['a2'].project, '红包', '[local-wins] 本地未动的 a2 保留');
    assert.ok(map['a3'] && map['a3'].project === '云端独有', '[local-wins] 云端独有的 a3 被补充进来');

    // 2) 覆盖式导入：应整行覆盖（本地独有 a2 被清，a1 变云端旧值）
    var cloudSnap2 = { raw: {}, photos: [] };
    cloudSnap2.raw[KEY] = [
      { id: 'a1', date: '2026-08-01', type: 'expense', project: '云端旧项目', amount: 50 }
    ];
    return FW.db.importAll(cloudSnap2, false).then(function () {
      var after2 = FW.db.getList('internal');
      assert.strictEqual(after2.length, 1, '[覆盖式] 仅剩云端有的 1 条，本地独有被清（符合"以云端为准覆盖本机"语义）');
      assert.strictEqual(after2[0].project, '云端旧项目', '[覆盖式] a1 被云端值覆盖');

      // 3) sync.js 推送超时必须 >= 45s（修"本机覆盖云端"超时失败）
      var syncSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');
      assert.ok(/withTimeout\([\s\S]*?45000/.test(syncSrc), 'sync.js 推送超时已提升到 45s（不再用 15000）');
      assert.ok(/最多重试 3 次|attempt >= 3/.test(syncSrc), 'sync.js push 已加入最多 3 次重试');
      assert.ok(/本地改动已保留/.test(syncSrc), 'sync.js syncNow 在推送失败时如实提示本地改动已保留');

      console.log('云端同步合并策略回归测试：全部断言通过 ✅');
    });
  });
}).catch(function (e) {
  console.error('测试失败:', e && e.message);
  process.exit(1);
});
