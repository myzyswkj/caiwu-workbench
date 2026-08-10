// 打印 / PDF 预览：新增「打印密度」旋钮（紧凑 / 标准 / 宽松），
// 用于调整整张表的 padding + 字号，解决用户反馈"打印的间隔不好看"。
// 该测试锁定：
//   1. 工具栏含 #fpDensity <select>，三个 option 依次为 dpd-c / dpd-s / dpd-l
//   2. 切换密度后 .flow-print 容器正确加 / 去 dpd-* class
//   3. 用户选择持久化到 localStorage（fw_pref_print_density）
//   4. 下次 openPrintView 打开时自动还原上次选择
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

// mock FW：截下 modalHtml 同时把内容塞进一个真实 DOM 容器，传给 onMount 回调
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

// ========== 1) 工具栏必须含 #fpDensity select 且三个 option 完整 ==========
printBtn.onclick({ stopPropagation: function () {} });
assert.ok(capturedHtml, '点击打印应捕获 modalHtml');
assert.ok(/id="fpDensity"/.test(capturedHtml), '弹窗工具栏必须包含 #fpDensity select');
assert.ok(/<option value="dpd-c">紧凑<\/option>/.test(capturedHtml), '必须含紧凑 option（dpd-c）');
assert.ok(/<option value="dpd-s" selected>标准<\/option>/.test(capturedHtml), '必须含标准 option（dpd-s，default）');
assert.ok(/<option value="dpd-l">宽松<\/option>/.test(capturedHtml), '必须含宽松 option（dpd-l）');

// 取第一次 openPrintView 创建的 modal body（其内部 onchange/onclick 都已被闭包绑定）
var mb1 = modalBodies[modalBodies.length - 1];
var denSel1 = mb1.querySelector('#fpDensity');
var wrap1 = mb1.querySelector('.flow-print');
assert.ok(denSel1, '密度 select 必须能选中（第一次打开）');
assert.ok(wrap1, '.flow-print 容器必须能选中（第一次打开）');

// ========== 2) 切密度：wrap + class、localStorage ==========
function fireChange(sel, value) {
  sel.value = value;
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

fireChange(denSel1, 'dpd-c');
assert.ok(wrap1.classList.contains('dpd-c'), '切到 dpd-c 后 wrap 必须含 dpd-c；当前 classList=' + wrap1.className);
assert.ok(!wrap1.classList.contains('dpd-s'), '切到 dpd-c 后 wrap 必须去掉 dpd-s');
assert.ok(!wrap1.classList.contains('dpd-l'), '切到 dpd-c 后 wrap 必须去掉 dpd-l');
assert.strictEqual(_store['fw_pref_print_density'], 'dpd-c', '切到 dpd-c 必须写入 localStorage');

fireChange(denSel1, 'dpd-l');
assert.ok(wrap1.classList.contains('dpd-l'), '切到 dpd-l 后 wrap 必须含 dpd-l');
assert.ok(!wrap1.classList.contains('dpd-c'), '切到 dpd-l 后旧 dpd-c 必须去掉');
assert.strictEqual(_store['fw_pref_print_density'], 'dpd-l', '切到 dpd-l 后必须更新 localStorage');

// ========== 3) 预置偏好为 dpd-c 后再打开：wrap 自动还原成 dpd-c ==========
_store['fw_pref_print_density'] = 'dpd-c';
printBtn.onclick({ stopPropagation: function () {} });
var mb2 = modalBodies[modalBodies.length - 1];
var wrap2 = mb2.querySelector('.flow-print');
assert.ok(wrap2, '第二次打开必须重建 .flow-print 容器');
assert.ok(wrap2.classList.contains('dpd-c'),
  '再次打开打印预览时，若用户上次选过 dpd-c，必须自动还原成 dpd-c；当前 className=' + wrap2.className);

// ========== 4) static source guard ==========
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');
assert.ok(/fw_pref_print_density/.test(src), '源码必须包含持久化键 fw_pref_print_density');
assert.ok(/classList\.add\(v\)/.test(src), '源码必须包含密度 class 切换逻辑');

console.log('ALL_OK  print_density: 工具栏有 #fpDensity、切档正常加/去 dpd-* class、localStorage 记忆、二次打开自动还原');
