// 导出图片列定义 = 界面流水表（去掉「操作」），顺序 / 标签 / 列宽逐一对齐界面
// 锁定回归：之前导出端列顺序（对方→报销人→备注→凭证）与界面（备注→凭证→对方→报销人）不一致、
// 且「对方单位/个人」标签与界面「对方/个人」不一致，导致「导出的图片和界面排版不一样」。
// 现在导出列由 TX_COLS / TX_COL_IDS 单一来源驱动，本测试防止再度漂移。
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

// 1. 导出列标签 = 界面流水表去掉「操作」后的顺序
var EXPECT_LABELS = ['日期', '类型', '项目', '分类', '账户', '金额', '备注', '凭证', '对方/个人', '报销人'];
var EXPECT_IDS = ['date', 'type', 'project', 'category', 'account', 'amount', 'remark', 'voucher', 'party', 'reimburser'];
var cols = M.txExportColumns();
assert.deepStrictEqual(cols.labels, EXPECT_LABELS, '导出图片表头顺序/标签必须与界面流水表一致');
assert.deepStrictEqual(cols.ids, EXPECT_IDS, '导出图片列 id 顺序必须与界面一致');
assert.strictEqual(cols.labels.length, 10, '导出列应为 10（界面 11 列去掉操作）');

// 2. 不得含「操作」列，且不得用旧的「对方单位/个人」标签（与界面「对方/个人」对齐）
assert.strictEqual(cols.labels.indexOf('操作'), -1, '导出图片不得含「操作」列');
assert.strictEqual(cols.labels.indexOf('对方单位/个人'), -1, '不得再用旧标签「对方单位/个人」');
assert.strictEqual(cols.labels[8], '对方/个人', '第 9 列必须是界面的「对方/个人」');

// 3. 关键顺序修复：备注(6) 在 凭证(7) 之前，凭证 在 对方(8)/报销人(9) 之前（与界面一致，而非旧的 对方→报销人→备注→凭证）
assert.ok(cols.labels.indexOf('备注') < cols.labels.indexOf('凭证'), '备注 必须在 凭证 之前');
assert.ok(cols.labels.indexOf('凭证') < cols.labels.indexOf('对方/个人'), '凭证 必须在 对方/个人 之前');
assert.ok(cols.labels.indexOf('对方/个人') < cols.labels.indexOf('报销人'), '对方/个人 必须在 报销人 之前');

// 4. 列宽：导出列宽按 id 取屏幕真实渲染宽度，顺序与界面逐列对应（1:1）
var widths = M.txExportColWidths(cols.ids);
assert.strictEqual(widths.length, 10, 'txExportColWidths 应返回 10 个宽度');
var screen = M.screenColPx(); // 界面 11 列（含操作）
assert.deepStrictEqual(widths, screen.slice(0, 10), '导出列宽必须与界面前 10 列屏幕真实宽度逐列对应');
widths.forEach(function (w, i) { assert.ok(w > 0, '第 ' + i + ' 列宽度应 > 0'); });

console.log('ALL_OK  export_image_cols: 导出图片列定义与界面流水表一致（顺序/标签/列宽）');
