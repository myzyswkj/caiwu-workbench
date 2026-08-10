// 打印 / PDF 预览：新增「列宽」滑块（80%–160%，默认 100%），实时缩放明细表各列宽度，
// 解决用户反馈"打印间隔不好看 / 列太窄文字竖排（凭证 5 张、分类 员工福利）"。
// 关键根因：打印表之前没设 table-layout:fixed，colgroup 列宽只是建议值被浏览器按内容重排，
//          所以调行高/字号都没用。现改为 fixed 精确列宽 + 滑块缩放。
// 本测试锁定：
//   1. 工具栏含 #fpColScale range（min=80 max=160 value=100）与百分比显示 #fpColScaleVal
//   2. 初始整表 width == 各列 width 之和（说明列宽被精确生效，而非被内容重排）
//   3. 拖动滑块到 140%：每列宽度按比例放大、整表 width 同步放大、百分比文本更新、localStorage 记忆
//   4. 预置偏好 130% 后再次打开：滑块自动还原为 130%、整表宽度按 1.3 倍还原
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
  // 用 CSSOM（style.width）读取，避免 jsdom 序列化 style 属性带空格导致正则失败
  var w = parseInt((t.style.width || '').match(/(\d+)px/)[1], 10);
  var cols = Array.prototype.slice.call(t.querySelectorAll('colgroup col'));
  var cw = cols.map(function (c) {
    return parseInt((c.style.width || '').match(/(\d+)px/)[1], 10);
  });
  return { w: w, cw: cw, sum: cw.reduce(function (a, b) { return a + b; }, 0), n: cw.length };
}
function fireInput(el, value) {
  el.value = String(value);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

// ========== 1) 工具栏必须含 #fpColScale range + #fpColScaleVal ==========
printBtn.onclick({ stopPropagation: function () {} });
assert.ok(capturedHtml, '点击打印应捕获 modalHtml');
assert.ok(/id="fpColScale"/.test(capturedHtml), '工具栏必须包含列宽滑块 #fpColScale');
assert.ok(/id="fpColScaleVal"/.test(capturedHtml), '工具栏必须包含列宽百分比显示 #fpColScaleVal');
assert.ok(/<input type="range"[^>]*id="fpColScale"[^>]*min="80"[^>]*max="160"[^>]*value="100"/.test(capturedHtml),
  '滑块必须 min=80 max=160 value=100');

var mb1 = modalBodies[modalBodies.length - 1];
var scaleSel1 = mb1.querySelector('#fpColScale');
var scaleVal1 = mb1.querySelector('#fpColScaleVal');
var table1 = mb1.querySelector('#fpDetailTable');
assert.ok(scaleSel1, '列宽滑块必须能选中（第一次打开）');
assert.ok(table1, '#fpDetailTable 必须存在（第一次打开）');

// ========== 2) 初始：整表 width == 各列 width 之和（列宽精确生效） ==========
var p0 = parseTable(mb1);
assert.ok(p0.w > 0, '初始整表 width 必须 > 0，实际=' + p0.w);
assert.strictEqual(p0.w, p0.sum, '整表 width 必须等于各列 width 之和（fixed 精确列宽），w=' + p0.w + ' sum=' + p0.sum);
assert.strictEqual(scaleVal1.textContent, '100%', '初始百分比显示应为 100%，实际=' + scaleVal1.textContent);

// ========== 3) 拖动到 140%：放大 + 记忆 ==========
fireInput(scaleSel1, 140);
var p1 = parseTable(mb1);
assert.strictEqual(p1.w, p1.sum, '放大后整表 width 仍应等于各列之和');
// 放大后整表宽度应在 1.35~1.45 倍之间（含四舍五入误差）
assert.ok(p1.w >= Math.round(p0.w * 1.35) && p1.w <= Math.round(p0.w * 1.45),
  '放大到 140% 后整表宽度应约为 1.4 倍，p0=' + p0.w + ' p1=' + p1.w);
assert.strictEqual(scaleVal1.textContent, '140%', '放大后百分比应显示 140%，实际=' + scaleVal1.textContent);
assert.strictEqual(_store['fw_pref_print_colscale'], '140', '放大到 140% 必须写入 localStorage');

// ========== 4) 预置 130% 再次打开：自动还原 ==========
_store['fw_pref_print_colscale'] = '130';
printBtn.onclick({ stopPropagation: function () {} });
var mb2 = modalBodies[modalBodies.length - 1];
var scaleSel2 = mb2.querySelector('#fpColScale');
var table2 = mb2.querySelector('#fpDetailTable');
assert.ok(scaleSel2, '第二次打开必须含列宽滑块');
assert.strictEqual(scaleSel2.value, '130', '再次打开应自动还原滑块为 130%，实际=' + scaleSel2.value);
var p2 = parseTable(mb2);
assert.strictEqual(p2.w, p2.sum, '还原后整表 width 仍应等于各列之和');
assert.ok(p2.w >= Math.round(p0.w * 1.25) && p2.w <= Math.round(p0.w * 1.35),
  '还原 130% 后整表宽度应约为 1.3 倍，p0=' + p0.w + ' p2=' + p2.w);

// ========== 5) static source guard ==========
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');
assert.ok(/fw_pref_print_colscale/.test(src), '源码必须包含持久化键 fw_pref_print_colscale');
assert.ok(/fpColScale/.test(src), '源码必须包含列宽滑块 id fpColScale');
var css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
assert.ok(/#fpDetailTable\s*\{\s*table-layout:\s*fixed/.test(css), 'CSS 必须给 #fpDetailTable 设 table-layout:fixed（列宽精确生效前提）');

console.log('ALL_OK  print_colwidth: 列宽滑块存在、初始列宽精确、140% 放大+记忆、130% 自动还原、fixed 前提就位');
