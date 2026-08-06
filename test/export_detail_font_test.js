// 导出明细加大字号 + 收入/支出加粗：PNG / Excel / PDF 三端与界面流水一致
// 锁定：① PNG 按列加大(日期/类型/项目/分类/账户) + 类型列收入/支出加粗 + 金额恒加粗
//       ② Excel 前 5 列 sz=13 + 类型列收入/支出 bold + 金额 bold
//       ③ PDF fp-detail-big / fp-type-bold 类名落到明细行
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var T = require('../js/table_image.js');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } }

// ---- canvas shim：同时记录 font 与 text ----
var lastFont = '';
function makeCtx(rec) {
  return {
    scale: function () {}, fillRect: function () {}, strokeRect: function () {}, fill: function () {}, stroke: function () {},
    beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, arcTo: function () {}, closePath: function () {}, roundRect: function () {},
    drawImage: function () {},
    fillText: function (t) { rec.push({ font: lastFont, text: String(t) }); },
    measureText: function (s) { return { width: String(s).length * 7 }; },
    set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) { lastFont = v; }, set lineWidth(v) {}, set textBaseline(v) {}
  };
}

console.log('[1] PNG：_compute 透传 bigCols/typeCol，并用 measureBig 测量加大列');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '收入', 'A', '销售', '微信', '+1,000', 'x', 'y', 'z', ''], amountCls: 'income' }];
  var measure = function (s) { return { width: String(s).length * 7 }; };
  var measureBig = function (s) { return { width: String(s).length * 12 }; };
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, bigCols: [0, 1, 2, 3, 4], typeCol: 1, measureBig: measureBig }, measure);
  ok('geo 暴露 bigCols(5 列)', g.bigCols && g.bigCols.length === 5);
  ok('geo 暴露 typeCol=1', g.typeCol === 1);
  // 长文本在加大列：用 measureBig(12/字) 应比普通 measure(7/字) 折行更多
  var long = '很长很长的项目名很长很长的项目名很长很长的项目名很长很长的项目名';
  var rows2 = [{ cells: ['2026-08-01', '收入', long, '分类', '账户', '+1,000', 'x', 'y', 'z', ''], amountCls: 'income' }];
  var cw = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
  var gBig = T._compute({ head: head, rows: rows2, amountCol: 5, imgCol: 9, colWidths: cw, bigCols: [0, 1, 2, 3, 4], typeCol: 1, measureBig: measureBig }, measure);
  var gNorm = T._compute({ head: head, rows: rows2, amountCol: 5, imgCol: 9, colWidths: cw, bigCols: [0, 1, 2, 3, 4], typeCol: 1 }, measure);
  ok('加大列用 measureBig 折行更多（长文本项目列）', gBig.rows[0].cellLines[2].length >= gNorm.rows[0].cellLines[2].length);
})();

console.log('[2] PNG：_draw 对加大列用 FONT_BIG，类型列收入用 FONT_BIG_BOLD，金额用 FONT_BOLD');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '收入', 'A', '分类', '微信', '+1,000', 'x', 'y', 'z', ''], amountCls: 'income' }];
  var geo = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, bigCols: [0, 1, 2, 3, 4], typeCol: 1 }, function (s) { return { width: String(s).length * 7 }; });
  var rec = [];
  lastFont = '';
  T._draw(makeCtx(rec), geo, { amountAlign: 'left' });
  var fontOf = function (txt) { var e = rec.filter(function (r) { return r.text === txt; })[0]; return e ? e.font : ''; };
  ok('日期列(加大)用 FONT_BIG(20px 且非 bold)', /20px/.test(fontOf('2026-08-01')) && !/600 /.test(fontOf('2026-08-01')));
  ok('类型列收入用 FONT_BIG_BOLD(600 20px)', /600 /.test(fontOf('收入')) && /20px/.test(fontOf('收入')));
  ok('金额列用 FONT_BOLD(600 17px)', /600 /.test(fontOf('+1,000')) && /17px/.test(fontOf('+1,000')));
})();

console.log('[3] PNG：中性(转账)行的类型列只用 FONT_BIG，不加粗');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '账户互转', 'A', '分类', '微信', '0.00', 'x', 'y', 'z', ''], amountCls: 'neutral' }];
  var geo = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, bigCols: [0, 1, 2, 3, 4], typeCol: 1 }, function (s) { return { width: String(s).length * 7 }; });
  var rec = [];
  lastFont = '';
  T._draw(makeCtx(rec), geo, { amountAlign: 'left' });
  var e = rec.filter(function (r) { return r.text === '账户互转'; })[0];
  ok('中性类型不加粗', e && /20px/.test(e.font) && !/600 /.test(e.font));
})();

console.log('[4] Excel：前 5 列加大字号 + 类型列收入/支出加粗 + 金额加粗（源码特征锁定，防误删）');
(function () {
  ok('buildXLSX 含 xlBigCols=[0,1,2,3,4]', /xlBigCols\s*=\s*\[\s*0\s*,\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*\]/.test(SRC));
  ok('buildXLSX 含 BIG_FONT_SZ=13', /BIG_FONT_SZ\s*=\s*13/.test(SRC));
  ok('buildXLSX 对类型列收入/支出加粗', /ci\s*===\s*xlTypeCol\s*&&\s*incExp/.test(SRC));
  ok('buildXLSX 金额列加粗', /acell\.s\.font\.bold\s*=\s*true/.test(SRC));
})();

console.log('[5] PDF：明细行加 fp-detail-big / fp-type-bold（源码特征锁定）');
(function () {
  ok('openPrintView 给前 5 列加 fp-detail-big', /class="fp-detail-big"/.test(SRC));
  ok('openPrintView 给收入/支出类型加 fp-type-bold', /fp-type-bold/.test(SRC));
  ok('style.css 定义 fp-detail-big 字号 15px', /#fpDetailTable tbody td\.fp-detail-big\s*\{\s*font-size:\s*15px/.test(fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8')));
  ok('style.css 定义 fp-type-bold 加粗', /#fpDetailTable tbody td\.fp-type-bold\s*\{\s*font-weight:\s*700/.test(fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8')));
})();

console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (fail) process.exit(1);
