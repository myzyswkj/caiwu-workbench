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
    ok('internal.js PDF 表头金额左对齐（TH_SP.amount 带 text-align:left，且表头由 ec.labels 驱动）',
      /var TH_SP = \{ amount: ' style="text-align:left"'/.test(src) && /headTh = ec\.ids\.map/.test(src));
    ok('internal.js PDF 金额单元格左对齐', src.indexOf('style="text-align:left"') >= 0);

    console.log('[3] 金额列保底：导出必须装得下最大金额（不被压成多行）');
    // 背景：用户把金额列拖到接近下限 20-30px 时，屏幕被 cell 撑大显得 OK，
    // 但导出按 col.width 严格执行后只有 30-50px，"-¥97.50" 被迫折行 4 行 → 与屏幕观感不一致。
    // 修法：图片 100px 保底、Excel wch=14（≈105px）保底、PDF 100px 保底——三端统一。
    var src2 = fs.readFileSync(__dirname + '/../js/internal.js', 'utf8');
    var iImg = src2.indexOf('colWidths[imgCol] = Math.max(colWidths[imgCol], 160)');
    ok('图片导出：凭证列 160px 保底（不变）', iImg >= 0);
    var jImg = src2.indexOf('colWidths[amountCol] = Math.max(colWidths[amountCol], 100)');
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

    console.log('[4] 导出宽度 = 屏幕真实渲染宽度（与界面一致，杜绝"屏幕撑开、导出压碎"的视觉欺骗）');
    // 背景：table-layout:fixed + width:max-content 会把窄列撑到内容宽度（用户肉眼所见），
    // 但导出若用存储的字面窄 width 渲染，就会把多数列压成极窄、只有凭证列（160px 保底）显得独霸。
    // 修法：screenColPx() 优先读表头 getBoundingClientRect 真实宽度，三端（图片/Excel/PDF）共用，
    // 且导出宽度滑块默认值=真实渲染总宽，使 scale 默认=1，导出与界面 1:1 对齐。
    var src3 = fs.readFileSync(__dirname + '/../js/internal.js', 'utf8');
    ok('screenColPx 改为读表头真实渲染宽度', src3.indexOf('readRenderedColWidths') >= 0);
    ok('readRenderedColWidths 用 getBoundingClientRect 取真实宽度', /getBoundingClientRect\(\)\.width/.test(src3));
    ok('screenColPx 优先用 rendered（any 分支）', src3.indexOf('if (any && rendered[i] != null)') >= 0);
    ok('导出宽度滑块默认=真实渲染总宽（scale≈1，1:1 对齐）', src3.indexOf('width.value = String(Math.min(2400, Math.max(800, Math.round(_dtw))))') >= 0);
    ok('图片/Excel/PDF 三端共用 screenColPx 单一来源', (src3.match(/screenColPx\(\)/g) || []).length >= 3);

    console.log('[5] 导出图片弹窗：备注列宽 / 凭证大小 可独立调节 + 实时预览');
    // 背景：用户要"导出图片的备注列加宽一些"+"也可以调凭证的大小"，并且"看能不能预览效果"。
    // 修法：buildImgConfig 第 4 参数 opts 支持 { remarkW, picScale }；
    //   - remarkW 覆盖备注列（remarkIdx）宽；
    //   - picScale 同步放大凭证列（imgCol）宽与图显示尺寸 picMaxW/picMaxH；
    //   弹窗加"备注列宽""凭证大小"两个滑块 + 实时预览（只渲染前 N 行 + KPI + 副表，布局真实）。
    var src4 = fs.readFileSync(__dirname + '/../js/internal.js', 'utf8');
    ok('buildImgConfig 第 4 参数 opts', /function buildImgConfig\(picMap, fs, scaledColWidths, opts\)/.test(src4));
    ok('备注列宽覆盖 cw[remarkIdx] = opts.remarkW', src4.indexOf('cw[remarkIdx] = opts.remarkW;') >= 0);
    ok('凭证大小同步放大凭证列宽 cw[imgCol]', src4.indexOf('cw[imgCol] = Math.round(baseCW[imgCol] * picScale);') >= 0);
    ok('凭证大小放大图显示尺寸 picMaxW/picMaxH', src4.indexOf('picMaxW: 220 * picScale, picMaxH: 130 * picScale,') >= 0);
    ok('配置支持预览截取行 opts.rows', src4.indexOf('rows: opts.rows || outRows,') >= 0);
    ok('弹窗含"备注列宽"滑块', src4.indexOf("'#remarkWRange'") >= 0);
    ok('弹窗含"凭证大小"滑块', src4.indexOf("'#picScaleRange'") >= 0);
    ok('弹窗含实时预览容器', src4.indexOf("'#txPrevCanvasWrap'") >= 0);
    ok('弹窗打开即出预览 schedulePreview', src4.indexOf('schedulePreview();  // 打开弹窗即出预览') >= 0);
    ok('下载调用带备注/凭证参数', src4.indexOf('buildImgConfig(pics, fs, scaledColWidths, { rows: outRows, remarkW: remarkW, picScale: picScale })') >= 0);

    console.log('[6] 整站深蓝白主题：CSS 关键变量与表格配色已切到深蓝');
    var css = fs.readFileSync(__dirname + '/../css/style.css', 'utf8');
    // 根变量已切到深蓝
    ok('--sidebar-bg = #1F4E79（深蓝侧栏）', /--sidebar-bg:\s*#1F4E79;/.test(css));
    ok('--primary = #1F4E79（深蓝主色，原#C8102E暖红已切）', /--primary:\s*#1F4E79;/.test(css));
    ok('--info = #2E75B6（中深蓝信息色，原#2C7A6B青绿已切）', /--info:\s*#2E75B6;/.test(css));
    // A 股配色保留（收入红/支出绿不能动）
    ok('--income = #C8102E（A股收入红保留）', /--income:\s*#C8102E;/.test(css));
    ok('--expense = #1F9D55（A股支出绿保留）', /--expense:\s*#1F9D55;/.test(css));
    // 全局 th 已用深蓝字+淡蓝底
    ok('全局 th 文字色 #1F4E79', /th\s*\{\s*color:\s*#1F4E79;/.test(css));
    ok('全局 th 底色 #DCE6F1', /th\s*\{[^}]*background:\s*#DCE6F1;/.test(css));
    // 流水表 th 用深蓝底白字（截图风格）
    ok('#txTable th 深蓝底白字', /#txTable th\s*\{[^}]*background:\s*#1F4E79;[^}]*color:\s*#fff;/.test(css));
    // PDF 打印表头同步深蓝
    ok('PDF 打印表头深蓝', /\.flow-print\s+\.fp-colhead th[^}]*background:\s*#1F4E79;/.test(css));
    // 侧栏 logo 渐变也切到蓝
    ok('brand-logo 渐变已切到蓝', /linear-gradient\(135deg,\s*#1F4E79/.test(css));
    // 顶栏 border-bottom 由金变蓝
    ok('topbar 边框已由金变蓝', /\.topbar\s*\{[^}]*border-bottom:\s*2px solid var\(--info\)/.test(css));
    // 暗的列宽拖拽背景也切到蓝
    ok('resizer hover 背景已切到蓝', /rgba\(46,117,182/.test(css));
    // 不再含旧墨绿/金色硬编码（关键的几处）
    ok('无旧墨绿 #14342B 残留', css.indexOf('#14342B') < 0);
    ok('无旧金色硬编码 #C9A227 残留（变量可保留为旧色但应不再使用——本次完全清掉）', css.indexOf('#C9A227') < 0);
    ok('无旧红浅底 #FBEAE2 残留', css.indexOf('#FBEAE2') < 0);
    ok('无旧金浅底 #F7ECCF 残留', css.indexOf('#F7ECCF') < 0);
    ok('无旧灰绿 #e8eeea 残留', css.indexOf('#e8eeea') < 0);
    ok('无旧淡灰绿 #f4f7f5 残留', css.indexOf('#f4f7f5') < 0);
    ok('无旧绿灰 hover #C2D9CD 残留', css.indexOf('#C2D9CD') < 0);

    console.log((fail ? 'SOME FAILED' : 'ALL_OK') + '  pass=' + pass + ' fail=' + fail);
    if (fail) process.exitCode = 1;
  })
  .catch(function (e) {
    console.log('  ✗ 异常: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  });
