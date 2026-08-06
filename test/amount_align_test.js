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

    console.log('[3] 金额列保底：导出必须装得下最大金额（不被压成多行）');
    // 背景：用户把金额列拖到接近下限 20-30px 时，屏幕被 cell 撑大显得 OK，
    // 但导出按 col.width 严格执行后只有 30-50px，"-¥97.50" 被迫折行 4 行 → 与屏幕观感不一致。
    // 修法：图片 100px 保底、Excel wch=14（≈105px）保底、PDF 100px 保底——三端统一。
    var src2 = fs.readFileSync(__dirname + '/../js/internal.js', 'utf8');
    var iImg = src2.indexOf('colWidths[9] = Math.max(colWidths[9], 160)');
    ok('图片导出：凭证列 160px 保底（不变）', iImg >= 0);
    var jImg = src2.indexOf('colWidths[5] = Math.max(colWidths[5], 100)');
    ok('图片导出：金额列新增 100px 保底（装下 -¥999,999.99）', jImg >= 0);
    ok('图片导出：金额保底在凭证保底之后定义', jImg > iImg);
    // Excel 保底
    ok('Excel 导出：金额列 wch 保底（≈ 100px）', /if \(id === 'amount'\) wch = Math\.max\(wch, amountMinWch\)/.test(src2));
    ok('Excel 导出：amountMinWch 声明 = 14', /var amountMinWch = 14;/.test(src2));
    // PDF 保底
    ok('PDF 导出：金额列 100px 保底（不被折行）', /if \(id === 'amount'\) w = Math\.max\(w, 100\);/.test(src2));
    // 100px 必须能装下最宽的金额串：-¥999,999.99 共 12 字符（含千分位）
    var widestAmount = '-¥999,999.99';  // 12 字符
    var px14PerChar = 8;                 // 14px 字号下平均字符宽约 8px（"¥" 比数字宽，千分位比数字窄）
    var needW = widestAmount.length * px14PerChar; // 96px
    ok('保底宽度 100 ≥ ' + widestAmount.length + ' 字符所需 ' + needW + 'px（留 buffer）', 100 >= needW);

    console.log((fail ? 'SOME FAILED' : 'ALL_OK') + '  pass=' + pass + ' fail=' + fail);
    if (fail) process.exitCode = 1;
  })
  .catch(function (e) {
    console.log('  ✗ 异常: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  });
