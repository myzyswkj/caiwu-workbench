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

// 往来账：预付款 → 项目核算「应收回款项」。仅 kind='预付' 计入；按项目聚合未用完余额（amount - settled）
store['contacts'] = [
  { id: 'c1', kind: '预付', party: '供应商甲', project: '项目A', date: '2026-02-01', amount: 60000, settled: 10000 }, // 余额 50000
  { id: 'c2', kind: '预付', party: '供应商乙', project: '项目B', date: '2026-04-01', amount: 40000, settled: 0 },     // 余额 40000
  { id: 'c3', kind: '预付', party: '供应商丙', project: '项目A', date: '2025-08-01', amount: 20000, settled: 5000 },  // 2025 余额 15000
  { id: 'c4', kind: '预付', party: '供应商丁', project: '', date: '2026-05-01', amount: 30000, settled: 0 },          // 未关联项目 30000
  { id: 'c5', kind: '应收', party: '客户X', project: '项目A', date: '2026-03-01', amount: 30000, settled: 0 },          // 应收，不计入应收回款项
  { id: 'c6', kind: '预付', party: '供应商戊', project: '项目D', date: '2026-06-01', amount: 10000, settled: 0 }          // 仅预付、无收支的项目
];

var C = FW.projectCostCalc;

console.log('--- 1) 全部年度聚合 ---');
var d = C.compute('all');
ok('聚合出 4 个项目(A/B/C/D)', d.rows.length === 4);

var A = d.rows.filter(function (r) { return r.project === '项目A'; })[0];
ok('项目A 收入 = 100000+10000(2025) = 110000', approx(A.revenue, 110000));
ok('项目A 流水成本 = 30000', approx(A.flowCost, 30000));
ok('项目A 工资成本 = 20000+5000+1000 = 26000', approx(A.laborCost, 26000));
ok('项目A 总成本 = 56000', approx(A.totalCost, 56000));
ok('项目A 利润 = 54000', approx(A.profit, 54000));
ok('项目A 利润率 = 54000/110000 = 49.09%', approx(A.rate, 49.0909));
ok('项目A 投入产出比 = 110000/56000 = 1.964', approx(A.roi, 1.9643));
ok('项目A 应收回款项 = 预付(c1 余额50000 + c3 2025余额15000) = 65000', approx(A.recoverable, 65000));
ok('项目A 应收回款项下钻明细 2 笔（全部年度含2025）', A.recoverList.length === 2);
ok('明细① 供应商甲：预付60000/已核销10000/未用50000', A.recoverList[0].party === '供应商甲' && approx(A.recoverList[0].amount, 60000) && approx(A.recoverList[0].settled, 10000) && approx(A.recoverList[0].balance, 50000));
ok('明细② 供应商丙：预付20000/已核销5000/未用15000', A.recoverList[1].party === '供应商丙' && approx(A.recoverList[1].balance, 15000));
ok('「应收」客户X 不计入明细', A.recoverList.every(function (x) { return x.party !== '客户X'; }));

var B = d.rows.filter(function (r) { return r.project === '项目B'; })[0];
ok('项目B 收入 = 0（仅有成本）', approx(B.revenue, 0));
ok('项目B 利润 = -28000（亏损）', approx(B.profit, -28000) && B.gain === false);
ok('项目B 利润率 = 0（无收入）', approx(B.rate, 0));
ok('项目B 应收回款项 = 预付(c2 余额40000)', approx(B.recoverable, 40000));

var Cc = d.rows.filter(function (r) { return r.project === '项目C'; })[0];
ok('项目C 总成本 = 0（无成本）', approx(Cc.totalCost, 0));
ok('项目C 利润 = 50000', approx(Cc.profit, 50000));
ok('项目C 投入产出比 = ∞（成本0且收入>0）', Cc.roi === Infinity);
ok('项目C 应收回款项 = 0（无预付）', approx(Cc.recoverable, 0));

var Dd = d.rows.filter(function (r) { return r.project === '项目D'; })[0];
ok('聚合出 4 个项目(A/B/C/D，D 仅预付)', d.rows.length === 4);
ok('项目D 仅预付无收支，应收回款项 = 10000 仍出现', Dd && approx(Dd.recoverable, 10000) && approx(Dd.revenue, 0) && approx(Dd.profit, 0));
ok('应收(c5 kind=应收) 不计入应收回款项', A.recoverable === 65000);
ok('总应收回款项 = 65000+40000+10000 = 115000', approx(d.tot.recoverable, 115000));

