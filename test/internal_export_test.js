// 内账流水导出/打印：锁定「收正支负」口径约定，防止给老板看的明细表符号搞反
'use strict';
var assert = require('assert');

// 与 internal.js 中 exportXLSX / openPrintView 一致的收支配比约定
function signed(t) {
  var a = Number(t.amount) || 0;
  if (t.type === 'income' || t.type === 'refund' || (t.type === 'equity' && t.equityDir === 'in')) return +a;
  if (t.type === 'expense' || (t.type === 'equity' && t.equityDir === 'out')) return -a;
  return 0; // 账户互转净额 0
}

// 类型标签（typeLabel）
function typeLabel(t) {
  if (t.type === 'income') return '收入';
  if (t.type === 'expense') return '支出';
  if (t.type === 'refund') return '退款收入';
  if (t.type === 'transfer') return '账户互转';
  if (t.type === 'equity') return (t.equityDir === 'out' ? '股本抽回' : '股本注入');
  return t.type || '';
}

// 1. 收入/退款/股本注入为正
assert.strictEqual(signed({ type: 'income', amount: 100 }), 100, '收入为正');
assert.strictEqual(signed({ type: 'refund', amount: 50 }), 50, '退款为正');
assert.strictEqual(signed({ type: 'equity', equityDir: 'in', amount: 200 }), 200, '股本注入为正');

// 2. 支出/股本抽回为负
assert.strictEqual(signed({ type: 'expense', amount: 80 }), -80, '支出为负');
assert.strictEqual(signed({ type: 'equity', equityDir: 'out', amount: 200 }), -200, '股本抽回为负');

// 3. 账户互转净额为 0（不影响收支）
assert.strictEqual(signed({ type: 'transfer', amount: 300 }), 0, '互转净额0');

// 4. 标签正确
assert.strictEqual(typeLabel({ type: 'income' }), '收入');
assert.strictEqual(typeLabel({ type: 'refund' }), '退款收入');
assert.strictEqual(typeLabel({ type: 'equity', equityDir: 'out' }), '股本抽回');
assert.strictEqual(typeLabel({ type: 'transfer' }), '账户互转');

// ===== buildAccMap：按账户汇总（与统计 tab groupSum 一致） =====
// 只算 income/expense/refund；transfer/equity 不计；refund 抵减支出
function buildAccMap(rows) {
  var map = {};
  rows.forEach(function (t) {
    if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'refund') return;
    var k = t.account || '其他';
    if (!map[k]) map[k] = { income: 0, expense: 0 };
    var a = Number(t.amount) || 0;
    if (t.type === 'income') map[k].income += a;
    else if (t.type === 'expense') map[k].expense += a;
    else if (t.type === 'refund') map[k].expense -= a;
  });
  return map;
}

var acc = buildAccMap([
  { type: 'income',  account: 'LULU私户', amount: 200000 },
  { type: 'expense', account: 'LULU私户', amount: 162284.14 },
  { type: 'refund',  account: 'LULU私户', amount: 5000 },
  { type: 'income',  account: '公户',     amount: 49230.37 },
  { type: 'transfer', account: 'LULU私户', amount: 9999 } // 互转不计
]);
assert.strictEqual(acc['LULU私户'].income, 200000, 'LULU私户 收入 = 200,000');
assert.strictEqual(acc['LULU私户'].expense.toFixed(2), (162284.14 - 5000).toFixed(2), 'LULU私户 支出 = 支出 - 退款');
assert.strictEqual(acc['公户'].income, 49230.37, '公户 收入 = 49,230.37');
assert.strictEqual(acc['公户'].expense, 0, '公户 无支出');
assert.strictEqual(Object.keys(acc).length, 2, '互转不产生新账户');
// 净额与老板视觉一致
assert.strictEqual((acc['LULU私户'].income - acc['LULU私户'].expense).toFixed(2), (200000 - 162284.14 + 5000).toFixed(2), 'LULU私户 净额 = 收入 - (支出 - 退款)');

