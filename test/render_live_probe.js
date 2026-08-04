// 探测真实 render 链路（node 环境用最小 document/canvas shim）
// 目标：复现浏览器里 preview/download 无反应的真实报错
var assert = require('assert');

// ---- 最小 DOM / canvas shim ----
function makeCtx() {
  return {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textBaseline: '',
    measureText: function (s) { return { width: String(s).length * 7 }; },
    fillText: function () {}, strokeText: function () {},
    fillRect: function () {}, strokeRect: function () {}, clearRect: function () {},
    beginPath: function () {}, closePath: function () {}, moveTo: function () {},
    lineTo: function () {}, stroke: function () {}, fill: function () {},
    arcTo: function () {}, rect: function () {}, scale: function () {},
    save: function () {}, restore: function () {}, translate: function () {},
    roundRect: function () {}, clip: function () {}, drawImage: function () {}
  };
}
function makeCanvas() {
  var c = {
    width: 0, height: 0, style: {},
    getContext: function () { return makeCtx(); },
    toBlob: function (cb, type) { cb({ size: 1, type: type || 'image/png' }); },
    toDataURL: function () { return 'data:image/png;base64,AAAA'; }
  };
  return c;
}
global.document = {
  documentElement: {},
  createElement: function (tag) { return tag === 'canvas' ? makeCanvas() : { style: {}, appendChild: function () {}, click: function () {}, setAttribute: function () {}, getContext: function () { return makeCtx(); } }; },
  body: { appendChild: function () {}, removeChild: function () {} }
};
global.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
global.Image = function () { return { set src(v) {}, onload: null, onerror: null }; };
global.URL = { createObjectURL: function () { return 'blob:probe'; }, revokeObjectURL: function () {} };

var T = require('../js/table_image.js');

var head = ['日期', '类型', '项目', '分类', '账户', '金额', '对方单位/个人', '报销人', '备注', '凭证'];
var rows = [
  { cells: ['2026-08-01', '收入', '项目A', '销售', '微信', '+1,000.00', '得力', '张三', '一笔较长的备注内容用于测试自动折行效果是否正常，再加一句确保一定超过列宽触发换行', ''], amountCls: 'income' },
  { cells: ['2026-08-02', '支出', '项目B', '采购', '支付宝', '-200.00', '供应商', '李四', '买物料', ''], amountCls: 'expense' }
];
var subtable = {
  title: '按账户（收支维度）',
  note: '注：开始时间余额 = 筛选开始前的账户余额；当前余额（净额） = 开始时间余额 + 收入 − 支出 + 互转 + 股本净变动。',
  head: ['账户', '开始时间余额', '收入', '支出', '互转（转入−转出）', '当前余额（净额）'],
  rows: [['微信', '¥0.00', '¥1,000.00', '¥0.00', '¥0.00', '¥1,000.00'], ['合计（1 账户）', '¥0.00', '¥1,000.00', '¥0.00', '¥0.00', '¥1,000.00']],
  colWidths: [276, 258, 232, 232, 264, 290],
  rightCols: [1, 2, 3, 4, 5],
  colCls: ['neutral', 'signed', 'income', 'expense', 'signed', 'signed'],
  totalRow: true, headerH: 50
};

[1, 1.35, 1.8, 2.4].forEach(function (fs) {
  var cfg = {
    title: '内账流水明细',
    subtitle: '账套：默认 | 期间：全部期间 | 导出日期：2026-08-04',
    kpis: [{ label: '笔数', value: '2' }, { label: '收入合计', value: '¥1,000.00', cls: 'income' }, { label: '支出合计', value: '¥200.00', cls: 'expense' }, { label: '净额（收入−支出）', value: '¥800.00' }],
    head: head, rows: rows, colWidths: [124, 84, 144, 114, 156, 148, 184, 106, 224, 268],
    amountCol: 5, imgCol: 9, pics: {}, picMaxW: 220, picMaxH: 130, gap: 8, fontScale: fs, subtable: subtable
  };
  T.render(cfg).then(function (canvas) {
    console.log('  ✓ render fs=' + fs + ' OK  canvas=' + canvas.width + 'x' + canvas.height);
    // 顺便探 downloadPNG 是否抛错
    T.downloadPNG(canvas, 'probe.png');
    console.log('  ✓ downloadPNG fs=' + fs + ' OK');
  }).catch(function (e) {
    console.log('  ✗ render fs=' + fs + ' REJECTED: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  });
});
