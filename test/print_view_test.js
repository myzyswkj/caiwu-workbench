// 打印 / PDF 预览：点击「打印 / 转 PDF」必须能打开弹窗（不能抛 ReferenceError），
// 且明细表 thead 列顺序 / 标签必须与界面流水表一致（用户要求「和界面一样」）。
// 重点防回归：之前 openPrintView 把 `var ec = txExportColumns()` 写进了 IIFE 内部，
// 导致 tbody 的 rows.map 访问 ec 时作用域错位 → ReferenceError → 点击打印无反应。
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

var modalHtml = null;
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
  openModal: function (title, html, cb) { modalHtml = html; if (cb) cb(document.createElement('div')); },
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

// 模拟点击导出菜单里的「打印 / 转 PDF」按钮（走真实闭包 openPrintView）
var printBtn = document.querySelector('#expTxMenu button[data-fmt="print"]');
assert.ok(printBtn, '应存在打印按钮');
var threw = null;
try { printBtn.onclick({ stopPropagation: function () {} }); } catch (e) { threw = e; }
assert.ifError(threw); // 关键：不得抛 ReferenceError（之前 ec 作用域错位会抛）
assert.ok(modalHtml, '点击打印应打开预览弹窗');
assert.ok(modalHtml.indexOf('id="fpDetailTable"') >= 0, '弹窗应含明细表 fpDetailTable');

// thead 列顺序 / 标签必须与界面流水表一致
var th = modalHtml.match(/<thead id="fpDetailHead">[\s\S]*?<\/thead>/);
assert.ok(th, '应含 fpDetailHead thead');
// 去掉 resizer 手柄 <span class="fp-col-resizer"> 后再取纯标签（列标签本身未变，手柄只是交互控件）
var labels = (th[0].match(/<th\b[^>]*>([\s\S]*?)<\/th>/g) || []).map(function (s) {
  return s.replace(/<th\b[^>]*>|<\/th>/g, '').replace(/<span[\s\S]*?<\/span>/g, '').trim();
});
var expected = ['日期', '类型', '项目', '分类', '账户', '金额', '备注', '凭证', '对方/个人', '报销人'];
assert.deepStrictEqual(labels, expected, 'PDF thead 必须与界面流水表列顺序/标签一致');

// 每页带标题的 colSpan 必须等于明细表列数（10）
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');
var m = src.match(/td\.colSpan = (\d+);/);
assert.ok(m, 'applyTitleEvery 应设 colSpan');
assert.strictEqual(Number(m[1]), expected.length, 'colSpan 必须等于明细表列数 ' + expected.length);

console.log('ALL_OK  print_view: 点击打印弹窗正常打开，thead 与界面流水表列一致（10 列）');
