/* 工资登记：奖金/提成分开记录 测试（纯逻辑，无 DOM 依赖）
 * 1) computeYear 正确区分 底薪/奖金/提成 与 合计
 * 2) 旧数据兼容：旧 bonus(合并) 仍记为奖金，提成=0
 * 3) guessSalaryMap：提成列→commission，奖金列→bonus，不重复占用同一列
 * 4) parseSalaryRows：奖金列与提成列分别解析
 */
const fs = require('fs');
const path = require('path');

global.window = global;
const store = {};
global.FW = {
  db: {
    getList: function (k) { return store[k] || []; },
    saveList: function (k, v) { store[k] = v; return true; },
    upsert: function (k, item) { var a = store[k] || []; var i = a.findIndex(function (x) { return x.id === item.id; }); if (i >= 0) a[i] = item; else a.push(item); store[k] = a; return item; },
    uid: function (p) { return (p || '') + Math.random().toString(36).slice(2); }
  },
  esc: function (s) { return String(s == null ? '' : s); },
  fmtMoney: function (n) { return (Number(n) || 0).toFixed(2); },
  qa: function () { return []; },
  toast: function () {},
  openModal: function () {}
};

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'salary.js'), 'utf8');
eval(code);

const Calc = FW.salaryCalc;
const Imp = FW.salaryImport;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

console.log('--- 1) computeYear 区分 底薪/奖金/提成 ---');
const emps = [{ id: 'e1', name: '张三', dept: '销售' }];
const recs = [
  { id: 'e1-2026-1', empId: 'e1', year: 2026, month: 1, base: 8000, bonus: 2000, commission: 5000 },
  { id: 'e1-2026-2', empId: 'e1', year: 2026, month: 2, base: 8000, bonus: 0, commission: 8000 }
];
const year = Calc.computeYear(emps, recs, 2026);
const calc = year[0].calc;
ok('累计底薪 = 16000', Math.abs(calc.cumBase - 16000) < 0.001);
ok('累计奖金 = 2000', Math.abs(calc.cumBonus - 2000) < 0.001);
ok('累计提成 = 13000', Math.abs(calc.cumCommission - 13000) < 0.001);
ok('累计金额 = 31000', Math.abs(calc.cumAmount - 31000) < 0.001);
ok('1月 金额 = 底+奖+提 = 15000', Math.abs(calc.months[0].amount - 15000) < 0.001 && calc.months[0].bonus === 2000 && calc.months[0].commission === 5000);

console.log('--- 2) 旧数据兼容（无 commission 字段）---');
const oldRecs = [
  { id: 'e1-2025-1', empId: 'e1', year: 2025, month: 1, base: 8000, bonus: 3000 } // 老数据：bonus 是 奖金/提成 合并值
];
const oldYear = Calc.computeYear(emps, oldRecs, 2025)[0].calc;
ok('老 bonus 仍记为奖金 = 3000', Math.abs(oldYear.cumBonus - 3000) < 0.001);
ok('老数据提成默认 = 0', Math.abs(oldYear.cumCommission - 0) < 0.001);
ok('老合计 = 11000', Math.abs(oldYear.cumAmount - 11000) < 0.001);

console.log('--- 3) guessSalaryMap 列识别 ---');
const headers = ['姓名', '部门', '月份', '底薪', '奖金', '提成', '年份'];
const g = Imp.guessSalaryMap(headers);
ok('识别 姓名', g.name === 0);
ok('识别 部门', g.dept === 1);
ok('识别 月份', g.month === 2);
ok('识别 底薪', g.base === 3);
ok('识别 奖金(独立列)', g.bonus === 4);
ok('识别 提成(独立列)', g.commission === 5);
ok('识别 年份', g.year === 6);
ok('提成列未被奖金重复占用', g.bonus !== g.commission);

console.log('--- 3b) guessSalaryMap 只含单列 提成 ---');
const h2 = ['员工', '工资', '销售提成'];
const g2 = Imp.guessSalaryMap(h2);
ok('提成列 → commission', g2.commission === 2);
ok('奖金列未误占（无奖金列）', g2.bonus === -1);

console.log('--- 4) parseSalaryRows 奖金/提成分别解析 ---');
const rows = [
  ['姓名', '月份', '底薪', '奖金', '提成'],
  ['李四', '2026-03', '6000', '1000', '3000'],
  ['王五', '2026-04', '7000', '', '5000']
];
const map = { name: 0, dept: 'ignore', month: 1, year: 'ignore', base: 2, bonus: 3, commission: 4 };
const parsed = Imp.parseSalaryRows(rows.slice(1), map, 2026, 0);
ok('解析 2 条', parsed.rows.length === 2);
ok('李四 底薪6000 奖金1000 提成3000', parsed.rows[0].base === 6000 && parsed.rows[0].bonus === 1000 && parsed.rows[0].commission === 3000);
ok('李四 金额 = 10000', parsed.rows[0].amount === 10000);
ok('王五 奖金为空→0，提成5000', parsed.rows[1].bonus === 0 && parsed.rows[1].commission === 5000);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
