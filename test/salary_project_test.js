/* 工资登记：项目化奖金/提成 + 思维导图聚合 测试（纯逻辑）
 * 1) FW.salaryAgg：按项目聚合奖金与提成，生成脑图 svg
 * 2) 不同年份隔离
 * 3) guessSalaryMap：奖金/提成分别映射不冲突
 * 4) 旧数据兼容：仅 bonus/commission 数值归为单项目明细
 * 5) FW.mindMap 通用渲染
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
    uid: function (p) { return (p || '') + Math.random().toString(36).slice(2); },
    exportAll: function () { return {}; },
    importAll: function () { return Promise.resolve(); }
  },
  esc: function (s) { return String(s == null ? '' : s); },
  fmtMoney: function (n) { return (Number(n) || 0).toFixed(2); },
  qa: function () { return []; },
  toast: function () {},
  openModal: function () {}
};

function load(p) { return fs.readFileSync(path.join(__dirname, '..', 'js', p), 'utf8'); }
eval(load('ui.js'));
eval(load('salary.js'));

const Agg = FW.salaryAgg;
const Calc = FW.salaryCalc;
const Imp = FW.salaryImport;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// ---------- 准备数据 ----------
var recs = [
  { id: 'e1-2026-1', empId: 'e1', year: 2026, month: 1, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目A', amount: 8000 }], bonusItems: [], commissionItems: [{ project: '项目A', amount: 2000 }, { project: '项目B', amount: 1000 }] },
  { id: 'e1-2026-2', empId: 'e1', year: 2026, month: 2, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目A', amount: 8000 }], bonusItems: [{ project: '项目A', amount: 3000 }], commissionItems: [{ project: '项目A', amount: 500 }] },
  { id: 'e2-2026-3', empId: 'e2', year: 2026, month: 3, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目C', amount: 9000 }], bonusItems: [{ project: '项目C', amount: 1500 }, { project: '项目A', amount: 500 }], commissionItems: [] }
];
FW.db.saveList('salary_records', recs);

console.log('--- 1) 按项目聚合奖金/提成 + 脑图 ---');
var agg = Agg(2026);
ok('聚合出 3 个项目（A/B/C）', agg.projects.length === 3);
ok('项目A 提成 = 2000+500 = 2500', Math.abs(agg.projMap['项目A'].commission - 2500) < 0.001);
ok('项目A 奖金 = 3000+500 = 3500', Math.abs(agg.projMap['项目A'].bonus - 3500) < 0.001);
ok('项目B 提成 = 1000', Math.abs(agg.projMap['项目B'].commission - 1000) < 0.001);
ok('项目B 奖金 = 0', Math.abs(agg.projMap['项目B'].bonus - 0) < 0.001);
ok('项目C 奖金 = 1500', Math.abs(agg.projMap['项目C'].bonus - 1500) < 0.001);
ok('项目C 提成 = 0', Math.abs(agg.projMap['项目C'].commission - 0) < 0.001);
ok('项目A 底薪 = 8000+8000 = 16000', Math.abs(agg.projMap['项目A'].base - 16000) < 0.001);
ok('项目B 底薪 = 0', Math.abs(agg.projMap['项目B'].base - 0) < 0.001);
ok('项目C 底薪 = 9000', Math.abs(agg.projMap['项目C'].base - 9000) < 0.001);
ok('总底薪 = 16000+9000 = 25000', Math.abs(agg.grandBase - 25000) < 0.001);
ok('脑图含底薪叶子标签', agg.svg.indexOf('>底薪<') > -1);
ok('总奖金 = 3500+1500 = 5000', Math.abs(agg.grandBonus - 5000) < 0.001);
ok('总提成 = 2500+1000 = 3500', Math.abs(agg.grandCommission - 3500) < 0.001);
ok('按合计降序，项目A（7000）排第一', agg.projects[0] === '项目A');
ok('脑图 svg 含「项目A」', agg.svg.indexOf('项目A') > -1);
ok('脑图 svg 含「项目B」', agg.svg.indexOf('项目B') > -1);
ok('脑图 svg 含「项目C」', agg.svg.indexOf('项目C') > -1);
ok('脑图含奖金/提成叶子标签', agg.svg.indexOf('>奖金<') > -1 && agg.svg.indexOf('>提成<') > -1);
ok('脑图含根节点年份「2026年」', agg.svg.indexOf('2026年') > -1);
ok('脑图根节点含合计值「总」', agg.svg.indexOf('总') > -1);
ok('脑图用主题色 #C8102E（奖金）', agg.svg.indexOf('#C8102E') > -1);
ok('脑图用主题色 #1f9d55（提成）', agg.svg.indexOf('#1f9d55') > -1);

console.log('--- 2) 不同年份隔离 ---');
FW.db.saveList('salary_records', recs.concat([{ id: 'e1-2025-1', empId: 'e1', year: 2025, month: 1, base: 8000, bonus: 0, commission: 0, bonusItems: [{ project: '旧项目', amount: 999 }], commissionItems: [] }]));
var agg25 = Agg(2025);
ok('2025 隔离：不含 2026 的项目(A/B/C)', agg25.projects.indexOf('项目A') < 0 && agg25.projects.indexOf('项目B') < 0 && agg25.projects.indexOf('项目C') < 0);
ok('2025 含「旧项目」与未分类底薪', agg25.projects.indexOf('旧项目') >= 0 && agg25.projects.indexOf('未分类') >= 0 && agg25.projects.length === 2);
ok('2026 聚合不受 2025 影响（仍 3 项）', Agg(2026).projects.length === 3);

console.log('--- 3) 导入列识别：奖金/提成分别映射 ---');
var g = Imp.guessSalaryMap(['姓名', '部门', '月份', '底薪', '奖金', '提成']);
ok('识别 奖金 列 = 4', g.bonus === 4);
ok('识别 提成 列 = 5 且与奖金不同', g.commission === 5 && g.commission !== g.bonus);

console.log('--- 4) 旧数据兼容：数值归为单项目明细 ---');
var emp = { id: 'e9', name: '老员工', dept: '' };
FW.db.saveList('salary_employees', [emp]);
FW.db.saveList('salary_records', [{ id: 'e9-2026-5', empId: 'e9', year: 2026, month: 5, base: 7000, bonus: 1200, commission: 800 }]);
var c = Calc.computeEmpYear(emp, FW.db.getList('salary_records'), 2026);
ok('旧 bonus 规范为 1 条奖金明细(1200)', c.months[0].bonusItems.length === 1 && Math.abs(c.months[0].bonusItems[0].amount - 1200) < 0.001);
ok('旧 commission 规范为 1 条提成明细(800)', c.months[0].commissionItems.length === 1 && Math.abs(c.months[0].commissionItems[0].amount - 800) < 0.001);
ok('金额 = 底薪+奖金+提成 = 9000', Math.abs(c.months[0].amount - 9000) < 0.001);

console.log('--- 5) FW.mindMap 通用渲染 ---');
var svg2 = FW.mindMap({
  root: { label: '根', value: '总 100' },
  branches: [{ label: 'P1 50', color: '#C9A227', children: [{ label: '奖金', value: '30', color: '#C8102E' }, { label: '提成', value: '20', color: '#1f9d55' }] }]
});
ok('mindMap 生成 <div class="mindmap-box"><svg', /^<div class="mindmap-box"><svg /.test(svg2));
ok('mindMap 含分支与叶子', svg2.indexOf('P1') > -1 && svg2.indexOf('>奖金<') > -1);
ok('mindMap 含连接线 path', svg2.indexOf('<path') > -1);

console.log('--- 6) 底薪按项目分类 + 脑图聚合 + 旧数据规范 ---');
var baseOnly = [
  { id: 'p1-2028-1', empId: 'p1', year: 2028, month: 1, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目甲', amount: 6000 }, { project: '项目乙', amount: 2000 }], bonusItems: [], commissionItems: [] },
  { id: 'p1-2028-2', empId: 'p1', year: 2028, month: 2, base: 0, bonus: 0, commission: 0,
    baseItems: [{ project: '项目甲', amount: 6000 }], bonusItems: [], commissionItems: [] }
];
FW.db.saveList('salary_records', baseOnly);
var aggB = Agg(2028);
ok('底薪聚合出 2 个项目（甲/乙）', aggB.projects.length === 2);
ok('项目甲 底薪 = 6000+6000 = 12000', Math.abs(aggB.projMap['项目甲'].base - 12000) < 0.001);
ok('项目乙 底薪 = 2000', Math.abs(aggB.projMap['项目乙'].base - 2000) < 0.001);
ok('脑图含「底薪」叶子标签', aggB.svg.indexOf('>底薪<') > -1);
ok('脑图根节点含「工资」字样', aggB.svg.indexOf('工资') > -1);
ok('脑图用主题金色 #C9A227（底薪）', aggB.svg.indexOf('#C9A227') > -1);

console.log('--- 6b) 旧 base 数值规范为单条底薪明细 ---');
var legacy = [{ id: 'lg-2028-5', empId: 'lg', year: 2028, month: 5, base: 7500, bonus: 0, commission: 0 }];
var cLegacy = Calc.computeEmpYear({ id: 'lg' }, legacy, 2028);
ok('旧 base 规范为 1 条底薪明细(7500)', cLegacy.months[0].baseItems.length === 1 && Math.abs(cLegacy.months[0].baseItems[0].amount - 7500) < 0.001);
ok('旧 base 规范后底薪合计不变 = 7500', Math.abs(cLegacy.months[0].base - 7500) < 0.001);

console.log('\n工资项目化/脑图 测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
