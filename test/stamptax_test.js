/* 印花税计算模块回归测试
 * 1) 纯函数 calcStamp：税率表、合计、减半（证券交易除外）、未知税目忽略、脏输入
 * 2) 真实 DOM 跑 render()：不崩、默认行算出合计、减半切换生效、增行
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

var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'stamptax.js'), 'utf8');
eval(src);

var C = FW.stampTaxCalc;
var passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }
function near(a, b, eps) { return Math.abs(a - b) < (eps === undefined ? 0.005 : eps); }

console.log('【印花税计算】');

/* ---------- 1. 纯函数 ---------- */
var r1 = C.calcStamp([
  { key: 'purchase', amount: 1000000 },  // 0.03% → 300
  { key: 'loan', amount: 500000 }        // 0.005% → 25
], false);
ok('买卖合同 100万 ×0.03% = 300', near(r1.lines[0].tax, 300, 0.01));
ok('借款合同 50万 ×0.005% = 25', near(r1.lines[1].tax, 25, 0.01));
ok('合计 = 325', near(r1.total, 325, 0.01));

var r2 = C.calcStamp([
  { key: 'purchase', amount: 1000000 },
  { key: 'loan', amount: 500000 }
], true);
ok('减半后（无证券交易）→ 合计 162.5', near(r2.total, 162.5, 0.01));
ok('减半标记在行上体现', r2.lines[0].half === true);

var r3 = C.calcStamp([
  { key: 'securities', amount: 1000000 }, // 0.1% → 1000，减半应排除
  { key: 'lease', amount: 100000 }        // 0.1% → 100，减半生效 → 50
], true);
ok('证券交易减半被排除（仍 1000），租赁减半 → 50，合计 1050', near(r3.total, 1050, 0.01));
ok('证券交易行 half=false', r3.lines[0].half === false);
ok('租赁行 half=true（被减半）', r3.lines[1].half === true);

var r4 = C.calcStamp([ { key: 'unknown_key', amount: 100000 }, { key: 'books', amount: 1000000 } ], false);
ok('未知税目被忽略，仅营业账簿计入 100万×0.025%=250', near(r4.total, 250, 0.01) && r4.lines.length === 1);

var r5 = C.calcStamp([ { key: 'purchase', amount: 'abc' } ], false);
ok('脏金额按 0 处理 → 合计 0', r5.total === 0);
ok('calcStamp 空数组返回 0', C.calcStamp([], false).total === 0);
ok('税目表含 14 项', C.STAMP.length === 14);
ok('calcStamp 不传参不抛异常', (function () { try { C.calcStamp(); return true; } catch (e) { return false; } })());

/* ---------- 2. 真实 render ---------- */
var renderOk = true, renderErr = '';
try { FW.modules.stamptax.render(); } catch (e) { renderOk = false; renderErr = e && e.message; }
ok('render() 不抛异常' + (renderOk ? '' : ' → ' + renderErr), renderOk);
ok('默认渲染出明细行', document.querySelectorAll('#stRows tr').length >= 1);
var totalTxt = (document.getElementById('stTotal') || {}).textContent || '';
ok('默认合计渲染出金额（¥325.00）', /325\.00/.test(totalTxt));

// 减半切换
var half = document.getElementById('st_half');
half.checked = true;
half.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
var totalHalf = document.getElementById('stTotal').textContent || '';
ok('勾选减半后合计变为 ¥162.50', /162\.50/.test(totalHalf));
half.checked = false;
half.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

// 增行
var before = document.querySelectorAll('#stRows tr').length;
document.getElementById('stAdd').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
var after = document.querySelectorAll('#stRows tr').length;
ok('点击添加一行后行数 +1', after === before + 1);

/* ---------- 3. 挂载断言 ---------- */
var kb = fs.readFileSync(path.join(__dirname, '..', 'js', 'knowledge.js'), 'utf8');
ok('财税知识新增「税费测算专题」分类', /税费测算专题/.test(kb));
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('index.html 已挂印花税导航入口', /data-module="stamptax"/.test(html));
ok('index.html 已引入 stamptax.js', /js\/stamptax\.js/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
