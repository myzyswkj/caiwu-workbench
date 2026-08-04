// table_image 纯函数单测：验证 wrapText 折行与 _compute 布局（含凭证图行高）
var assert = require('assert');
var T = require('../js/table_image.js');

var pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 桩 measureText：等宽近似，每字符 7px（足以验证折行与布局数学）
function measure(s) { return { width: String(s).length * 7 }; }

console.log('[1] wrapText 折行');
(function () {
  var lines = T.wrapText(measure, '1234567890', 30); // 30/7≈4.28 → 每行 4 字
  ok('长文本被切分为多行', lines.length === 3);
  ok('拼接后还原原文本', lines.join('') === '1234567890');
  var one = T.wrapText(measure, 'abc', 100);
  ok('短文本单行', one.length === 1 && one[0] === 'abc');
  var nl = T.wrapText(measure, 'AB\nCD', 100);
  ok('显式换行保留为两行', nl.length === 2 && nl[0] === 'AB' && nl[1] === 'CD');
  var empty = T.wrapText(measure, '', 100);
  ok('空文本返回一行空串', empty.length === 1 && empty[0] === '');
})();

console.log('[2] _compute 基础布局（无图）');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '收入', '项目A', '销售', '微信', '+1,000.00', '得力', '张三', '一笔较长的备注内容用于测试自动折行效果是否正常，再加一句确保一定超过列宽触发换行', ''], amountCls: 'income' }];
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9 }, measure);
  var sumCol = head.length === 10 ? (92 + 60 + 110 + 84 + 120 + 116 + 140 + 76 + 180 + 220) : 0;
  ok('总宽 = 列宽和 + 2*marginX', g.totalW === sumCol + 32);
  ok('备注列被折成多行', g.rows[0].cellLines[8].length > 1);
  var textH = Math.max.apply(null, g.rows[0].cellLines.map(function (l) { return l.length; })) * 18 + 14;
  ok('行高 = 文本行高（无图）', g.rows[0].height === textH);
  ok('表头高度正确', g.headerH === 34);
})();

console.log('[3] _compute 含凭证图时行高≥图高');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '支出', '项目A', '采购', '支付宝', '-200.00', '供应商', '李四', '买物料', ''], amountCls: 'expense' }];
  // 单张横图 800x600，凭证列宽 220，picMaxH=120
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, pics: { 0: [{ w: 800, h: 600 }] }, picMaxW: 200, picMaxH: 120 }, measure);
  ok('凭证图被缩放且高度=120', Math.abs(g.rows[0].imgs[0].h - 120) < 0.001);
  ok('凭证图款宽在列内（≤ 列宽-16）', g.rows[0].imgs[0].w <= 220 - 16 + 0.001);
  ok('行高 ≥ 图片高 + 上下内边距', g.rows[0].height >= 120 + 14 - 0.001);
})();

console.log('[4] _compute 多张凭证图横向排开且不溢出');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '支出', '项目A', '采购', '支付宝', '-200.00', '供应商', '李四', '买物料', ''], amountCls: 'expense' }];
  var pics = [{ w: 800, h: 600 }, { w: 800, h: 600 }, { w: 800, h: 600 }];
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, pics: { 0: pics }, picMaxW: 200, picMaxH: 120 }, measure);
  var rg = g.rows[0];
  var totalW = rg.imgs.reduce(function (s, im) { return s + im.w; }, 0) + rg.imgGap * (rg.imgs.length - 1);
  ok('三张图全部布局', rg.imgs.length === 3);
  ok('三张图总宽 ≤ 凭证列可用宽(204)', totalW <= 204 + 0.01);
})();

console.log('[5] _compute 超宽单图被宽度上限裁剪');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['x', '支出', '', '', '', '', '', '', '', ''], amountCls: 'expense' }];
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, pics: { 0: [{ w: 2000, h: 100 }] }, picMaxW: 200, picMaxH: 120 }, measure);
  ok('超宽图宽度被压到 ≤ picMaxW', g.rows[0].imgs[0].w <= 200 + 0.001);
})();

