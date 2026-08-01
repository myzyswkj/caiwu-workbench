/* 同步合并去重测试：覆盖 db.importAll 的两种重复根因修复
 *  - 场景2：数组混有无 id 元素时，每次同步不再累积膨胀
 *  - 场景3：跨设备同笔（不同 id、内容相同）合并后只保留一条
 *  - 场景1：全部带 id 的数组，多次同步保持幂等
 *  - ledgers 等结构性数组不被内容去重误伤
 */
var store = {};
global.localStorage = {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: function (i) { return Object.keys(store)[i]; }
};
global.indexedDB = undefined;
global.window = global;
global.FW = { crypto: {}, toast: function () {} };
require('C:/Users/Administrator/WorkBuddy/2026-07-26-16-00-06/财务工作台/js/db.js');

var db = global.FW.db;
var PREFIX = 'fw_';
function setLocal(key, val) { store[PREFIX + key] = JSON.stringify(val); }
function getLocal(key) { return JSON.parse(store[PREFIX + key]); }
function sync(cloudRaw) { return db.importAll({ raw: cloudRaw, photos: [] }, true); }

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }

// 场景1：全部带 id，幂等
(function () {
  setLocal('internal_L1', [{ id: 'a', date: '2026-01-01', type: 'income', amount: 100, project: 'P' }]);
  var cloud = { internal_L1: [{ id: 'a', date: '2026-01-01', type: 'income', amount: 100, project: 'P' }, { id: 'b', date: '2026-02-01', type: 'expense', amount: 30, project: 'Q' }] };
  sync(cloud); sync(cloud); sync(cloud);
  var arr = getLocal('internal_L1');
  ok('场景1 多次同步后仍只有 2 条（幂等）', arr.length === 2);
})();

// 场景2：首元素带 id，但混有无 id 元素 —— 旧逻辑会每次 +1，新逻辑稳定
(function () {
  setLocal('mix_L1', [{ id: 'a1', v: 1 }, { account: '现金', amount: 200 }]);
  var cloud = { mix_L1: [{ id: 'a1', v: 1 }, { account: '现金', amount: 200 }] };
  sync(cloud); sync(cloud); sync(cloud);
  var arr = getLocal('mix_L1');
  ok('场景2 多次同步后无 id 元素不再累积（len=2）', arr.length === 2);
})();

// 场景3：跨设备同笔（不同 id，内容相同）合并后只留一条
(function () {
  setLocal('internal_L1', [{ id: 'PC_1', date: '2026-03-01', type: 'income', amount: 500, project: 'X', remark: '货款' }]);
  var cloud = { internal_L1: [{ id: 'PHONE_1', date: '2026-03-01', type: 'income', amount: 500, project: 'X', remark: '货款' }] };
  sync(cloud); sync(cloud); sync(cloud);
  var arr = getLocal('internal_L1');
  ok('场景3 跨设备同笔合并后只保留 1 条', arr.length === 1);
})();

// 场景3b：内容不同的两条不同 id 记录，应都保留（不能误删）
(function () {
  setLocal('internal_L1', [{ id: 'x1', date: '2026-04-01', type: 'expense', amount: 100, project: 'A', remark: 'r1' }]);
  var cloud = { internal_L1: [{ id: 'x2', date: '2026-04-01', type: 'expense', amount: 100, project: 'A', remark: 'r2' }] };
  sync(cloud);
  var arr = getLocal('internal_L1');
  ok('场景3b 内容不同的记录都保留（2 条）', arr.length === 2);
})();

// ledgers 结构性数组：同名不同 id 不应被内容去重（保留两条独立账本）
(function () {
  setLocal('ledgers', [{ id: 'L1', name: '默认账本' }, { id: 'L2', name: '默认账本' }]);
  var cloud = { ledgers: [{ id: 'L1', name: '默认账本' }, { id: 'L2', name: '默认账本' }] };
  sync(cloud);
  var arr = getLocal('ledgers');
  ok('ledgers 不被内容去重误伤（仍为 2 条独立账本）', arr.length === 2);
})();

// contentKey / dedupeByContent 工具可用
(function () {
  var dup = [{ id: '1', date: '2026-05-01', type: 'income', amount: 10 }, { id: '2', date: '2026-05-01', type: 'income', amount: 10 }];
  var out = db.dedupeByContent(dup);
  ok('dedupeByContent 移除内容重复（2→1）', out.length === 1);
  ok('contentKey 忽略 id 等易变字段', db.contentKey({ id: '1', date: '2026-05-01' }) === db.contentKey({ id: '2', date: '2026-05-01' }));
})();

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
