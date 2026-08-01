/* 渲染冒烟测试：确认 project_cost.render() 与展开下钻不抛错、输出结构完整
 * 复现 #fba41c3 的回归 bug（tableHtml 参数契约错误导致 render 整页崩溃 → 区域空白）
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
const store = {
  internal: [
    { date: '2026-03-01', type: 'income', project: '项目A', amount: 100000, party: '甲方A' },
    { date: '2026-04-01', type: 'expense', project: '项目A', amount: 30000, category: '材料 / 钢材' },
    { date: '2026-05-01', type: 'expense', project: '项目B', amount: 20000, category: '人工 / 安装' },
    { date: '2026-06-01', type: 'income', project: '项目C', amount: 50000 },
    { date: '2025-12-01', type: 'income', project: '项目A', amount: 10000 },
  ],
  salary_records: [
    { id: 's1', year: 2026, month: 3, empId: 'e1', baseItems: [{ project: '项目A', amount: 8000 }], bonusItems: [{ project: '项目A', amount: 2000 }], commissionItems: [] },
    { id: 's2', year: 2026, month: 4, empId: 'e2', baseItems: [{ project: '项目B', amount: 5000 }], bonusItems: [], commissionItems: [] },
  ],
  contacts: [
    { kind: '预付', date: '2026-04-10', project: '项目A', party: '供应商X', amount: 12000, settled: 4000 }
  ]
};
const uiCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
const pcCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'project_cost.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

try { eval(uiCode); } catch (e) { console.log('UI_LOAD_ERROR:', e.message); process.exit(1); }
window.FW.db = {
  getList: function (k) { return store[k] || []; },
  saveList: function () {}, upsert: function () {}, remove: function () {}, uid: function (p) { return (p || '') + Math.random(); }
};
window.FW.toast = function () {};
window.FW.openModal = function () {};
window.FW.closeModal = function () {};
window.FW.qa = function () { return []; };
try { eval(pcCode); } catch (e) { console.log('PC_LOAD_ERROR:', e.message); process.exit(1); }

let renderedHtml = '';
try {
  window.FW.modules.projectCost.render();
  renderedHtml = domEls['content'].innerHTML;
  ok('render() 不抛错', true);
} catch (e) {
  ok('render() 不抛错', false);
  console.log('    RENDER_ERROR: ' + e.stack);
}
ok('渲染产出非空', renderedHtml.length > 1000);
ok('含项目汇总表 proj-sum-table', renderedHtml.indexOf('proj-sum-table') >= 0);
ok('含利润率对比条 pc-rate-list', renderedHtml.indexOf('pc-rate-list') >= 0);
ok('含图表 chart-svg', renderedHtml.indexOf('chart-svg') >= 0);
ok('输出不含 NaN/undefined/[object Object]', renderedHtml.indexOf('NaN') < 0 && renderedHtml.indexOf('undefined') < 0 && renderedHtml.indexOf('[object Object]') < 0);

// 展开下钻：触发 detailHtml + profitWaterfall
let drillHtml = '';
try {
  var tbl = domEls['pcTable'];
  if (tbl && tbl.onclick) {
    tbl.onclick({ target: { tagName: 'TD', closest: function (sel) { if (sel === '.pc-qty-cell') return null; return { getAttribute: function () { return '项目A'; } }; } } });
    drillHtml = domEls['content'].innerHTML;
    ok('展开下钻不抛错', true);
  } else {
    ok('展开下钻不抛错', false);
  }
} catch (e) {
  ok('展开下钻不抛错', false);
  console.log('    DRILL_ERROR: ' + e.stack);
}
ok('下钻含利润瀑布图', drillHtml.indexOf('利润形成') >= 0);
ok('下钻含二级分类表 pc-cat2-table', drillHtml.indexOf('pc-cat2-table') >= 0);
ok('下钻含应收回款项表 pc-recov-table', drillHtml.indexOf('pc-recov-table') >= 0);

console.log('\n渲染冒烟 测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
