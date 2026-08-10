// 打印 / PDF 预览：列宽改为「拖拽表头列边界」调节（像 Excel），可单独拉宽/拉窄任意一列，
// 每列宽度数组持久化到 fw_pref_print_colw，并提供「重置列宽」按钮恢复默认。
// 关键前提：打印表 #fpDetailTable 已设 table-layout:fixed + 精确内联列宽（否则列宽不生效）。
// 本测试锁定：
//   1. 表头每个 th 含独立拖拽手柄 .fp-col-resizer（数量 = 列数）
//   2. 初始整表 width == 各列 width 之和（列宽精确生效，fixed 布局）
//   3. 模拟拖拽第 0 列手柄：该列宽度按鼠标位移增加、整表 width 同步、localStorage 写入数组
//   4. 点击「重置列宽」：列宽恢复屏幕默认值（凭证列保底 150、金额列保底 100）、localStorage 被清除
//   5. 源码 / CSS 静态守卫：含 fp-col-resizer、fw_pref_print_colw；不再含旧的整表缩放滑块 fpColScale
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('./setup').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="topActions"></div><div id="content"><div id="inOverview"></div><div id="inBody"></div></div></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.TextDecoder = dom.window.TextDecoder;
global.confirm = function () { return true; };
var _store = {};
global.localStorage = {
  getItem: function (k) { return k in _store ? _store[k] : null; },
  setItem: function (k, v) { _store[k] = String(v); },
  removeItem: function (k) { delete _store[k]; },
  clear: function () { _store = {}; }
};

var modalBodies = [];
var capturedHtml = null;
global.FW = global.window.FW = {
  db: {
    _d: { internal: [], internal_cats: [] },
    getList: function (k) { return (this._d[k] || []).slice(); },
    saveList: function (k, v) { this._d[k] = v.slice(); },
    upsert: function (k, r) { var a = this._d[k] || (this._d[k] = []); if (!r.id) r.id = 't_' + Math.random(); a.push(r); },
    getById: function (k, id) { return (this._d[k] || []).filter(function (x) { return x.id === id; })[0]; },
    savePhoto: function () { return Promise.resolve('p1'); },
    getPhoto: function () { return Promise.resolve(null); },
    getLedgers: function () { return [{ id: 'L1', name: '默认账套' }]; },
    getCurrentLedger: function () { return 'L1'; }
  },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; },
  esc2: function (s) { return s; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {},
  today: function () { return '2026-07-30'; },
  openModal: function (title, html, cb) {
    capturedHtml = html;
    var mb = document.createElement('div');
    mb.innerHTML = html;
    modalBodies.push(mb);
    if (cb) cb(mb);
  },
  closeModal: function () {},
  qa: function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
};

// 屏幕列宽 mock：模拟 11 列的真实渲染宽度
var RENDERED = { 0: 92, 1: 84, 2: 90, 3: 96, 4: 88, 5: 110, 6: 148, 7: 96, 8: 112, 9: 84, 10: 108 };
dom.window.Element.prototype.getBoundingClientRect = function () {
  var dcol = this.getAttribute && this.getAttribute('data-col');
  var w = (dcol != null && RENDERED[dcol] != null) ? RENDERED[dcol] : 0;
  return { width: w, height: 20, top: 0, left: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: function () {} };
};

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

FW.db.upsert('internal', { id: 't_demo', date: '2026-07-30', type: 'expense', project: '办公采购', category: '采购', account: '微信', amount: 520, party: '得力', reimburser: '王五', remark: '买打印纸', photos: [] });
FW.modules.internal.render();

var printBtn = document.querySelector('#expTxMenu button[data-fmt="print"]');
assert.ok(printBtn, '应存在打印按钮');

