// 凭证图片按流水分组逻辑锁（与 internal.js renderVouchers 的分组口径一致）
// 纯逻辑副本，用于在 Node 环境锁定行为，避免回归。
var assert = require('assert');

// 将每笔流水关联的凭证照片按流水分组（与导出 PDF 一致）
// - 跳过无 photos 的流水
// - 同一笔流水的多张照片归到一组，按 t.id 聚合
// - 缺失照片（res 为空）在渲染层跳过，这里只验证分组结构
function groupVouchersByTx(rows) {
  var out = [];
  rows.forEach(function (t) {
    var pids = (t.photos || []).filter(Boolean);
    if (pids.length) out.push({ t: t, pids: pids });
  });
  return out;
}

var r1 = { id: 't1', date: '2026-01-01', type: 'expense', amount: 100, photos: ['p1', 'p2'] };
var r2 = { id: 't2', date: '2026-01-02', type: 'income', amount: 200, photos: [] }; // 无凭证
var r3 = { id: 't3', date: '2026-01-03', type: 'expense', amount: 50, photos: ['p3', '', null] }; // 含空 pid
var r4 = { id: 't4', date: '2026-01-04', type: 'transfer', amount: 10 }; // 无 photos 字段

var g = groupVouchersByTx([r1, r2, r3, r4]);
assert.strictEqual(g.length, 2, '只有带凭证的流水进入分组（t1、t3）');
assert.strictEqual(g[0].t.id, 't1', '第一组为 t1');
assert.deepStrictEqual(g[0].pids, ['p1', 'p2'], 't1 两张凭证都在');
assert.strictEqual(g[1].t.id, 't3', '第二组为 t3');
assert.deepStrictEqual(g[1].pids, ['p3'], 't3 的空 pid（\'\'/null）在分组时被 filter(Boolean) 过滤');

// 渲染层的聚合：按 t.id 把图片塞进对应组，缺失图跳过
var fetched = [
  { t: r1, d: 'DATA1' },
  { t: r1, d: 'DATA2' },
  { t: r3, d: '' },        // 缺失
  null                      // 取图失败
];
var byTx = {};
fetched.forEach(function (r) {
  if (!r || !r.d) return;
  if (!byTx[r.t.id]) byTx[r.t.id] = { t: r.t, imgs: [] };
  byTx[r.t.id].imgs.push(r.d);
});
assert.strictEqual(Object.keys(byTx).length, 1, '只有 t1 有有效图片（t3 缺失、null 跳过）');
assert.deepStrictEqual(byTx['t1'].imgs, ['DATA1', 'DATA2'], 't1 两张图聚合正确');

console.log('ALL_OK');
