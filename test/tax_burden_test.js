/* 税负率计算模块回归测试
 * 1) 纯函数 calcBurden：四大税负率口径、销项-进项推导、附加税自动/手工、除零保护
 * 2) judge：行业区间 低/正常/高 判定
 * 3) buildWarnings：结论文案分支
 * 4) 真实 DOM 跑一次 render()（jsdom 解析 innerHTML），验证不崩且能算出真实结果
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

var toasts = [];
global.FW = window.FW = {
  fmtMoney: function (n) { return '¥' + (Number(n) || 0).toFixed(2); },
  esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); },
  toast: function (m) { toasts.push(m); },
  qa: function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); },
  modules: {}
};

// 加载真实模块
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'taxburden.js'), 'utf8');
eval(src);

var C = FW.taxBurdenCalc;
var passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }
function near(a, b, eps) { return Math.abs(a - b) < (eps === undefined ? 0.005 : eps); }

console.log('【税负率计算】');

/* ---------- 1. 基础四口径 ---------- */
var r1 = C.calcBurden({
  income: 1000000, vatMode: 'direct', vatPayable: 25000,
  surtaxMode: 'auto', region: 'city', halfSurtax: false,
  cit: 15000, iit: 8000, includeIit: false, otherTax: 2000, profit: 300000
});
ok('增值税税负率 25000/1000000 = 2.50%', near(r1.vatRate, 2.5));
// 附加 = 25000 × (7%+3%+2%) = 3000
ok('附加税费自动算（市区 12%）= 3000', near(r1.surtax, 3000, 0.01));
ok('流转税税负率 (25000+3000)/1000000 = 2.80%', near(r1.turnoverRate, 2.8));
ok('所得税税负率 15000/1000000 = 1.50%', near(r1.citRate, 1.5));
// 综合 = 25000+3000+15000+2000 = 45000（个税未计入）
ok('综合税负率 45000/1000000 = 4.50%', near(r1.overallRate, 4.5));
ok('代扣个税默认不计入合计', near(r1.totalTax, 45000, 0.01));
ok('实际所得税率 15000/300000 = 5.00%', near(r1.citOnProfit, 5));
ok('利润率 300000/1000000 = 30.00%', near(r1.netProfitRate, 30));

/* ---------- 2. 计入代扣个税 ---------- */
var r2 = C.calcBurden({
  income: 1000000, vatMode: 'direct', vatPayable: 25000,
  surtaxMode: 'auto', region: 'city', halfSurtax: false,
  cit: 15000, iit: 8000, includeIit: true, otherTax: 2000
});
ok('勾选后代扣个税计入合计 = 53000', near(r2.totalTax, 53000, 0.01));
ok('计入个税后综合税负率 5.30%', near(r2.overallRate, 5.3));

/* ---------- 3. 销项-进项推导 ---------- */
var r3 = C.calcBurden({ income: 1000000, vatMode: 'derive', outputTax: 130000, inputTax: 105000, surtaxMode: 'manual', surtax: 0 });
ok('销项130000-进项105000 → 增值税 25000', near(r3.vat, 25000, 0.01));
var r4 = C.calcBurden({ income: 1000000, vatMode: 'derive', outputTax: 80000, inputTax: 100000, surtaxMode: 'manual', surtax: 0 });
ok('进项大于销项（留抵）→ 增值税不为负，取 0', r4.vat === 0 && r4.vatRate === 0);

/* ---------- 4. 附加税地区与减半 ---------- */
var r5 = C.calcBurden({ income: 100000, vatMode: 'direct', vatPayable: 10000, surtaxMode: 'auto', region: 'county', halfSurtax: false });
ok('县城 5%+3%+2%=10% → 附加 1000', near(r5.surtax, 1000, 0.01));
var r6 = C.calcBurden({ income: 100000, vatMode: 'direct', vatPayable: 10000, surtaxMode: 'auto', region: 'county', halfSurtax: true });
ok('六税两费减半 → 附加 500', near(r6.surtax, 500, 0.01));
var r7 = C.calcBurden({ income: 100000, vatMode: 'direct', vatPayable: 10000, surtaxMode: 'auto', region: 'other', halfSurtax: false });
ok('其他地区 1%+3%+2%=6% → 附加 600', near(r7.surtax, 600, 0.01));
var r8 = C.calcBurden({ income: 100000, vatMode: 'direct', vatPayable: 10000, surtaxMode: 'manual', surtax: 777 });
ok('手工填附加税优先于自动计算', near(r8.surtax, 777, 0.01));