console.log('[6] _compute 标题/KPI 占位');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['x', '收入', '', '', '', '', '', '', '', ''], amountCls: 'income' }];
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, title: '内账流水明细', subtitle: '账套：默认 | 期间：全部', kpis: [{ label: '笔数', value: '1' }, { label: '收入合计', value: '¥1,000', cls: 'income' }] }, measure);
  ok('有标题时 titleH=26', g.titleH === 26);
  ok('有 KPI 时 kpiH=52', g.kpiH === 52);
  ok('表格起始位置在顶部区块之下', g.tableTop > g.marginY);
  ok('总高包含表头与至少一行', g.totalH > g.tableTop + g.headerH);
})();

console.log('[7] _draw 用 mock canvas 实际绘制不抛异常且调用正确');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [
    { cells: ['2026-08-01', '收入', '项目A', '销售', '微信', '+1,000.00', '得力', '张三', '备注一行', ''], amountCls: 'income' },
    { cells: ['2026-08-02', '支出', '项目B', '采购', '支付宝', '-200.00', '供应商', '李四', '买物料', ''], amountCls: 'expense' }
  ];
  var cfg = {
    head: head, rows: rows, amountCol: 5, imgCol: 9,
    title: '内账流水明细',
    subtitle: '账套：默认 | 期间：全部 | 导出日期：2026-08-04',
    kpis: [{ label: '笔数', value: '2' }, { label: '收入合计', value: '¥1,000', cls: 'income' }],
    pics: { 1: [{ w: 800, h: 600, img: { _fake: true } }] },
    picMaxW: 200, picMaxH: 120
  };
  var geo = T._compute(cfg, measure);
  // mock 2D context：记录调用
  var calls = { fillText: 0, drawImage: 0, fillRect: 0, strokeRect: 0 };
  var mockCtx = {
    scale: function () {}, fillRect: function () { calls.fillRect++; }, strokeRect: function () { calls.strokeRect++; }, fill: function () { calls.fillRect++; },
    beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, stroke: function () {},
    fillText: function () { calls.fillText++; }, drawImage: function () { calls.drawImage++; },
    measureText: function (s) { return { width: String(s).length * 7 }; },
    roundRect: function () {}, arcTo: function () {}, closePath: function () {},
    set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set lineWidth(v) {}, set textBaseline(v) {}
  };
  var threw = false;
  try { T._draw(mockCtx, geo, cfg); } catch (e) { threw = true; console.log('  draw error: ' + e.message); }
  ok('绘制过程不抛异常', !threw);
  ok('标题/表头/数据均有文字绘制', calls.fillText >= head.length + rows.length);
  ok('含凭证图的行触发 drawImage', calls.drawImage === 1);
  ok('绘制了外边框 strokeRect', calls.strokeRect === 1);
})();

