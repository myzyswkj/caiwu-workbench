// 导出宽度 = 屏幕真实渲染宽度（杜绝"屏幕撑开、导出压碎"的视觉欺骗）
// 端到端：构造一个表头 th 被 max-content 撑开（> 存储窄宽）的场景，
// 断言 screenColPx() 返回渲染宽度，而非 localStorage 里用户拖拽的窄字面宽。
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('./setup').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><head><style>' + fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8') + '</style></head><body><div id="topActions"></div><div id="content"><div id="inOverview"></div><div id="inBody"></div></div></body></html>', {
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

global.FW = global.window.FW = {
  db: { _d: {}, getList: function (k) { return (this._d[k] || (this._d[k] = [])).slice(); }, saveList: function (k, v) { this._d[k] = v.slice(); }, upsert: function (k, r) { var a = this._d[k] || (this._d[k] = []); if (!r.id) r.id = 't_' + Math.random(); a.push(r); }, getById: function (k, id) { return (this._d[k] || []).filter(function (x) { return x.id === id; })[0]; }, savePhoto: function () { return Promise.resolve('p1'); } },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; },
  esc2: function (s) { return s; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {}, today: function () { return '2026-07-30'; }, openModal: function () {}, closeModal: function () {},
  qa: function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
};

// 模拟 max-content 把窄列撑开后的真实渲染宽度（单位 px）
// 其中 项目(2)=90、金额(5)=110 明显大于用户在 localStorage 里拖拽的窄字面宽，用于证明"渲染宽度胜出"
var RENDERED = { 0: 92, 1: 84, 2: 90, 3: 96, 4: 88, 5: 110, 6: 148, 7: 96, 8: 112, 9: 84, 10: 108 };
dom.window.Element.prototype.getBoundingClientRect = function () {
  var dcol = this.getAttribute && this.getAttribute('data-col');
  var w = (dcol != null && RENDERED[dcol] != null) ? RENDERED[dcol] : 0;
  return { width: w, height: 20, top: 0, left: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: function () {} };
};

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

// 模拟用户把"项目""金额"两列拖到很窄（字面 24 / 30），但屏幕因 max-content 撑开到 90 / 110
localStorage.setItem('fw_tx_colwidths', JSON.stringify({ 2: 24, 5: 30 }));

FW.db.upsert('internal', { id: 't_demo', date: '2026-07-30', type: 'expense', project: '办公采购', category: '采购', account: '微信', amount: 520, party: '得力', reimburser: '王五', remark: '买打印纸', photos: [] });
FW.modules.internal.render();

var tbl = document.getElementById('txTable');
assert.ok(tbl, '应渲染 #txTable');
// 先确认 th 上确实有 data-col（这是 readRenderedColWidths 能取到宽度的前置条件）
var thWithDataCol = tbl.querySelectorAll('thead th[data-col]');
assert.strictEqual(thWithDataCol.length, 11, '应有 11 个带 data-col 的内容列 th，实际=' + thWithDataCol.length);

var px = FW.modules.internal.screenColPx();
assert.strictEqual(px.length, 11, 'screenColPx 应返回 11 个宽度');
assert.strictEqual(px[2], 90, '项目列应取渲染宽度 90（而非存储的 24）');
assert.strictEqual(px[5], 110, '金额列应取渲染宽度 110（而非存储的 30）—— 修复核心');
assert.strictEqual(px[0], 92, '未调整列应取默认/渲染宽度 92');
assert.ok(px[5] > 30, '金额列渲染宽度必须 > 存储窄宽，否则导出会再次压碎');

console.log('ALL_OK  export_rendered_width: 导出宽度正确读取屏幕真实渲染宽度');
