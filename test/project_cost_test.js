/* 项目核算：成本利润盈亏单产 测试（纯逻辑）
 * 1) 收入来自流水 income(带项目)；流水成本来自 expense(带项目)；工资成本来自工资 Items(带项目)
 * 2) 年度筛选：all / 指定年
 * 3) 利润率 / 投入产出比 计算；亏损项目；零成本项目(∞)
 * 4) 未选项目的流水不计入；旧数值工资归「未分类」
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
    remove: function (k, id) { var a = (store[k] || []).filter(function (x) { return x.id !== id; }); store[k] = a; },
    uid: function (p) { return (p || '') + Math.random().toString(36).slice(2); }
  },
  esc: function (s) { return String(s == null ? '' : s); },
  fmtMoney: function (n) { return (Number(n) || 0).toFixed(2); },
  qa: function () { return []; },
  toast: function () {}
};

function load(p) { return fs.readFileSync(path.join(__dirname, '..', 'js', p), 'utf8'); }
eval(load('ui.js'));
eval(load('project_cost.js'));

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function approx(a, b) { return Math.abs(a - b) < 0.001; }

// ===== 准备数据 =====
store['internal'] = [
  { date: '2026-03-01', type: 'income', project: '项目A', amount: 100000 },
  { date: '2026-04-01', type: 'expense', project: '项目A', amount: 30000 },
  { date: '2026-05-01', type: 'expense', project: '项目B', amount: 20000 },
  { date: '2026-06-01', type: 'income', project: '项目C', amount: 50000 },
  { date: '2025-12-01', type: 'income', project: '项目A', amount: 10000 },
  { date: '2026-07-01', type: 'expense', project: '', amount: 999 } // 未选项目 → 不计入
];
store['salary_records'] = [
  { id: 's1', empId: 'e1', year: 2026, month: 1, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目A', amount: 20000 }], bonusItems: [{ project: '项目A', amount: 5000 }], commissionItems: [] },
  { id: 's2', empId: 'e2', year: 2026, month: 2, base: 0, bonus: 0, commission: 0,
    commissionItems: [{ project: '项目B', amount: 8000 }] },
  { id: 's3', empId: 'e3', year: 2025, month: 3, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目A', amount: 1000 }] }
];

var C = FW.projectCostCalc;

console.log('--- 1) 全部年度聚合 ---');
var d = C.compute('all');
ok('聚合出 3 个项目(A/B/C)', d.rows.length === 3);

var A = d.rows.filter(function (r) { return r.project === '项目A'; })[0];
ok('项目A 收入 = 100000+10000(2025) = 110000', approx(A.revenue, 110000));
ok('项目A 流水成本 = 30000', approx(A.flowCost, 30000));
ok('项目A 工资成本 = 20000+5000+1000 = 26000', approx(A.laborCost, 26000));
ok('项目A 总成本 = 56000', approx(A.totalCost, 56000));
ok('项目A 利润 = 54000', approx(A.profit, 54000));
ok('项目A 利润率 = 54000/110000 = 49.09%', approx(A.rate, 49.0909));
ok('项目A 投入产出比 = 110000/56000 = 1.964', approx(A.roi, 1.9643));

var B = d.rows.filter(function (r) { return r.project === '项目B'; })[0];
ok('项目B 收入 = 0（仅有成本）', approx(B.revenue, 0));
ok('项目B 利润 = -28000（亏损）', approx(B.profit, -28000) && B.gain === false);
ok('项目B 利润率 = 0（无收入）', approx(B.rate, 0));

var Cc = d.rows.filter(function (r) { return r.project === '项目C'; })[0];
ok('项目C 总成本 = 0（无成本）', approx(Cc.totalCost, 0));
ok('项目C 利润 = 50000', approx(Cc.profit, 50000));
ok('项目C 投入产出比 = ∞（成本0且收入>0）', Cc.roi === Infinity);

ok('总流水成本 = 30000+20000 = 50000', approx(d.tot.flowCost, 50000));
ok('总工资成本 = 26000+8000 = 34000', approx(d.tot.laborCost, 34000));
ok('总利润 = 54000-28000+50000 = 76000', approx(d.tot.profit, 76000));
ok('平均利润率 = 76000/160000 = 47.5%', approx(d.avgRate, 47.5));

console.log('--- 2) 年度筛选 2026 ---');
var dd = C.compute(2026);
var A6 = dd.rows.filter(function (r) { return r.project === '项目A'; })[0];
ok('2026 项目A 收入 = 100000（不含2025的10000）', approx(A6.revenue, 100000));
ok('2026 项目A 工资成本 = 25000（仅2026工资）', approx(A6.laborCost, 25000));
ok('2026 不含 2025 的工资项目', dd.rows.every(function (r) { return r.project !== '虚'; }));

console.log('--- 3) getYears ---');
var yrs = C.getYears();
ok('年度含 2025 与 2026', yrs.indexOf('2025') >= 0 && yrs.indexOf('2026') >= 0 && yrs.length === 2);

console.log('--- 4) 旧数值工资 / 未选项目 兼容 ---');
var items = C.salaryItems({ base: 5000, bonus: 0, commission: 0 });
ok('旧数值工资归为「未分类」单条 5000', items.length === 1 && items[0].project === '未分类' && approx(items[0].amount, 5000));

console.log('\n项目核算 测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