console.log('[8] _compute 含副表（按账户收支）几何');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['x', '收入', '', '', '', '', '', '', '', ''], amountCls: 'income' }];
  var sub = {
    title: '按账户（收支维度）',
    note: '注：开始余额 / 剩余余额为各账户资金余额（含期初、账户互转与股本变动）。互转 = 转入 − 转出（账户互转净头寸），单列不影响收支净额；剩余余额 = 开始余额 + 收入 − 支出 + 互转 + 股本净变动。' +
          '注：开始余额 / 剩余余额为各账户资金余额（含期初、账户互转与股本变动）。互转 = 转入 − 转出（账户互转净头寸），单列不影响收支净额；剩余余额 = 开始余额 + 收入 − 支出 + 互转 + 股本净变动。',
    head: ['账户', '开始余额', '收入', '支出', '互转（转入−转出）', '净额（收入−支出）', '剩余余额'],
    rows: [['现金', '¥1,000.00', '¥300.00', '¥120.00', '¥0.00', '¥180.00', '¥1,180.00'],
           ['微信', '¥500.00', '¥0.00', '¥50.00', '¥50.00', '−¥50.00', '¥500.00'],
           ['合计（2 账户）', '¥1,500.00', '¥300.00', '¥170.00', '¥50.00', '¥130.00', '¥1,680.00']],
    colWidths: [200, 180, 150, 150, 150, 150, 218],
    rightCols: [1, 2, 3, 4, 5, 6],
    colCls: ['neutral', 'signed', 'income', 'expense', 'signed', 'signed', 'signed'],
    totalRow: true,
    headerH: 30
  };
  var g = T._compute({ head: head, rows: rows, amountCol: 5, imgCol: 9, title: '内账流水明细', subtable: sub }, measure);
  ok('返回了副表几何', !!(g.subtable && g.subtable.head));
  ok('副表行数 = 数据行 + 合计行', g.subtable.rows.length === 3);
  ok('末行 isTotal 标记', g.subtable.rows[2].isTotal === true);
  ok('colCls 透传（收入列=income）', g.subtable.colCls[2] === 'income');
  ok('右对齐列透传', g.subtable.rightCols.indexOf(2) >= 0);
  ok('副表总宽 = 主表总宽（同宽）', Math.abs(g.subtable.tableW - (g.totalW - 32)) < 0.001);
  ok('主表起始位置被副表下推', g.tableTop > g.marginY + g.titleH);
  ok('长注脚被折成多行', g.subtable.noteLines.length > 1);
  ok('总高因副表而增大', g.totalH > g.tableTop + g.headerH);
})();

console.log('[9] _draw 含副表不抛异常且绘制了副表文字');
(function () {
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '收入', '项目A', '销售', '微信', '+1,000.00', '得力', '张三', '备注一行', ''], amountCls: 'income' }];
  var sub = {
    title: '按账户（收支维度）',
    note: '注：开始余额 / 剩余余额为各账户资金余额（含期初、账户互转与股本变动）。',
    head: ['账户', '开始余额', '收入', '支出', '互转（转入−转出）', '净额（收入−支出）', '剩余余额'],
    rows: [['现金', '¥1,000.00', '¥300.00', '¥120.00', '¥0.00', '¥180.00', '¥1,180.00'],
           ['合计（1 账户）', '¥1,000.00', '¥300.00', '¥120.00', '¥0.00', '¥180.00', '¥1,180.00']],
    colWidths: [200, 180, 150, 150, 150, 150, 218],
    rightCols: [1, 2, 3, 4, 5, 6],
    colCls: ['neutral', 'signed', 'income', 'expense', 'signed', 'signed', 'signed'],
    totalRow: true, headerH: 30
  };
  var cfg = {
    head: head, rows: rows, amountCol: 5, imgCol: 9, title: '内账流水明细',
    kpis: [{ label: '笔数', value: '1' }], subtable: sub, pics: {}
  };
  var geo = T._compute(cfg, measure);
  var calls = { fillText: 0, drawImage: 0, fillRect: 0, strokeRect: 0 };
  var mockCtx = {
    scale: function () {}, fillRect: function () { calls.fillRect++; }, strokeRect: function () { calls.strokeRect++; }, fill: function () { calls.fillRect++; },
    beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, stroke: function () {},
    fillText: function () { calls.fillText++; }, drawImage: function () { calls.drawImage++; },
    measureText: function (s) { return { width: String(s).length * 7 }; },
    roundRect: function () {}, arcTo: function () {}, closePath: function () {},
    set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set lineWidth(v) {}, set textBaseline(v) {}
  };
  var threw = false;
  try { T._draw(mockCtx, geo, cfg); } catch (e) { threw = true; console.log('  draw error: ' + e.message); }
  ok('含副表绘制不抛异常', !threw);
  // 副表至少含：标题1 + 表头7 + 数据2 = 10 个文字；主表至少 表头10 + 数据1
  ok('绘制了副表与正表的文字', calls.fillText >= 10 + 11);
})();

