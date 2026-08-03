// 验证 internal.js 中账户筛选修复：局部变量不再遮蔽 accMatch 函数
var assert = require('assert');

var SEP = ' / ';
function acct1(n) { return (n || '').split(SEP)[0]; }

// 取自 internal.js 的 accMatch（修复后与测试一致）
function accMatch(fa, ta) {
  if (!fa || !ta) return false;
  if (fa.indexOf(SEP) >= 0) return fa === ta;
  return acct1(fa) === acct1(ta);
}

// 取自 internal.js filterRows 的账户分支（修复后：局部变量改名 matched，不再遮蔽函数）
function filterByAccount(rows, account) {
  return rows.filter(function (t) {
    if (account) {
      var matched = (t.type === 'transfer')
        ? (accMatch(account, t.fromAccount) || accMatch(account, t.toAccount))
        : accMatch(account, t.account);
      if (!matched) return false;
    }
    return true;
  });
}

var ROWS = [
  { id: '1', type: 'income', account: '银行卡 / 工行' },
  { id: '2', type: 'expense', account: '银行卡 / 招行' },
  { id: '3', type: 'transfer', fromAccount: '银行卡 / 工行', toAccount: '微信', account: '银行卡 / 工行 → 微信' },
  { id: '4', type: 'income', account: '现金' }
];

// 1) 选一级账户「银行卡」→ 匹配 工行、招行、互转(from=工行)，不匹配 现金
var r1 = filterByAccount(ROWS, '银行卡');
assert.strictEqual(r1.length, 3, '选一级「银行卡」应命中 3 条，实际 ' + r1.length);

// 2) 选二级账户「银行卡 / 工行」→ 匹配 收入(工行) + 互转(from=工行)，不匹配 招行/现金
var r2 = filterByAccount(ROWS, '银行卡 / 工行');
assert.strictEqual(r2.length, 2, '选二级「银行卡 / 工行」应命中 2 条，实际 ' + r2.length);
assert.ok(r2.every(function (t) { return t.id === '1' || t.id === '3'; }), '命中项应为 1 和 3');

// 3) 选「现金」→ 只命中 id=4
var r3 = filterByAccount(ROWS, '现金');
assert.strictEqual(r3.length, 1, '选「现金」应命中 1 条');
assert.strictEqual(r3[0].id, '4');

// 4) 不筛选（空）→ 全部 4 条
var r4 = filterByAccount(ROWS, '');
assert.strictEqual(r4.length, 4, '空账户筛选应返回全部');

console.log('ACCOUNT_FILTER_OK');
