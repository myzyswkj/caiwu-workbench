/* 首页测试：验证「各账户余额」「各项目盈亏」两个新区块能正确渲染
 * 复现：工作台首页需展示各账户余额与各项目盈亏
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
const dashCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

try { eval(uiCode); } catch (e) { console.log('UI_LOAD_ERROR:', e.message); process.exit(1); }

window.FW.db = {
  getList: function (k) {
    if (k === 'internal') return [
      { date: '2026-03-01', type: 'income', project: '项目A', amount: 100000, account: '银行卡' },
      { date: '2026-04-01', type: 'expense', project: '项目A', amount: 30000, account: '银行卡', category: '材料 / 钢材' }
    ];
    if (k === 'memos') return [];
    return [];
  },
  saveList: function () {}, upsert: function () {}, remove: function () {}, uid: function (p) { return (p || '') + Math.random(); }
};
window.FW.toast = function () {};
window.FW.openModal = function () {};
window.FW.closeModal = function () {};

// 桩：账户余额（internalCalc，树状）
window.FW.internalCalc = {
  accountBalancesTree: function () {
    return [
      { name: '银行卡', bal: 612000, children: [
        { name: '银行卡 / 工行', bal: 580000 },
        { name: '银行卡 / 招行', bal: 32000 }
      ] },
      { name: '现金', bal: 12000, children: [] },
      { name: '支付宝', bal: 34000, children: [] },
      { name: '微信', bal: 21000, children: [] }
    ];
  }
};
// 桩：项目盈亏（projectCostCalc）
window.FW.projectCostCalc = {
  compute: function () {
    return {
      rows: [
        { project: '项目A', revenue: 110000, profit: 70000, rate: 63.6, gain: true },
        { project: '项目B', revenue: 40000, profit: -5000, rate: -12.5, gain: false },
        { project: '项目C', revenue: 50000, profit: 20000, rate: 40, gain: true }
      ]
    };
  }
};

eval(dashCode);

let html = '';
try {
  window.FW.modules.home.render();
  html = domEls['content'].innerHTML;
  ok('home.render() 不抛错', true);
} catch (e) {
  ok('home.render() 不抛错', false);
  console.log('    RENDER_ERROR: ' + e.stack);
}

ok('含「各账户余额」区块', html.indexOf('各账户余额') >= 0);
ok('含「资金总计」汇总', html.indexOf('资金总计') >= 0);
ok('含账户「银行卡」', html.indexOf('银行卡') >= 0);
ok('含二级账户「工行」（嵌套显示）', html.indexOf('工行') >= 0);
ok('含「各项目盈亏」区块', html.indexOf('各项目盈亏') >= 0);
ok('含项目「项目A」', html.indexOf('项目A') >= 0);
ok('含盈利/亏损徽标', html.indexOf('盈利') >= 0 && html.indexOf('亏损') >= 0);
ok('含利润率 %', html.indexOf('%') >= 0);
ok('输出不含 NaN/undefined/[object Object]', html.indexOf('NaN') < 0 && html.indexOf('undefined') < 0 && html.indexOf('[object Object]') < 0);

// 空数据分支：无账户 / 无项目时不应崩溃且不应输出区块
window.FW.internalCalc.accountBalancesTree = function () { return []; };
window.FW.projectCostCalc.compute = function () { return { rows: [] }; };
let html2 = '';
try {
  window.FW.modules.home.render();
  html2 = domEls['content'].innerHTML;
  ok('空数据时 home.render() 不抛错', true);
} catch (e) {
  ok('空数据时 home.render() 不抛错', false);
  console.log('    EMPTY_ERROR: ' + e.stack);
}
ok('空数据时不含「各账户余额」', html2.indexOf('各账户余额') < 0);
ok('空数据时不含「各项目盈亏」', html2.indexOf('各项目盈亏') < 0);

console.log('\n首页 测试：' + pass + ' 通过，' + fail + ' 失败' + (fail ? ' ❌' : ' ✅'));
process.exit(fail ? 1 : 0);