console.log('[10] render() 端到端会把 subtable 透传给 _compute 并真正绘制（回归：曾漏传 subtable 导致副表/互转不显示）');
(function () {
  // 最小化 mock DOM（node 无真实 canvas）：createElement('canvas') 返回带 mock ctx 的对象
  var fillTexts = [];
  function makeCtx() {
    return {
      scale: function () {}, fillRect: function () {}, strokeRect: function () {},
      fill: function () {}, stroke: function () {}, beginPath: function () {}, moveTo: function () {},
      lineTo: function () {}, arcTo: function () {}, closePath: function () {}, roundRect: function () {},
      drawImage: function () {},
      measureText: function (s) { return { width: String(s).length * 7 }; },
      fillText: function (t) { fillTexts.push(String(t)); },
      set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set lineWidth(v) {}, set textBaseline(v) {}
    };
  }
  var canvasObj = { width: 0, height: 0, getContext: function () { return makeCtx(); }, toDataURL: function () { return 'data:image/png;base64,'; } };
  global.document = { documentElement: {}, createElement: function (tag) { return tag === 'canvas' ? canvasObj : {}; }, createElementNS: function () { return {}; }, body: { appendChild: function () {}, removeChild: function () {} } };
  // 不定义 getComputedStyle → render 内 try/catch 兜底用默认色

  var sub = {
    title: '按账户（收支维度）',
    note: '注：开始时间余额 = 筛选开始前的账户余额；当前余额（净额） = 开始时间余额 + 收入 − 支出 + 互转 + 股本净变动，即筛选期末的真实账户余额。互转 = 转入 − 转出（账户互转净头寸），单列不影响收支净额。',
    head: ['账户', '开始时间余额', '收入', '支出', '互转（转入−转出）', '当前余额（净额）'],
    rows: [['现金', '¥1,000', '¥300', '¥120', '¥0', '¥1,180'],
           ['合计（1 账户）', '¥1,000', '¥300', '¥120', '¥0', '¥1,180']],
    colWidths: [200, 180, 150, 150, 150, 218],
    rightCols: [1, 2, 3, 4, 5],
    colCls: ['neutral', 'signed', 'income', 'expense', 'signed', 'signed'],
    totalRow: true, headerH: 30
  };
  var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
  var rows = [{ cells: ['2026-08-01', '收入', 'A', '销售', '微信', '+1,000', '得力', '张三', '备注', ''], amountCls: 'income' }];

  var finished = false;
  function doneOnce() { if (finished) return; finished = true; console.log(''); console.log('PASS ' + pass + ' / FAIL ' + fail); if (fail) process.exit(1); }

  try {
    T.render({
      title: '内账流水明细',
      kpis: [{ label: '笔数', value: '1' }],
      head: head, rows: rows, amountCol: 5, imgCol: 9,
      subtable: sub, pics: {}
    }).then(function (canvas) {
      ok('render 路径绘制了副表标题「按账户（收支维度）」', fillTexts.indexOf('按账户（收支维度）') >= 0);
      ok('render 路径绘制了「互转（转入−转出）」列标题', fillTexts.indexOf('互转（转入−转出）') >= 0);
      ok('render 路径绘制了「开始时间余额」列标题', fillTexts.indexOf('开始时间余额') >= 0);
      ok('render 路径绘制了「当前余额（净额）」列标题', fillTexts.indexOf('当前余额（净额）') >= 0);
      ok('render 返回了 canvas 对象', !!canvas);
      doneOnce();
    }).catch(function (e) {
      console.log('  render rejected: ' + (e && e.message));
      fail++; console.log('  ✗ render() 端到端执行');
      doneOnce();
    });
  } catch (e) {
    console.log('  sync error: ' + e.message);
    fail++; console.log('  ✗ render() 端到端执行');
    doneOnce();
  }
})();
