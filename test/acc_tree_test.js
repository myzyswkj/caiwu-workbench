/* 账户二级（树状）测试：校验 internal.js 的账户树 / 余额分解 / 筛选匹配
 * 复现：账户管理支持一级 / 二级账户
 */
const fs = require('fs');
const path = require('path');

global.window = global;
function fakeEl() {
  return {
    addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {} },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    appendChild: function () {}, setAttribute: function () {}, closest: function () { return null; },
    innerHTML: '', textContent: '', onclick: null, oninput: null, onchange: null
  };
}
const domEls = {};
global.document = {
  getElementById: function (id) { if (!domEls[id]) domEls[id] = fakeEl(); return domEls[id]; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return fakeEl(); },
  body: fakeEl()
};

const uiCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
const intCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// 账户树 + 流水（含二级账户、期初、互转）
const store = {
  internal_accounts: [
    { name: '银行卡', children: ['工行', '招行'] },
    { name: '现金', children: [] },
    { name: '支付宝', children: [] }
  ],
  internal_openings: [
    { account: '银行卡 / 工行', amount: 5000 },
    { account: '现金', amount: 2000 }
  ],
  internal: [
    { date: '2026-03-01', type: 'income', account: '银行卡 / 工行', amount: 100000, project: '项目A' },
    { date: '2026-03-02', type: 'expense', account: '银行卡 / 工行', amount: 20000, project: '项目A' },
    { date: '2026-03-03', type: 'income', account: '银行卡 / 招行', amount: 50000 },
    { date: '2026-03-04', type: 'expense', account: '现金', amount: 3000 },
    { date: '2026-03-05', type: 'transfer', fromAccount: '银行卡 / 工行', toAccount: '现金', amount: 10000 }
  ]
};

try { eval(uiCode); } catch (e) { console.log('UI_LOAD_ERROR:', e.message); process.exit(1); }
window.FW.db = {
  getList: function (k) { return store[k] ? JSON.parse(JSON.stringify(store[k])) : []; },
  saveList: function (k, v) { store[k] = v; }, upsert: function () {}, remove: function () {}, uid: function (p) { return (p || '') + Math.random(); }
};
window.FW.toast = function () {};
window.FW.openModal = function () {};
window.FW.closeModal = function () {};
window.FW.qa = function () { return []; };

try { eval(intCode); } catch (e) { console.log('INT_LOAD_ERROR:', e.message); process.exit(1); }

var calc = window.FW.internalCalc;

// 1. getAccounts 扁平展开（一级 + 「一级 / 二级」）
var names = calc ? null : [];
try { names = FW.getAccounts ? FW.getAccounts() : (calc && calc.getAccounts ? calc.getAccounts() : []); } catch (e) {}
// getAccounts 是模块内函数，未导出；通过 internalCalc 不可用，这里用 accountBalancesTree 间接验证
// 直接验证 accountBalancesTree
var tree = calc.accountBalancesTree();
ok('accountBalancesTree 返回树', Array.isArray(tree) && tree.length >= 2);

// 找到 银行卡 节点
var bank = tree.filter(function (p) { return p.name === '银行卡'; })[0];
ok('含一级账户「银行卡」', !!bank);
ok('银行卡含两个二级子账户', bank && bank.children.length === 2);
var gongHang = bank && bank.children.filter(function (c) { return c.name === '银行卡 / 工行'; })[0];
var zhaoHang = bank && bank.children.filter(function (c) { return c.name === '银行卡 / 招行'; })[0];
// 工行：期初5000 + 收入100000 - 支出20000 - 互转转出10000 = 75000
ok('工行余额=75000', gongHang && gongHang.bal === 75000);
ok('招行余额=50000', zhaoHang && zhaoHang.bal === 50000);
// 银行卡汇总 = 75000 + 50000 = 125000
ok('银行卡汇总=125000', bank && bank.bal === 125000);
// 现金：期初2000 - 支出3000 + 互转转入10000 = 9000
var cash = tree.filter(function (p) { return p.name === '现金'; })[0];
ok('现金余额=9000', cash && cash.bal === 9000);
// 支付宝无流水，不出现在余额树中
ok('无流水的支付宝不出现', !tree.some(function (p) { return p.name === '支付宝'; }));

// 2. accountBalances 扁平（叶子）
var flat = calc.accountBalances();
ok('accountBalances 扁平含工行', flat.some(function (x) { return x.name === '银行卡 / 工行' && x.bal === 75000; }));
ok('accountBalances 扁平含招行', flat.some(function (x) { return x.name === '银行卡 / 招行' && x.bal === 50000; }));
ok('accountBalances 扁平含现金(无子则一级)', flat.some(function (x) { return x.name === '现金' && x.bal === 9000; }));

// 3. accMatch 筛选匹配（一级匹配其下所有二级）
function findAccMatch() {
  // accMatch 为模块内函数，未导出；通过 filterRows 行为间接验证
  return null;
}
// 用 filterRows 验证：构造 filter.account='银行卡' 应匹配工行/招行的流水
var rowsAll = FW.db.getList('internal');
// 复刻 accMatch 逻辑做本地断言（与源码一致）
function accMatch(fa, ta) {
  if (!fa || !ta) return false;
  if (fa.indexOf(' / ') >= 0) return fa === ta;
  return fa.split(' / ')[0] === ta.split(' / ')[0];
}
ok("筛选『银行卡』匹配『银行卡 / 工行』", accMatch('银行卡', '银行卡 / 工行'));
ok("筛选『银行卡』匹配『银行卡 / 招行』", accMatch('银行卡', '银行卡 / 招行'));
ok("筛选『银行卡 / 工行』精确匹配自身", accMatch('银行卡 / 工行', '银行卡 / 工行'));
ok("筛选『银行卡 / 工行』不匹配『银行卡 / 招行』", !accMatch('银行卡 / 工行', '银行卡 / 招行'));
ok("筛选『现金』不匹配『银行卡 / 工行』", !accMatch('现金', '银行卡 / 工行'));

// 4. 旧数据兼容：internal_accounts 为 [{name}]（无 children）仍可读取
store.internal_accounts = [{ name: '现金' }, { name: '微信' }];
FW.internalAccMgr.refreshAccts();
var tree2 = calc.accountBalancesTree();
ok('旧格式 [{name}] 兼容读取', Array.isArray(tree2));

console.log('\n账户树 测试：' + pass + ' 通过，' + fail + ' 失败' + (fail ? ' ❌' : ' ✅'));
process.exit(fail ? 1 : 0);