/* ---------- 5. 除零 / 脏输入保护 ---------- */
var r9 = C.calcBurden({ income: 0, vatMode: 'direct', vatPayable: 5000 });
ok('收入为 0 时各税负率为 0（不产生 Infinity/NaN）', r9.vatRate === 0 && r9.overallRate === 0 && isFinite(r9.vatRate));
var r10 = C.calcBurden({ income: 'abc', vatPayable: null, cit: undefined, profit: '' });
ok('非法输入全部按 0 处理', r10.income === 0 && r10.totalTax === 0 && r10.citOnProfit === 0);
var r11 = C.calcBurden({ income: 100000, vatMode: 'direct', vatPayable: -5000, surtaxMode: 'manual', surtax: -100 });
ok('负数增值税/附加被夹到 0', r11.vat === 0 && r11.surtax === 0);
var r12 = C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 20000, cit: 10000, profit: 0 });
ok('利润总额为 0 时实际所得税率为 0（不除零）', r12.citOnProfit === 0);
ok('calcBurden 不传参不抛异常', (function () { try { C.calcBurden(); return true; } catch (e) { return false; } })());

/* ---------- 6. 行业区间判定 ---------- */
ok('工业制造 1.2% → 偏低', C.judge(1.2, 'manufacture').level === 'low');
ok('工业制造 2.8% → 正常', C.judge(2.8, 'manufacture').level === 'normal');
ok('工业制造 4.0% → 偏高', C.judge(4.0, 'manufacture').level === 'high');
ok('边界值 = 下限 2.0% 算正常', C.judge(2.0, 'manufacture').level === 'normal');
ok('边界值 = 上限 3.5% 算正常', C.judge(3.5, 'manufacture').level === 'normal');
ok('商业批发 1.2% → 正常（区间 0.9-1.5）', C.judge(1.2, 'wholesale').level === 'normal');
ok('选「不对比」不做判定', C.judge(99, 'none').level === 'none');
ok('未知行业 key 回退为不对比', C.judge(99, 'xxx').level === 'none');
ok('行业表含 12 项且第一项为不对比', C.INDUSTRY.length === 12 && C.INDUSTRY[0].key === 'none');

/* ---------- 7. 结论文案 ---------- */
var w1 = C.buildWarnings(C.calcBurden({ income: 0 }), 'manufacture');
ok('收入为 0 提示先填收入', w1.length === 1 && /不含税营业收入/.test(w1[0].text));
var w2 = C.buildWarnings(C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 8000, surtaxMode: 'manual', surtax: 0 }), 'manufacture');
ok('税负率偏低给出风险自查提示', w2.some(function (x) { return x.level === 'warn' && /低于/.test(x.text) && /未开票收入|进项抵扣过多/.test(x.text); }));
var w3 = C.buildWarnings(C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 60000, surtaxMode: 'manual', surtax: 0 }), 'manufacture');
ok('税负率偏高给出进项不足提示', w3.some(function (x) { return x.level === 'warn' && /高于/.test(x.text) && /进项抵扣不足/.test(x.text); }));
var w4 = C.buildWarnings(C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 28000, surtaxMode: 'manual', surtax: 0 }), 'manufacture');
ok('税负率正常给出 ok 结论', w4.some(function (x) { return x.level === 'ok' && /正常水平/.test(x.text); }));
var w5 = C.buildWarnings(C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 28000, surtaxMode: 'manual', surtax: 0, cit: 15000, profit: 300000 }), 'none');
ok('实际所得税率 5% 提示已享小微优惠', w5.some(function (x) { return /小型微利/.test(x.text); }));
var w6 = C.buildWarnings(C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 28000, surtaxMode: 'manual', surtax: 0, cit: 100000, profit: 300000 }), 'none');
ok('实际所得税率 33% 提示纳税调增', w6.some(function (x) { return x.level === 'warn' && /纳税调增/.test(x.text); }));
var w7 = C.buildWarnings(C.calcBurden({ income: 1000000, vatMode: 'direct', vatPayable: 28000, surtaxMode: 'manual', surtax: 0, iit: 9000, includeIit: false }), 'none');
ok('代扣个税未计入时给出说明', w7.some(function (x) { return /未计入综合税负/.test(x.text); }));
ok('buildWarnings 传 null 不抛异常', (function () { try { C.buildWarnings(null, 'none'); return true; } catch (e) { return false; } })());

