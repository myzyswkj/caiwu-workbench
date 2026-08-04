// 轻量回归测试：加载真实 internal.js，验证「带 allocations 的编辑记录能正常构造表单不报错」
// 目标：抓出运行期崩溃类回归（如 editxProjectText 笔误抛 ReferenceError、txProjectText 无分摊分支无限递归栈溢出）
// 做法：用最小 DOM/ FW 桩在 node 里真正执行 openForm / txProjectText，而非在测试里镜像一份逻辑。
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// ---------- 最小 DOM 桩 ----------
function makeEl() {
  var el = {
    _html: '', value: '', dataset: {}, style: {},
    classList: { contains: function () { return false; }, add: function () {}, remove: function () {} },
    appendChild: function () {}, addEventListener: function () {}, removeEventListener: function () {},
    closest: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    focus: function () {},
    onclick: null, oninput: null, onchange: null, ondragover: null, ondragleave: null, ondrop: null
  };
  Object.defineProperty(el, 'innerHTML', { get: function () { return this._html; }, set: function (v) { this._html = String(v); } });
  return el;
}
var els = {};
function getEl(id) { if (!els[id]) els[id] = makeEl(); return els[id]; }

var documentShim = {
  getElementById: function (id) { return getEl(id); },
  createElement: function () { return makeEl(); },
  querySelector: function () { return null; },
  addEventListener: function () {}, removeEventListener: function () {}
};

// ---------- 最小 FW 桩 ----------
var editRecord = {
  id: 't_alloc1', type: 'expense', date: '2026-07-10', amount: 10000,
  category: '材料采购 / 钢材', account: '对公账户', project: '', remark: '一笔合计支出覆盖三个项目',
  allocations: [
    { project: '项目A', amount: 4000 },
    { project: '项目B', amount: 3500 },
    { project: '项目C', amount: 2500 }
  ]
};
var plainRecord = { id: 't_plain', type: 'expense', date: '2026-07-12', amount: 120, category: '餐饮招待', account: '现金', project: '项目X', remark: '单项目支出' };
// 用于 filterRows(noAlloc) 的数据集：含未分摊收支、已分摊支出、互转（互转不参与分摊）
var dbData = [
  editRecord, plainRecord,
  { id: 'u1', type: 'expense', date: '2026-07-01', amount: 500, project: '', allocations: null },
  { id: 'u2', type: 'income', date: '2026-07-02', amount: 800, project: '', allocations: null },
  { id: 'u3', type: 'transfer', date: '2026-07-03', amount: 100, fromAccount: 'A', toAccount: 'B' },
  { id: 'a1', type: 'expense', date: '2026-07-04', amount: 300, project: '', allocations: [{ project: '项目A', amount: 300 }] }
];

var FW = {
  esc: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  fmtMoney: function (n) { return '¥' + (Number(n) || 0).toFixed(2); },
  today: function () { return '2026-08-04'; },
  toast: function () {},
  openModal: function (title, body, cb) { captured = { title: title, body: body, cb: cb }; },
  closeModal: function () {},
  qa: function () { return []; },
  nav: undefined,
  modules: {},
  db: {
    getList: function () { return dbData; },
    getById: function (key, id) { if (id === editRecord.id) return editRecord; if (id === plainRecord.id) return plainRecord; return null; },
    uid: function () { return 'uid_' + Math.random().toString(36).slice(2); },
    upsert: function () {},
    savePhoto: function () { return Promise.resolve('pid'); },
    getPhoto: function () { return Promise.resolve(null); },
    deletePhoto: function () {}
  }
};

// ---------- 加载真实模块 ----------
global.window = { FW: FW };
global.document = documentShim;
global.FW = FW;

var file = path.resolve(__dirname, '../js/internal.js');
var code = fs.readFileSync(file, 'utf8');
var captured = null;
vm.runInThisContext(code, { filename: 'internal.js' });

var M = global.window.FW.modules.internal;

console.log('加载真实 internal.js：' + (M && M.openForm ? 'OK' : 'FAIL'));

// ===== 1. txProjectText：无分摊分支不能无限递归（栈溢出） =====
ok('txProjectText 无分摊记录返回单项目名（不递归栈溢出）', (function () {
  try { return M.txProjectText({ project: '项目A' }) === '项目A'; } catch (e) { return false; }
})());
ok('txProjectText 有分摊记录返回「项目/项目」拼接', M.txProjectText(editRecord) === '项目A/项目B/项目C');
ok('txProjectText 全空记录返回空串（不递归）', (function () {
  try { return M.txProjectText({}) === ''; } catch (e) { return false; }
})());

