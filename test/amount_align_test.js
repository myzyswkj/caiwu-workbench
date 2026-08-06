// 金额列对齐回归：导出（图片 / Excel / PDF）必须与屏幕流水表一致 = 左对齐
var assert = require('assert');
var fs = require('fs');
var T = require('../js/table_image.js');

// ---- canvas / DOM shim（捕获 fillText 坐标）----
var currentRec = null;
function makeCtx(rec) {
  return {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textBaseline: '',
    measureText: function (s) { return { width: String(s).length * 7 }; },
    fillText: function (t, x, y) { rec.push({ t: String(t), x: x, y: y }); },
    strokeText: function () {}, fillRect: function () {}, strokeRect: function () {},
    clearRect: function () {}, beginPath: function () {}, closePath: function () {},
    moveTo: function () {}, lineTo: function () {}, stroke: function () {}, fill: function () {},
    arcTo: function () {}, rect: function () {}, scale: function () {},
    save: function () {}, restore: function () {}, translate: function () {},
    roundRect: function () {}, clip: function () {}, drawImage: function () {}
  };
}
function makeCanvas(rec) {
  return {
    width: 0, height: 0, style: {},
    getContext: function () { return makeCtx(rec); },
    toBlob: function (cb, type) { cb({ size: 1, type: type || 'image/png' }); },
    toDataURL: function () { return 'data:image/png;base64,AAAA'; }
  };
}
global.document = {
  documentElement: {},
  createElement: function (tag) {
    return tag === 'canvas'
      ? makeCanvas(currentRec)
      : { style: {}, appendChild: function () {}, click: function () {}, setAttribute: function () {}, getContext: function () { return makeCtx(currentRec); } };
  },
  body: { appendChild: function () {}, removeChild: function () {} }
};
global.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
global.Image = function () { return { set src(v) {}, onload: null, onerror: null }; };
global.URL = { createObjectURL: function () { return 'blob:probe'; }, revokeObjectURL: function () {} };

var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
var rows = [{ cells: ['2026-08-01', '收入', '项目A', '销售', '微信', '+1,000.00', '得力', '张三', '备注', ''], amountCls: 'income' }];
function baseCfg(extra) {
  return Object.assign({
    title: '内账流水明细', head: head, rows: rows,
    colWidths: [124, 84, 144, 114, 156, 148, 184, 106, 224, 268],
    amountCol: 5, imgCol: 9, pics: {}, picMaxW: 220, picMaxH: 130, gap: 8, fontScale: 1
  }, extra);
}
function findAmtX(rec) {
  // 数据行金额单元格文本（带符号），与表头「金额」/KPI/副表（带 ¥）区分
  var hit = null;
  rec.forEach(function (c) { if (c.t === '+1,000.00') hit = c; });
  return hit ? hit.x : null;
}
function run(cfg) {
  currentRec = [];
  return T.render(cfg).then(function () { return findAmtX(currentRec); });
}

var pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('[1] 图片导出：金额列对齐');
var xDefault, xRight, xLeft;
Promise.resolve()
  .then(function () { return run(baseCfg({})).then(function (r) { xDefault = r; }); })
  .then(function () { return run(baseCfg({ amountAlign: 'right' })).then(function (r) { xRight = r; }); })
  .then(function () { return run(baseCfg({ amountAlign: 'left' })).then(function (r) { xLeft = r; }); })
  .then(function () {
    ok('默认（不传 amountAlign）= 右对齐', xDefault !== null && xRight !== null && xDefault === xRight);
    ok('amountAlign: left 时金额列左对齐（x 比右对齐更小）', xLeft !== null && xRight !== null && xLeft < xRight);

    console.log('[2] Excel / PDF 导出：金额列左对齐（源码静态断言）');
    var src = fs.readFileSync(__dirname + '/../js/internal.js', 'utf8');
    ok('internal.js 图片导出触发 amountAlign: left', src.indexOf("amountAlign: 'left'") >= 0);
    ok('internal.js Excel 金额列设左对齐样式', src.indexOf("horizontal: 'left'") >= 0);
    ok('internal.js Excel 写出 cellStyles', src.indexOf('cellStyles: true') >= 0);
    ok('internal.js PDF 表头金额左对齐', src.indexOf('text-align:left">金额') >= 0);
    ok('internal.js PDF 金额单元格左对齐', src.indexOf('style="text-align:left"') >= 0);

    console.log((fail ? 'SOME FAILED' : 'ALL_OK') + '  pass=' + pass + ' fail=' + fail);
    if (fail) process.exitCode = 1;
  })
  .catch(function (e) {
    console.log('  ✗ 异常: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  });
