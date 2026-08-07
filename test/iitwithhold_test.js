/* 个税累计预扣表模块回归测试
 * 1) 纯函数 withholding：累计预扣法、税率跳档、年度合计
 * 2) bracket：七档预扣率表边界
 * 3) 真实 DOM 跑 render()：不崩、输出 12 行逐月表、年度合计
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('./setup').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><body><div id="content"></div><div id="topActions"></div></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;

global.FW = window.FW = {
  fmtMoney: function (n) { return '¥' + (Number(n) || 0).toFixed(2); },
  esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); },
  toast: function () {},
  qa: function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); },
  modules: {}
};

var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'iitwithhold.js'), 'utf8');
eval(src);

var C = FW.iitWithholdCalc;
var passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }
function near(a, b, eps) { return Math.abs(a - b) < (eps === undefined ? 0.005 : eps); }

console.log('【个税累计预扣表】');

/* ---------- 1. 预扣率表边界 ---------- */
ok('bracket(0) → 3%', C.bracket(0).rate === 0.03);
ok('bracket(36000) → 3%', C.bracket(36000).rate === 0.03);
ok('bracket(36001) → 10%', C.bracket(36001).rate === 0.10);
ok('bracket(144000) → 10%', C.bracket(144000).rate === 0.10);
ok('bracket(144001) → 20%', C.bracket(144001).rate === 0.20);
ok('bracket(960000) → 35%', C.bracket(960000).rate === 0.35);
ok('bracket(960001) → 45%', C.bracket(960001).rate === 0.45);
ok('预扣率表 7 档', C.TABLE.length === 7 && C.TABLE[0].qd === 0 && C.TABLE[6].qd === 85920);

/* ---------- 2. withholding 累计预扣 ---------- */
// 月薪 20000、三险一金 3000、专项附加 2000 → 月减除 10000
// M1: 应税 10000×3%=300；M4 应税 40000 → 10% 档，累计 1480，本月 580
var r = C.withholding(20000, 3000, 2000, 0);
ok('第1月本月预扣 = 300', near(r.months[0].monthTax, 300, 0.01));
ok('第1月预扣率 3%', r.months[0].rate === '3%');
ok('第4月因跨档本月预扣跳升至 580', near(r.months[3].monthTax, 580, 0.01));
ok('第4月累计应缴 = 1480', near(r.months[3].cumTax, 1480, 0.01));
ok('年度累计应预扣 = 9480', near(r.yearTax, 9480, 0.01));
ok('共 12 个月', r.months.length === 12);

// 累计跨档后逐月稳定：第2、3月仍为 300
ok('第2月本月预扣 = 300', near(r.months[1].monthTax, 300, 0.01));
ok('第3月本月预扣 = 300', near(r.months[2].monthTax, 300, 0.01));

// 减除费用固定 5000：纯工资 10000、无其他扣除 → M1 应税 5000×3%=150
var r2 = C.withholding(10000, 0, 0, 0);
ok('月薪1万无扣除，第1月预扣 150', near(r2.months[0].monthTax, 150, 0.01));

ok('withholding 不传参不抛异常', (function () { try { C.withholding(); return true; } catch (e) { return false; } })());

/* ---------- 3. 真实 render ---------- */
var renderOk = true, renderErr = '';
try { FW.modules.iitwithhold.render(); } catch (e) { renderOk = false; renderErr = e && e.message; }
ok('render() 不抛异常' + (renderOk ? '' : ' → ' + renderErr), renderOk);
ok('表单字段就位', !!document.getElementById('iw_s') && !!document.getElementById('iw_add'));
ok('结果区渲染出 12 行逐月表', document.querySelectorAll('#iwResult tbody tr').length === 12);
var resHtml = (document.getElementById('iwResult') || {}).innerHTML || '';
ok('结果区显示年度累计应预扣 ¥9480.00', /9480\.00/.test(resHtml));

/* ---------- 4. 挂载断言 ---------- */
var kb = fs.readFileSync(path.join(__dirname, '..', 'js', 'knowledge.js'), 'utf8');
ok('财税知识新增个税累计预扣条目', /个人所得税（累计预扣法）/.test(kb));
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('index.html 已挂个税导航入口', /data-module="iitwithhold"/.test(html));
ok('index.html 已引入 iitwithhold.js', /js\/iitwithhold\.js/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
