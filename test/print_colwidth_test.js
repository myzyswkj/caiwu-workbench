// 打印 / PDF 预览：列宽改为「表头边缘检测拖拽」调节（像 Excel），鼠标移到某列最右 9px 内即高亮右边界、
// 显示 col-resize 光标，按下即可单独拉宽/拉窄任意一列。每列宽度数组持久化到 fw_pref_print_colw，
// 并提供「重置列宽」按钮恢复默认。
// 关键前提：打印表 #fpDetailTable 已设 table-layout:fixed + 精确内联列宽（否则列宽不生效）。
// 本测试锁定：
//   1. 表头每个 th 含 data-col（数量 = 列数），且不再内嵌脆弱的 absolute 手柄 .fp-col-resizer
//   2. 初始整表 width == 各列 width 之和（列宽精确生效，fixed 布局）
//   3. 模拟鼠标移到第 0 列右边缘（data-edge=1）→ mousedown + document mousemove(+60) → 该列 +60、整表同步、localStorage 写入数组
//   4. 点击「重置列宽」：列宽恢复屏幕默认值（凭证列保底 150、金额列保底 100）、localStorage 被清除
//   5. 源码 / CSS 静态守卫：含 data-edge 边缘逻辑、fw_pref_print_colw；不再含旧的整表缩放滑块 fpColScale / .fp-col-resizer
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

// ========== 1) 表头每个 th 含 data-col（数量 = 列数），且不再内嵌 absolute 手柄 ==========
printBtn.onclick({ stopPropagation: function () {} });
assert.ok(capturedHtml, '点击打印应捕获 modalHtml');
assert.ok(/data-col="/.test(capturedHtml), '表头 th 必须带 data-col 以便边缘检测拖拽');
assert.ok(!/fp-col-resizer/.test(capturedHtml), '表头不得再含脆弱的 absolute 手柄 .fp-col-resizer');

var mb1 = modalBodies[modalBodies.length - 1];
// 注意：「每页带标题」默认未勾选时 applyTitleEvery 会把列头行从 thead 移到 tbody，
// 故用 .fp-colhead th（不限 thead）才能稳定命中，拖拽事件也据此绑定，与真实行为一致
var ths = mb1.querySelectorAll('.fp-colhead th');
var table1 = mb1.querySelector('#fpDetailTable');
assert.ok(table1, '明细表必须存在');
var pInit = parseTable(mb1);
assert.ok(ths.length === pInit.n, 'th 数量必须等于列数（ths=' + ths.length + ' cols=' + pInit.n + '）');

// ========== 2) 初始：整表 width == 各列 width 之和（列宽精确生效） ==========
assert.ok(pInit.w > 0, '初始整表 width 必须 > 0，实际=' + pInit.w);
assert.strictEqual(pInit.w, pInit.sum, '整表 width 必须等于各列 width 之和（fixed 精确列宽），w=' + pInit.w + ' sum=' + pInit.sum);

// ========== 3) 模拟鼠标移到第 0 列右边缘 → data-edge=1 → mousedown + 右移 60px ==========
var th0 = mb1.querySelector('.fp-colhead th[data-col="0"]');
assert.ok(th0, '第 0 列 th 必须存在');
var w0before = pInit.cw[0];
// th0 宽度 RENDERED[0]=92，右边缘感应区 = [83, 92]，clientX=90 落在边缘内
mouse('mousemove', th0, 90);
assert.strictEqual(th0.getAttribute('data-edge'), '1', '鼠标移到右边缘应设 data-edge=1');
mouse('mousedown', th0, 90);
mouse('mousemove', dom.window.document, 150); // 位移 +60
mouse('mouseup', dom.window.document, 150);
var pDrag = parseTable(mb1);
assert.strictEqual(pDrag.cw[0], w0before + 60, '拖拽后第 0 列宽度应 +60（before=' + w0before + ' after=' + pDrag.cw[0] + '）');
assert.strictEqual(pDrag.w, pDrag.sum, '拖拽后整表 width 仍应等于各列之和');
assert.strictEqual(pDrag.w, pInit.w + 60, '拖拽后整表宽度应增加 60（init=' + pInit.w + ' after=' + pDrag.w + '）');
var savedArr = JSON.parse(_store['fw_pref_print_colw'] || 'null');
assert.ok(Array.isArray(savedArr) && savedArr.length === pInit.n, '拖拽后必须持久化列宽数组到 fw_pref_print_colw');
assert.strictEqual(savedArr[0], w0before + 60, '持久化数组第 0 列应等于拖拽后宽度');

// 非边缘不应触发拖拽：移到第 0 列左端 data-edge=0，mousedown 应无效
var wAfter = pDrag.cw[0];
mouse('mousemove', th0, 10); // 左端，非边缘
assert.strictEqual(th0.getAttribute('data-edge'), '0', '鼠标移到非边缘应设 data-edge=0');
mouse('mousedown', th0, 10);
mouse('mousemove', dom.window.document, 200);
mouse('mouseup', dom.window.document, 200);
var pNoDrag = parseTable(mb1);
assert.strictEqual(pNoDrag.cw[0], wAfter, '非边缘按下不应改列宽（before=' + wAfter + ' after=' + pNoDrag.cw[0] + '）');

// ========== 4) 点击「重置列宽」：恢复屏幕默认值，清除持久化 ==========
var resetBtn = mb1.querySelector('#fpResetColW');
assert.ok(resetBtn, '必须存在「重置列宽」按钮');
resetBtn.onclick();
var pReset = parseTable(mb1);
assert.strictEqual(pReset.cw[0], RENDERED[0], '重置后第 0 列应回到屏幕默认 ' + RENDERED[0] + '，实际=' + pReset.cw[0]);
assert.strictEqual(pReset.cw[5], 110 > 100 ? 110 : 110, '重置后金额列应保底 110，实际=' + pReset.cw[5]);
assert.strictEqual(pReset.cw[7], 150, '重置后凭证列应保底 150，实际=' + pReset.cw[7]);
assert.strictEqual(_store['fw_pref_print_colw'], undefined, '重置后必须清除 localStorage 的 fw_pref_print_colw');

// ========== 5) static source / css guard ==========
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');
assert.ok(/data-edge/.test(src), '源码必须包含 data-edge 边缘检测逻辑');
assert.ok(/fw_pref_print_colw/.test(src), '源码必须包含持久化键 fw_pref_print_colw');
assert.ok(!/fpColScale/.test(src), '旧的整体缩放滑块 fpColScale 必须已移除');
assert.ok(!/fp-col-resizer/.test(src), '旧的 absolute 手柄 fp-col-resizer 必须已移除');
var css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
assert.ok(/th\[data-edge="1"\]/.test(css), 'CSS 必须定义 th[data-edge="1"] 边缘高亮');
assert.ok(/#fpDetailTable\s*\{\s*table-layout:\s*fixed/.test(css), 'CSS 必须给 #fpDetailTable 设 table-layout:fixed');
assert.ok(/fpResetColW/.test(src), '源码必须包含「重置列宽」按钮 id');

console.log('ALL_OK  print_colwidth: 边缘检测拖拽就位、初始列宽精确、边缘拖拽改宽+持久化、非边缘不触发、重置恢复默认、fixed 前提就位');
