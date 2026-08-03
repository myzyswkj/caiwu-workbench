var SEP = ' / ';
// 桩：模拟账户树只定义 LULU私户；流水/期初引用旧名 LULU账户
var TREE = [{ name: 'LULU私户', children: [] }, { name: '微信', children: [] }];
var TXNS = [
  { id: '1', type: 'income', account: 'LULU账户', amount: 100 },
  { id: '2', type: 'expense', account: 'LULU账户', amount: 30 },
  { id: '3', type: 'transfer', account: 'A → B', fromAccount: 'LULU账户', toAccount: '微信', amount: 50 },
  { id: '4', type: 'income', account: 'LULU私户', amount: 10 }
];
var OPS = [{ account: 'LULU账户', amount: 500 }];

function getAccountTree() { return TREE; }
function getOpenings() { return OPS; }
function acct1(n) { return (n || '').split(SEP)[0]; }

function scanOrphanAccounts() {
  var tree = getAccountTree(), defined = {};
  tree.forEach(function (a) { defined[a.name] = true; (a.children || []).forEach(function (c) { defined[a.name + SEP + c] = true; }); });
  var counts = {};
  function bump(n) { if (n) counts[n] = (counts[n] || 0) + 1; }
  TXNS.forEach(function (t) { if (t.type === 'transfer') { bump(t.fromAccount); bump(t.toAccount); } else bump(t.account); });
  getOpenings().forEach(function (o) { bump(o.account); });
  var orphans = [];
  Object.keys(counts).forEach(function (fn) { if (!defined[fn]) orphans.push({ name: fn, count: counts[fn] }); });
  return orphans;
}
function mergeAccount(oldName, newName) {
  TXNS.forEach(function (t) {
    if (t.account === oldName) t.account = newName;
    if (t.type === 'transfer') {
      if (t.fromAccount === oldName) t.fromAccount = newName;
      if (t.toAccount === oldName) t.toAccount = newName;
      t.account = (t.fromAccount || '') + ' → ' + (t.toAccount || '');
    }
  });
  OPS.forEach(function (o) { if (o.account === oldName) o.account = newName; });
}

var assert = require('assert');
var orphans = scanOrphanAccounts();
console.log('orphans:', JSON.stringify(orphans));
assert.deepStrictEqual(orphans.map(function (o) { return o.name; }), ['LULU账户'], '应识别到游离账户 LULU账户');
assert.strictEqual(orphans[0].count, 4, 'LULU账户应被引用 4 次(2流水+1转账from+1期初)');

mergeAccount('LULU账户', 'LULU私户');
console.log('after merge TXNS:', JSON.stringify(TXNS));
console.log('after merge OPS:', JSON.stringify(OPS));
assert.strictEqual(TXNS[0].account, 'LULU私户');
assert.strictEqual(TXNS[2].fromAccount, 'LULU私户');
assert.strictEqual(TXNS[2].account, 'LULU私户 → 微信');
assert.strictEqual(OPS[0].account, 'LULU私户');
assert.deepStrictEqual(scanOrphanAccounts(), [], '合并后不应再有游离账户');
console.log('ALL_OK');
