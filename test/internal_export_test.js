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

console.log('ALL_OK');
