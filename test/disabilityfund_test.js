/* 残保金测算模块回归测试
 * 1) 纯函数 calcFund：免征（≤30人/达标）、分档 50%/90%、工资封顶、脏输入
 * 2) 真实 DOM 跑 render()：不崩、结果区渲染应缴额
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

var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'disabilityfund.js'), 'utf8');
eval(src);

var C = FW.disabilityFundCalc;
var passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }
function near(a, b, eps) { return Math.abs(a - b) < (eps === undefined ? 0.005 : eps); }

console.log('【残保金测算】');

/* ---------- 1. 纯函数 ---------- */
// N=100, D=1, W=100000 → ratio=1% → 50%档；gap=1.5-1=0.5；base=50000；payable=25000
var r1 = C.calcFund(100, 1, 100000, false, 0);
ok('安排比例=1% → 分档系数 50%', r1.band === '50%' && near(r1.payable, 25000, 0.01));
ok('分档前应缴 50000', near(r1.base, 50000, 0.01));

// N=100, D=0, W=100000 → ratio=0% → 90%档；gap=1.5；base=150000；payable=135000
var r2 = C.calcFund(100, 0, 100000, false, 0);
ok('安排比例<1% → 分档系数 90%', r2.band === '90%' && near(r2.payable, 135000, 0.01));

// N=100, D=2, W=100000 → ratio=2% ≥1.5% → 免征
var r3 = C.calcFund(100, 2, 100000, false, 0);
ok('安排比例≥1.5% → 免征', r3.exempt === true && r3.payable === 0);

// N=20 → ≤30人免征
var r4 = C.calcFund(20, 0, 80000, false, 0);
ok('在职职工≤30人 → 免征', r4.exempt === true && r4.payable === 0);

// 工资封顶：N=100,D=0,W=200000,capOn=true,cap=160000 → cappedW=160000
var r5 = C.calcFund(100, 0, 200000, true, 160000);
ok('启用封顶且超上限 → 按上限 160000 计', near(r5.cappedW, 160000, 0.01));
ok('封顶后应交 = 1.5×160000×0.9 = 216000', near(r5.payable, 216000, 0.01));

// 未启用封顶则不封顶
var r6 = C.calcFund(100, 0, 200000, false, 160000);
ok('未启用封顶 → 仍按 200000 计', near(r6.cappedW, 200000, 0.01) && near(r6.payable, 270000, 0.01));

// 脏输入
var r7 = C.calcFund('abc', null, undefined, false, 'x');
ok('非法输入不抛异常且免征（人数<=0）', r7.exempt === true && r7.payable === 0);
ok('calcFund 不传参不抛异常', (function () { try { C.calcFund(); return true; } catch (e) { return false; } })());

/* ---------- 2. 真实 render ---------- */
var renderOk = true, renderErr = '';
try { FW.modules.disabilityfund.render(); } catch (e) { renderOk = false; renderErr = e && e.message; }
ok('render() 不抛异常' + (renderOk ? '' : ' → ' + renderErr), renderOk);
ok('表单字段就位', !!document.getElementById('df_N') && !!document.getElementById('df_D') && !!document.getElementById('df_W'));

// 填入 N=100, D=0, W=100000 → 应缴 135000
document.getElementById('df_N').value = '100';
document.getElementById('df_D').value = '0';
document.getElementById('df_W').value = '100000';
document.getElementById('dfCalc').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
var resHtml = (document.getElementById('dfResult') || {}).innerHTML || '';
ok('结果区渲染出应缴额 ¥135000.00', /135000\.00/.test(resHtml));
ok('结果区显示分档系数 ×90%', /× ?90%/.test(resHtml));

/* ---------- 3. 挂载断言 ---------- */
var kb = fs.readFileSync(path.join(__dirname, '..', 'js', 'knowledge.js'), 'utf8');
ok('财税知识新增残保金条目', /残疾人就业保障金/.test(kb));
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('index.html 已挂残保金导航入口', /data-module="disabilityfund"/.test(html));
ok('index.html 已引入 disabilityfund.js', /js\/disabilityfund\.js/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