// ===== 2. openForm：带 allocations 的编辑记录能正常构造表单且不抛错 =====
ok('openForm(带allocations编辑记录) 不抛异常', (function () {
  try { M.openForm(editRecord.id); return true; } catch (e) { console.log('    -> ' + e && e.stack); return false; }
})());
ok('openForm 弹窗标题为「编辑流水」', captured && captured.title === '编辑流水');
ok('openForm 构造的 body 含项目输入框', captured && /id="f_project"/.test(captured.body));
ok('openForm 构造的 body 不含崩溃笔误 editxProjectText', captured && captured.body.indexOf('editxProjectText') < 0);

// 真正执行回调（renderDyn→allocBoxHtml→bindAllocBox→refreshAlloc），验证分摊框正确渲染
ok('openForm 回调执行不抛异常且分摊框渲染', (function () {
  try {
    getEl('f_type').value = editRecord.type; // 让 renderDyn 走正确的分支
    captured.cb();
    var dyn = getEl('dynArea').innerHTML;
    return dyn.indexOf('alloc-box') >= 0 && dyn.indexOf('项目A') >= 0 && dyn.indexOf('项目B') >= 0 && dyn.indexOf('项目C') >= 0;
  } catch (e) { console.log('    -> ' + (e && e.stack)); return false; }
})());

// ===== 3. openForm：单项目编辑记录 / 新增记录 也不抛错 =====
ok('openForm(单项目编辑记录) 不抛异常', (function () {
  try { captured = null; M.openForm(plainRecord.id); return true; } catch (e) { return false; }
})());
ok('openForm(新增/无id) 不抛异常', (function () {
  try { captured = null; M.openForm(); return true; } catch (e) { return false; }
})());

// ===== 4. 分摊行项目控件：已有项目用 <select>（含「＋ 新建项目…」），自定义项目用文本框 =====
ok('分摊框渲染出 <select> 下拉（非 input list）', (function () {
  try {
    captured = null; M.openForm(editRecord.id);
    getEl('f_type').value = editRecord.type;
    captured.cb();
    var dyn = getEl('dynArea').innerHTML;
    return dyn.indexOf('<select') >= 0;
  } catch (e) { console.log('    -> ' + (e && e.stack)); return false; }
})());
ok('分摊下拉含「＋ 新建项目…」选项', (function () {
  try {
    captured = null; M.openForm(editRecord.id);
    getEl('f_type').value = editRecord.type;
    captured.cb();
    var dyn = getEl('dynArea').innerHTML;
    return dyn.indexOf('＋ 新建项目…') >= 0 && dyn.indexOf('__NEW__') >= 0;
  } catch (e) { console.log('    -> ' + (e && e.stack)); return false; }
})());
ok('分摊下拉列出已有项目（项目A 作为 option）', (function () {
  try {
    captured = null; M.openForm(editRecord.id);
    getEl('f_type').value = editRecord.type;
    captured.cb();
    var dyn = getEl('dynArea').innerHTML;
    return /<option[^>]*>项目A<\/option>/.test(dyn);
  } catch (e) { console.log('    -> ' + (e && e.stack)); return false; }
})());

// ===== 5. 仅看未分摊：filterRows(noAlloc=true) 只保留「应收分摊却没分摊」的收支/退款 =====
var FILTER = global.window.FW.internalCalc.filterRows;
ok('filterRows 默认返回全部 6 笔', (function () {
  var r = FILTER({});
  return r.length === 6;
})());
ok('filterRows(noAlloc=true) 返回未分摊的 u1/u2（共 2 笔，单项目 t_plain 已排除）', (function () {
  var r = FILTER({ noAlloc: true });
  var ids = r.map(function (t) { return t.id; }).sort();
  return r.length === 2 && ids[0] === 'u1' && ids[1] === 'u2';
})());
ok('filterRows(noAlloc=true) 排除已分摊(a1)与互转(u3)', (function () {
  var r = FILTER({ noAlloc: true });
  return r.every(function (t) { return t.id !== 'a1' && t.id !== 'u3'; });
})());

console.log('\nopenForm 轻量回归测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