function parseTable(mb) {
  var t = mb.querySelector('#fpDetailTable');
  var w = parseInt((t.style.width || '').match(/(\d+)px/)[1], 10);
  var cols = Array.prototype.slice.call(t.querySelectorAll('colgroup col'));
  var cw = cols.map(function (c) { return parseInt((c.style.width || '').match(/(\d+)px/)[1], 10); });
  return { w: w, cw: cw, sum: cw.reduce(function (a, b) { return a + b; }, 0), n: cw.length };
}
function mouse(type, target, x) {
  var ev = new dom.window.MouseEvent(type, { clientX: x, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
}

// ========== 1) 表头每个 th 含独立拖拽手柄 .fp-col-resizer ==========
printBtn.onclick({ stopPropagation: function () {} });
assert.ok(capturedHtml, '点击打印应捕获 modalHtml');
assert.ok(/fp-col-resizer/.test(capturedHtml), '表头必须含列边界拖拽手柄 .fp-col-resizer');

var mb1 = modalBodies[modalBodies.length - 1];
var resizers = mb1.querySelectorAll('.fp-col-resizer');
var table1 = mb1.querySelector('#fpDetailTable');
assert.ok(table1, '明细表必须存在');
var pInit = parseTable(mb1);
assert.ok(resizers.length === pInit.n, '拖拽手柄数量必须等于列数（resizers=' + resizers.length + ' cols=' + pInit.n + '）');

// ========== 2) 初始：整表 width == 各列 width 之和（列宽精确生效） ==========
assert.ok(pInit.w > 0, '初始整表 width 必须 > 0，实际=' + pInit.w);
assert.strictEqual(pInit.w, pInit.sum, '整表 width 必须等于各列 width 之和（fixed 精确列宽），w=' + pInit.w + ' sum=' + pInit.sum);

// ========== 3) 模拟拖拽第 0 列手柄：右移 60px → 该列 +60、整表同步、持久化 ==========
var rz0 = mb1.querySelector('.fp-col-resizer[data-col="0"]');
assert.ok(rz0, '第 0 列拖拽手柄必须存在');
var w0before = pInit.cw[0];
mouse('mousedown', rz0, 100);
mouse('mousemove', dom.window.document, 160); // 位移 +60
mouse('mouseup', dom.window.document, 160);
var pDrag = parseTable(mb1);
assert.strictEqual(pDrag.cw[0], w0before + 60, '拖拽后第 0 列宽度应 +60（before=' + w0before + ' after=' + pDrag.cw[0] + '）');
assert.strictEqual(pDrag.w, pDrag.sum, '拖拽后整表 width 仍应等于各列之和');
assert.strictEqual(pDrag.w, pInit.w + 60, '拖拽后整表宽度应增加 60（init=' + pInit.w + ' after=' + pDrag.w + '）');
var savedArr = JSON.parse(_store['fw_pref_print_colw'] || 'null');
assert.ok(Array.isArray(savedArr) && savedArr.length === pInit.n, '拖拽后必须持久化列宽数组到 fw_pref_print_colw');
assert.strictEqual(savedArr[0], w0before + 60, '持久化数组第 0 列应等于拖拽后宽度');

// ========== 4) 点击「重置列宽」：恢复屏幕默认值，清除持久化 ==========
var resetBtn = mb1.querySelector('#fpResetColW');
assert.ok(resetBtn, '必须存在「重置列宽」按钮');
resetBtn.onclick();
var pReset = parseTable(mb1);
// 默认：第 5 列（金额）保底 100、第 7 列（凭证）保底 150、第 0 列（日期）= 屏幕 92
assert.strictEqual(pReset.cw[0], RENDERED[0], '重置后第 0 列应回到屏幕默认 ' + RENDERED[0] + '，实际=' + pReset.cw[0]);
assert.strictEqual(pReset.cw[5], 110 > 100 ? 110 : 110, '重置后金额列应保底 110，实际=' + pReset.cw[5]);
assert.strictEqual(pReset.cw[7], 150, '重置后凭证列应保底 150，实际=' + pReset.cw[7]);
assert.strictEqual(_store['fw_pref_print_colw'], undefined, '重置后必须清除 localStorage 的 fw_pref_print_colw');

// ========== 5) static source / css guard ==========
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');
assert.ok(/fp-col-resizer/.test(src), '源码必须包含 fp-col-resizer 手柄');
assert.ok(/fw_pref_print_colw/.test(src), '源码必须包含持久化键 fw_pref_print_colw');
assert.ok(!/fpColScale/.test(src), '旧的整体缩放滑块 fpColScale 必须已移除');
var css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
assert.ok(/\.fp-col-resizer\s*\{/.test(css), 'CSS 必须定义 .fp-col-resizer 手柄样式');
assert.ok(/#fpDetailTable\s*\{\s*table-layout:\s*fixed/.test(css), 'CSS 必须给 #fpDetailTable 设 table-layout:fixed');
assert.ok(/fpResetColW/.test(src), '源码必须包含「重置列宽」按钮 id');

console.log('ALL_OK  print_colwidth: 拖拽手柄就位、初始列宽精确、拖拽改宽+持久化、重置恢复默认、fixed 前提就位');
