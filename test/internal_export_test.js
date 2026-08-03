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

console.log('ALL_OK');
