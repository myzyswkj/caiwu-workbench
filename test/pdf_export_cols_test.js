// 打印 / 导出 PDF 的明细表列 = 界面流水表（去掉「操作」列），顺序 / 标签 / 列宽逐一对齐界面。
// 锁定回归：之前 PDF 表头写死为「…金额 → 对方单位/个人 → 报销人 → 备注 → 凭证」，与界面
// （…金额 → 备注 → 凭证 → 对方/个人 → 报销人）不一致，且标签为「对方单位/个人」而非界面的「对方/个人」。
// 现在 PDF 明细表由 txExportColumns() 单一来源驱动（与导出图片同一来源），本测试防止再度漂移。
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');
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
  db: { _d: {}, getList: function (k) { return (this._d[k] || (this._d[k] = [])).slice(); }, saveList: function (k, v) { this._d[k] = v.slice(); }, upsert: function (k, r) { var a = this._d[k] || (this._d[k] = []); if (!r.id) r.id = 't_' + Math.random(); a.push(r); }, getById: function (k, id) { return (this._d[k] || []).filter(function (x) { return x.id === id; })[0]; }, getPhoto: function () { return Promise.resolve(null); }, savePhoto: function () { return Promise.resolve('p'); } },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; },
  esc2: function (s) { return s; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {}, today: function () { return '2026-07-30'; }, openModal: function () {}, closeModal: function () {},
  qa: function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
};

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

var M = FW.modules.internal;
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');

// 1. PDF 明细表由 txExportColumns() 单一来源驱动（与导出图片同一来源 = 界面去掉操作列）
assert.ok(/var ec = txExportColumns\(\);/.test(src), 'openPrintView 应调用 txExportColumns() 单一来源');
assert.ok(/headTh = ec\.ids\.map/.test(src), 'PDF 表头应按 ec.ids 顺序生成');
assert.ok(/ec\.labels\[k\]/.test(src), 'PDF 表头标签应取自 ec.labels（界面标签）');

// 2. PDF 明细表（fpDetailTable）的 thead 不得再写死旧标签「对方单位/个人」
//    （注意：导入预览表 impPrevTable 仍按约定用「对方单位/个人」，不在本测试锁定范围）
var thead = src.match(/<thead id="fpDetailHead">[\s\S]*?<\/thead>/);
assert.ok(thead, '应存在 fpDetailTable 的 thead');
assert.strictEqual(thead[0].indexOf('对方单位/个人'), -1, 'PDF 明细表列头不得含旧标签「对方单位/个人」（应与界面「对方/个人」对齐）');

// 3. PDF 金额列仍左对齐（amount_align_test 共享契约，这里复验不回退）
assert.ok(/var TH_SP = \{ amount: ' style="text-align:left"'/.test(src), 'PDF 金额列应保留 text-align:left');

// 4. 动态复验：txExportColumns() 返回的标签/顺序即界面顺序（PDF 复用此契约）
var EXPECT_LABELS = ['日期', '类型', '项目', '分类', '账户', '金额', '备注', '凭证', '对方/个人', '报销人'];
var EXPECT_IDS = ['date', 'type', 'project', 'category', 'account', 'amount', 'remark', 'voucher', 'party', 'reimburser'];
var cols = M.txExportColumns();
assert.deepStrictEqual(cols.labels, EXPECT_LABELS, 'PDF 明细表标签顺序必须与界面流水表一致');
assert.deepStrictEqual(cols.ids, EXPECT_IDS, 'PDF 明细表列 id 顺序必须与界面一致');
assert.strictEqual(cols.labels.indexOf('对方单位/个人'), -1, 'PDF 不得再用旧标签「对方单位/个人」');
assert.ok(cols.labels.indexOf('备注') < cols.labels.indexOf('凭证'), 'PDF：备注 必须在 凭证 之前（与界面一致）');
assert.ok(cols.labels.indexOf('凭证') < cols.labels.indexOf('对方/个人'), 'PDF：凭证 必须在 对方/个人 之前（与界面一致）');
assert.ok(cols.labels.indexOf('对方/个人') < cols.labels.indexOf('报销人'), 'PDF：对方/个人 必须在 报销人 之前（与界面一致）');

console.log('ALL_OK  pdf_export_cols: 打印/PDF 明细表列 = 界面流水表（顺序/标签/列宽一致，由 txExportColumns 单一来源驱动）');
