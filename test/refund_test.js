/* 退款收入（type='refund'）测试
 * 核心规则：退款收入「不影响总收入」，但「冲减流水支出」（资金层作为收款增加账户余额）。
 * 覆盖：内账 netProfit / 账户余额自洽、项目核算流水成本、报表中心总收入与成本。
 */
const fs = require('fs');
const path = require('path');

global.window = global;
function fakeEl() {
  return {
    addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {} },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    appendChild: function () {}, setAttribute: function () {}, innerHTML: '', textContent: ''
  };
}
global.document = {
  getElementById: function () { return fakeEl(); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return fakeEl(); }
};
const store = {};
global.FW = {
  db: {
    getList: function (k) { return store[k] || []; },
    saveList: function (k, v) { store[k] = v; return true; },
    upsert: function (k, item) { var a = store[k] || []; var i = a.findIndex(function (x) { return x.id === item.id; }); if (i >= 0) a[i] = item; else a.push(item); store[k] = a; return item; },
    remove: function (k, id) { store[k] = (store[k] || []).filter(function (x) { return x.id !== id; }); },
    uid: function (p) { return (p || '') + Math.random().toString(36).slice(2); }
  },
  esc: function (s) { return String(s == null ? '' : s); },
  fmtMoney: function (n) { return (Number(n) || 0).toFixed(2); },
  qa: function () { return []; },
  toast: function () {},
  openModal: function () {},
  closeModal: function () {},
  today: function () { return '2026-08-01'; }
};

function load(p) { return fs.readFileSync(path.join(__dirname, '..', 'js', p), 'utf8'); }
eval(load('ui.js'));
eval(load('internal.js'));
eval(load('project_cost.js'));
eval(load('reports.js'));

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function approx(a, b) { return Math.abs(a - b) < 0.001; }

function setInternal(rows) { store['internal'] = rows; store['salary_records'] = []; store['contacts'] = []; }

console.log('— 内账口径：退款收入不影响总收入，冲减支出，资金层自洽 —');
setInternal([
  { id: '1', date: '2026-01-05', type: 'income', account: '微信', project: '项目A', amount: 100, category: '其他收入' },
  { id: '2', date: '2026-02-05', type: 'expense', account: '微信', project: '项目A', amount: 60, category: '材料采购' },
  { id: '3', date: '2026-03-05', type: 'refund', account: '微信', project: '项目A', amount: 10, category: '材料采购' },
  { id: '4', date: '2026-01-10', type: 'equity', account: '微信', equityDir: 'in', amount: 30, category: '' }
]);
// 经营结余 = 收入 - 支出 + 退款 = 100 - 60 + 10 = 50
ok('netProfit 含退款（冲减支出）= 50', approx(FW.internalCalc.netProfit('', ''), 50));
// 账户余额：flow = +100 -60 +10 = 50；move(股本) = +30 → 余额 80
var bd = FW.internalCalc.accountBreakdown('');
var wechat = bd.filter(function (x) { return x.name === '微信'; })[0];
ok('账户余额 flow = 收入 - 支出 + 退款 = 50', wechat && approx(wechat.flow, 50));
ok('账户余额含股本 move = 30', wechat && approx(wechat.move, 30));
ok('账户余额 bal = 80', wechat && approx(wechat.bal, 80));
// 对账平衡不变式：资金总计 = 期初 + 累计结余 + 股本净
var cashTotal = bd.reduce(function (s, x) { return s + x.bal; }, 0);
var balanced = Math.abs(cashTotal - (FW.internalCalc.openingsTotal() + FW.internalCalc.netProfit('', '') + FW.internalCalc.equityNet('', ''))) < 0.005;
ok('对账平衡不变式成立（含退款）', balanced);
// 仅有退款、无收入无支出：退款作为收回 → 结余为正、余额为正，但不计入收入
setInternal([
  { id: 'r1', date: '2026-04-01', type: 'refund', account: '微信', amount: 100, category: '材料采购' }
]);
ok('仅退款时 netProfit = 100（视为收回，不计入收入也不算支出）', approx(FW.internalCalc.netProfit('', ''), 100));
var bd2 = FW.internalCalc.accountBreakdown('');
ok('仅退款时账户余额 = 100（资金层收款）', approx(bd2.reduce(function (s, x) { return s + x.bal; }, 0), 100));

console.log('— 项目核算：退款收入冲减流水成本，不计入收入 —');
setInternal([
  { id: 'p1', date: '2026-03-01', type: 'income', project: '项目X', amount: 100000, category: '其他收入' },
  { id: 'p2', date: '2026-04-01', type: 'expense', project: '项目X', amount: 30000, category: '材料采购' },
  { id: 'p3', date: '2026-05-01', type: 'refund', project: '项目X', amount: 5000, category: '材料采购' }
]);
store['salary_records'] = [
  { id: 's1', empId: 'e1', year: 2026, month: 1, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目X', amount: 20000 }], bonusItems: [], commissionItems: [] }
];
var rows = FW.projectCostCalc.compute('all').rows;
var x = rows.filter(function (r) { return r.project === '项目X'; })[0];
ok('项目X 收入 = 100000（退款不计入收入）', x && approx(x.revenue, 100000));
ok('项目X 流水成本 = 30000 - 5000 = 25000（退款冲减）', x && approx(x.flowCost, 25000));
ok('项目X 总成本 = 25000 + 20000 = 45000', x && approx(x.totalCost, 45000));
ok('项目X 利润 = 100000 - 45000 = 55000', x && approx(x.profit, 55000));

console.log('— 报表中心：退款收入不影响总收入，冲减成本 —');
setInternal([
  { id: 'g1', date: '2026-03-01', type: 'income', project: '项目X', amount: 100000, category: '其他收入' },
  { id: 'g2', date: '2026-04-01', type: 'expense', project: '项目X', amount: 30000, category: '材料采购' },
  { id: 'g3', date: '2026-05-01', type: 'refund', project: '项目X', amount: 5000, category: '材料采购' }
]);
var agg = FW.reportsCalc.agg('', '');
ok('报表 总收入 = 100000（退款不计入总收入）', approx(agg.incomeTotal, 100000));
ok('报表 成本 = 30000 - 5000 = 25000（退款冲减成本）', approx(agg.costTotal, 25000));
ok('报表 净利润 = 100000 - 25000 = 75000', approx(agg.netProfit, 75000));
// 退款绝不能抬高总收入
setInternal([
  { id: 'h1', date: '2026-03-01', type: 'income', amount: 0, category: '其他收入' },
  { id: 'h2', date: '2026-05-01', type: 'refund', amount: 888, category: '材料采购' }
]);
ok('仅退款时 报表总收入 = 0（退款不在收入列）', approx(FW.reportsCalc.agg('', '').incomeTotal, 0));

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
