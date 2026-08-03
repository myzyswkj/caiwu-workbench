// 凭证图片归位逻辑锁（与 internal.js renderVouchers 的口径一致）
// 打印视图把凭证图片填进「每笔流水所在行右侧的凭证列」，按 rows 下标定位单元格，
// 而不是按 t.id 分组——这样流水缺少 id 时也不会串行。纯逻辑副本，锁定行为避免回归。
var assert = require('assert');

// 取图任务：跳过空 pid，记录所属行下标
function collectTasks(rows) {
  var tasks = [];
  rows.forEach(function (t, i) {
    (t.photos || []).forEach(function (pid) {
      if (!pid) return;
      tasks.push({ i: i, pid: pid });
    });
  });
  return tasks;
}

// 渲染层聚合：按行下标把图片塞进对应单元格，取图失败/为空的跳过
function groupByIndex(fetched) {
  var byIdx = {};
  fetched.forEach(function (r) {
    if (!r || !r.d) return;
    if (!byIdx[r.i]) byIdx[r.i] = [];
    byIdx[r.i].push(r.d);
  });
  return byIdx;
}

var r0 = { id: 't1', date: '2026-01-01', type: 'expense', amount: 100, photos: ['p1', 'p2'] };
var r1 = { id: 't2', date: '2026-01-02', type: 'income', amount: 200, photos: [] };      // 无凭证
var r2 = { id: 't3', date: '2026-01-03', type: 'expense', amount: 50, photos: ['p3', '', null] }; // 含空 pid
var r3 = { id: 't4', date: '2026-01-04', type: 'transfer', amount: 10 };                 // 无 photos 字段
var r4 = { date: '2026-01-05', type: 'expense', amount: 80, photos: ['p4'] };            // 无 id（关键回归点）

var tasks = collectTasks([r0, r1, r2, r3, r4]);
assert.strictEqual(tasks.length, 4, '只有非空 pid 进入取图任务（p1、p2、p3、p4）');
assert.deepStrictEqual(tasks.map(function (x) { return x.i; }), [0, 0, 2, 4], '任务携带正确的行下标');
assert.deepStrictEqual(tasks.map(function (x) { return x.pid; }), ['p1', 'p2', 'p3', 'p4'], '空 pid（\'\'/null）被跳过');

// 聚合：t3 取图为空、一个任务彻底失败(null)，都应跳过；无 id 的 r4 仍能按下标归位
var byIdx = groupByIndex([
  { i: 0, d: 'DATA1' },
  { i: 0, d: 'DATA2' },
  { i: 2, d: '' },   // 取图为空
  null,              // 取图失败
  { i: 4, d: 'DATA4' }
]);
assert.deepStrictEqual(Object.keys(byIdx).sort(), ['0', '4'], '只有第 0、4 行拿到有效图片');
assert.deepStrictEqual(byIdx[0], ['DATA1', 'DATA2'], '第 0 行两张图按顺序聚合');
assert.deepStrictEqual(byIdx[4], ['DATA4'], '无 id 的流水也能按下标正确归位，不会串到别的行');
assert.strictEqual(byIdx[2], undefined, '取图为空的行不产生图片，渲染层回退为「—」');

console.log('ALL_OK');