/* ---------- 8. 真实 render（jsdom 解析 innerHTML，验证 DOM 链路不崩） ---------- */
var renderOk = true, renderErr = '';
try { FW.modules.taxburden.render(); } catch (e) { renderOk = false; renderErr = e && e.message; }
ok('render() 不抛异常' + (renderOk ? '' : ' → ' + renderErr), renderOk);
ok('render 后表单字段就位', !!document.getElementById('tb_income') && !!document.getElementById('tb_industry') && !!document.getElementById('tb_vatmode'));
var resultHtml = (document.getElementById('tbResult') || {}).innerHTML || '';
ok('结果区渲染出四个税负率卡片', /增值税税负率/.test(resultHtml) && /流转税税负率/.test(resultHtml) && /所得税税负率/.test(resultHtml) && /综合税负率/.test(resultHtml));
// 默认值：收入 1000000、增值税 25000、市区、减半 → 附加 1500；所得税 15000；合计 41500 → 4.15%
ok('默认值下算出增值税税负率 2.50%', /2\.50%/.test(resultHtml));
ok('默认值下算出综合税负率 4.15%', /4\.15%/.test(resultHtml));
ok('默认行业为工业制造，命中正常区间', /正常水平/.test(resultHtml));

// 切换到「销项-进项」模式后字段显隐正确
document.getElementById('tb_vatmode').value = 'derive';
var evt = new dom.window.Event('change', { bubbles: true });
document.getElementById('tb_vatmode').dispatchEvent(evt);
ok('切换 derive 后隐藏「应纳增值税」、显示销项/进项',
  document.getElementById('f_vat').style.display === 'none' &&
  document.getElementById('f_output').style.display !== 'none' &&
  document.getElementById('f_input').style.display !== 'none');

// 从内账带入
FW.reportsCalc = { agg: function () { return { incomeTotal: 888000, taxTotal: 12000, netProfit: 200000 }; } };
document.getElementById('tbImport').onclick();
ok('从内账带入：收入/税金/利润写回表单',
  document.getElementById('tb_income').value === '888000' &&
  document.getElementById('tb_other').value === '12000' &&
  document.getElementById('tb_profit').value === '200000');
ok('带入后弹出 toast 提示', toasts.some(function (t) { return /已带入/.test(t); }));

// 内账不可用时不崩
delete FW.reportsCalc;
var importSafe = true;
try { document.getElementById('tbImport').onclick(); } catch (e) { importSafe = false; }
ok('内账数据不可用时优雅提示而非报错', importSafe && toasts.some(function (t) { return /内账数据不可用/.test(t); }));

/* ---------- 9. 知识库条目 ---------- */
var kb = fs.readFileSync(path.join(__dirname, '..', 'js', 'knowledge.js'), 'utf8');
ok('财税知识新增「税负率与风险」分类', /税负率与风险/.test(kb));
ok('公式函数知识新增税负率公式条目', /税负率四大口径/.test(kb));
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('index.html 已挂导航入口', /data-module="taxburden"/.test(html));
ok('index.html 已引入 taxburden.js', /js\/taxburden\.js/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