// ===== prevDay：日期减一天（YYYY-MM-DD） =====
function prevDay(d) {
  if (!d) return '';
  var dt = new Date(d + 'T00:00:00');
  dt.setDate(dt.getDate() - 1);
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}
assert.strictEqual(prevDay('2026-08-03'), '2026-08-02', '普通日减一');
assert.strictEqual(prevDay('2026-08-01'), '2026-07-31', '月初减一跨月');
assert.strictEqual(prevDay('2026-01-01'), '2025-12-31', '年初减一跨年');
assert.strictEqual(prevDay('2026-03-01'), '2026-02-28', '平年2月末');
assert.strictEqual(prevDay('2024-03-01'), '2024-02-29', '闰年2月末');
assert.strictEqual(prevDay(''), '', '空日期返回空');

// ===== 余额恒等式：剩余余额 − 开始余额 = 收入 − 支出 + 退款 + 互转净 + 股本净 =====
// 与 accountBreakdown 的余额模型一致（bal = opening + flow + move）
function balanceOf(rows, openings) {
  var open = {}, flow = {}, move = {};
  openings.forEach(function (o) { if (o.account) open[o.account] = (open[o.account] || 0) + Number(o.amount || 0); });
  rows.forEach(function (t) {
    var a = Number(t.amount) || 0;
    if (t.type === 'income') flow[t.account] = (flow[t.account] || 0) + a;
    else if (t.type === 'expense') flow[t.account] = (flow[t.account] || 0) - a;
    else if (t.type === 'refund') flow[t.account] = (flow[t.account] || 0) + a;
    else if (t.type === 'transfer') {
      if (t.fromAccount) move[t.fromAccount] = (move[t.fromAccount] || 0) - a;
      if (t.toAccount) move[t.toAccount] = (move[t.toAccount] || 0) + a;
    } else if (t.type === 'equity') {
      var s = t.equityDir === 'out' ? -1 : 1;
      if (t.account) move[t.account] = (move[t.account] || 0) + s * a;
    }
  });
  var names = {};
  Object.keys(open).concat(Object.keys(flow)).concat(Object.keys(move)).forEach(function (k) { names[k] = 1; });
  var out = {};
  Object.keys(names).forEach(function (k) { out[k] = (open[k] || 0) + (flow[k] || 0) + (move[k] || 0); });
  return out;
}
var openings = [{ account: 'A', amount: 1000 }, { account: 'B', amount: 500 }];
var sample = [
  { type: 'income',  account: 'A', amount: 300 },
  { type: 'expense', account: 'A', amount: 120 },
  { type: 'refund',  account: 'A', amount: 20 },
  { type: 'transfer', fromAccount: 'A', toAccount: 'B', amount: 50 },
  { type: 'equity',  account: 'B', equityDir: 'in', amount: 200 }
];
var endBal = balanceOf(sample, openings);
var startBal = {}; openings.forEach(function (o) { startBal[o.account] = Number(o.amount || 0); }); // 无 from 时取期初
Object.keys(endBal).forEach(function (k) {
  var inc = 0, exp = 0, rf = 0;
  sample.forEach(function (t) {
    if (t.account !== k) { if (t.type === 'transfer' && t.fromAccount === k) exp += Number(t.amount); if (t.type === 'transfer' && t.toAccount === k) inc += Number(t.amount); return; }
    if (t.type === 'income') inc += Number(t.amount);
    else if (t.type === 'expense') exp += Number(t.amount);
    else if (t.type === 'refund') inc += Number(t.amount);
  });
  var eq = 0;
  sample.forEach(function (t) { if (t.type === 'equity' && t.account === k) eq += Number(t.amount) * (t.equityDir === 'out' ? -1 : 1); });
  var delta = inc - exp + eq;
  assert.strictEqual((endBal[k] - (startBal[k] || 0)).toFixed(2), delta.toFixed(2), '账户 ' + k + ' 剩余−开始 = 收入−支出+股本净（含互转）');
});
assert.strictEqual((endBal['A'] - 1000).toFixed(2), (300 - 120 + 20 - 50).toFixed(2), 'A 账户余额变动 = 收入300−支出120+退款20−转给B50');
assert.strictEqual((endBal['B'] - 500).toFixed(2), (50 + 200).toFixed(2), 'B 账户余额变动 = 收到A转50+股本注入200');

console.log('ALL_OK');