ok('总流水成本 = 30000+20000 = 50000', approx(d.tot.flowCost, 50000));
ok('总工资成本 = 26000+8000 = 34000', approx(d.tot.laborCost, 34000));
ok('总利润 = 54000-28000+50000 = 76000', approx(d.tot.profit, 76000));
ok('平均利润率 = 76000/160000 = 47.5%', approx(d.avgRate, 47.5));

console.log('--- 2) 年度筛选 2026 ---');
var dd = C.compute(2026);
var A6 = dd.rows.filter(function (r) { return r.project === '项目A'; })[0];
ok('2026 项目A 收入 = 100000（不含2025的10000）', approx(A6.revenue, 100000));
ok('2026 项目A 工资成本 = 25000（仅2026工资）', approx(A6.laborCost, 25000));
ok('2026 项目A 应收回款项 = 50000（不含2025的15000）', approx(A6.recoverable, 50000));
ok('2026 项目A 下钻明细仅 1 笔（供应商甲50000，不含2025供应商丙）', A6.recoverList.length === 1 && A6.recoverList[0].party === '供应商甲' && approx(A6.recoverList[0].balance, 50000));
ok('2026 总应收回款项 = A50000+B40000+D10000 = 100000', approx(dd.tot.recoverable, 100000));
ok('2026 不含 2025 的工资项目', dd.rows.every(function (r) { return r.project !== '虚'; }));

console.log('--- 3) getYears ---');
var yrs = C.getYears();
ok('年度含 2025 与 2026', yrs.indexOf('2025') >= 0 && yrs.indexOf('2026') >= 0 && yrs.length === 2);

console.log('--- 4) 旧数值工资 / 未选项目 兼容 ---');
var items = C.salaryItems({ base: 5000, bonus: 0, commission: 0 });
ok('旧数值工资归为「未分类」单条 5000', items.length === 1 && items[0].project === '未分类' && approx(items[0].amount, 5000));

console.log('--- 5) 未分配 / 月度趋势 / 排名 / 成本结构 ---');
ok('未分配流水 1 笔、999 元', d.unalloc.flowCount === 1 && approx(d.unalloc.flowAmt, 999));
ok('无项目的工资 → 0 条未分配', d.unalloc.laborCount === 0 && approx(d.unalloc.laborAmt, 0));
ok('未关联项目的预付款 1 笔、30000 元', d.unalloc.prepayCount === 1 && approx(d.unalloc.prepayAmt, 30000));
ok('不再生成「未分类」项目行', d.rows.every(function (r) { return r.project !== '未分类'; }));

ok('排名按利润降序：项目A 第1', d.rows[0].project === '项目A' && d.rows[0].rank === 1);
ok('排名：项目C 第2、项目D 第3(利润0)、项目B 第4（亏损）', d.rows[1].project === '项目C' && d.rows[2].project === '项目D' && d.rows[3].project === '项目B' && d.rows[3].rank === 4);

ok('逐月趋势月份数 = 8（5 个流水月 + 3 个工资月）', d.monthly.labels.length === 8);
var revSum = d.monthly.revenue.reduce(function (s, v) { return s + v; }, 0);
var costSum = d.monthly.cost.reduce(function (s, v) { return s + v; }, 0);
ok('月度收入合计 = 总收入 160000', approx(revSum, 160000));
ok('月度成本合计 = 总流水+总工资 = 84000', approx(costSum, 84000));

ok('成本结构(分类)：无分类流水归「其他」= 50000', d.cats.length === 1 && d.cats[0].label === '其他' && approx(d.cats[0].value, 50000));
var ltSum = d.laborTypes.reduce(function (s, x) { return s + x.value; }, 0);
ok('工资成本构成合计 = 34000（底薪21000+奖金5000+提成8000）', approx(ltSum, 34000));
ok('工资成本构成含 底薪/奖金/提成 三项', d.laborTypes.length === 3);

console.log('\n项目核算 测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
