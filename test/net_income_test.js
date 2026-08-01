/* 净额收入（已扣支出 deduct）测试
 * 背景：有些「收入」是按净额记的（到账金额 = 实际收入 − 已扣支出）。
 * 规则：实际收入 = 到账金额 + 已扣支出；已扣支出计入项目成本（只计一次）。
 * 目标：利润率用「实际收入」做分母，不再因收入被砍小而失真；利润金额不变。
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

console.log('— 项目核算：净额收入（deduct）还原实际收入、已扣支出计入成本 —');
// 项目P：到账 8000，已扣支出 2000（实际收入应为 10000）；另有材料支出 3000
setInternal([
  { id: 'i1', date: '2026-03-01', type: 'income', project: '项目P', amount: 8000, deduct: 2000, category: '材料采购' },
  { id: 'e1', date: '2026-04-01', type: 'expense', project: '项目P', amount: 3000, category: '材料采购' }
]);
var rows = FW.projectCostCalc.compute('all').rows;
var p = rows.filter(function (r) { return r.project === '项目P'; })[0];
ok('项目P 实际收入 = 8000 + 2000 = 10000', p && approx(p.revenue, 10000));
ok('项目P 流水成本 = 2000(已扣) + 3000 = 5000', p && approx(p.flowCost, 5000));
ok('项目P 总成本 = 5000', p && approx(p.totalCost, 5000));
ok('项目P 利润 = 10000 - 5000 = 5000', p && approx(p.profit, 5000));
ok('项目P 利润率 = 5000/10000 = 50%', p && approx(p.rate, 50));
ok('byCat["材料采购"] = 5000（已扣+支出同分类）', p && approx(p.byCat['材料采购'], 5000));

console.log('— 与「毛额收入 + 单独支出」口径完全一致（利润/利润率相同） —');
// 控制组：正确口径——收入记毛额 10000，支出记 5000（2000单独一笔）
setInternal([
  { id: 'c1', date: '2026-03-01', type: 'income', project: '项目P', amount: 10000, category: '材料采购' },
  { id: 'c2', date: '2026-04-01', type: 'expense', project: '项目P', amount: 2000, category: '材料采购' },
  { id: 'c3', date: '2026-04-02', type: 'expense', project: '项目P', amount: 3000, category: '材料采购' }
]);
var ctrl = FW.projectCostCalc.compute('all').rows.filter(function (r) { return r.project === '项目P'; })[0];
ok('控制组 收入 = 10000', ctrl && approx(ctrl.revenue, 10000));
ok('控制组 流水成本 = 5000', ctrl && approx(ctrl.flowCost, 5000));
ok('控制组 利润 = 5000（与净额记法一致）', ctrl && approx(ctrl.profit, 5000));
ok('控制组 利润率 = 50%（与净额记法一致）', ctrl && approx(ctrl.rate, 50));

console.log('— 旧记法（净额收入、未填已扣）利润率失真，对比说明修复意义 —');
setInternal([
  { id: 'o1', date: '2026-03-01', type: 'income', project: '项目P', amount: 8000, category: '材料采购' },
  { id: 'o2', date: '2026-04-01', type: 'expense', project: '项目P', amount: 3000, category: '材料采购' }
]);
var old = FW.projectCostCalc.compute('all').rows.filter(function (r) { return r.project === '项目P'; })[0];
ok('旧记法 收入 = 8000（被砍小，失真）', old && approx(old.revenue, 8000));
ok('旧记法 利润率 = 5000/8000 = 62.5%（虚高失真）', old && approx(old.rate, 62.5));
ok('旧记法 利润金额 = 5000（金额恰好对，但分母错）', old && approx(old.profit, 5000));

console.log('— 报表中心：收入还原毛额、已扣支出计入成本、净利润不变 —');
setInternal([
  { id: 'g1', date: '2026-03-01', type: 'income', project: '项目P', amount: 8000, deduct: 2000, category: '材料采购' },
  { id: 'g2', date: '2026-04-01', type: 'expense', project: '项目P', amount: 3000, category: '材料采购' }
]);
var agg = FW.reportsCalc.agg('', '');
ok('报表 总收入 = 10000（毛额，含已扣）', approx(agg.incomeTotal, 10000));
ok('报表 成本 = 5000（2000已扣 + 3000支出）', approx(agg.costTotal, 5000));
ok('报表 净利润 = 5000', approx(agg.netProfit, 5000));

console.log('— 批量校正：openDeductCorrector 存在且可导 （仅接口校验） —');
ok('FW.projectCostCalc.openDeductCorrector 是函数', typeof FW.projectCostCalc.openDeductCorrector === 'function');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
