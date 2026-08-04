// 新增流水增加「对方单位/个人」「报销人」字段 — 端到端测试
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('./setup').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><body><div id="topActions"></div><div id="content"><div id="inOverview"></div><div id="inBody"></div></div></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.TextDecoder = dom.window.TextDecoder;
global.confirm = function () { return true; };
global.localStorage = (function () {
  var s = {}; return { getItem: function (k) { return k in s ? s[k] : null; }, setItem: function (k, v) { s[k] = String(v); }, removeItem: function (k) { delete s[k]; }, clear: function () { s = {}; } };
})();

global.FW = global.window.FW = {
  db: {
    _d: {},
    getList: function (k) { return (this._d[k] || (this._d[k] = [])).slice(); },
    saveList: function (k, v) { this._d[k] = v.slice(); },
    upsert: function (k, r) { var a = this._d[k] || (this._d[k] = []); if (!r.id) r.id = 't_' + Math.random(); a.push(r); },
    getById: function (k, id) { return (this._d[k] || []).filter(function (x) { return x.id === id; })[0]; },
    savePhoto: function () { return Promise.resolve('p1'); }
  },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {},
  today: function () { return '2026-07-30'; },
  openModal: function (title, body, cb) {
    var mb = document.getElementById('modalBody');
    if (!mb) { mb = document.createElement('div'); mb.id = 'modalBody'; document.body.appendChild(mb); }
    mb.innerHTML = body;
    if (cb) cb();
  },
  closeModal: function () { var mb = document.getElementById('modalBody'); if (mb) mb.innerHTML = ''; },
  qa: function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
};

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

// 渲染内账模块，使 #addTxBtn 绑定到 openForm
FW.modules.internal.render();

// ---- 1. 打开新增流水弹窗 ----
var addBtn = document.getElementById('addTxBtn');
assert.ok(addBtn, '顶部应存在「新增流水」按钮');
addBtn.click();
assert.ok(document.getElementById('f_party'), '表单应包含「对方单位/个人」输入框 f_party');
assert.ok(document.getElementById('f_reimburser'), '表单应包含「报销人」输入框 f_reimburser');

// ---- 2. 填写表单（含新增两字段） ----
document.getElementById('f_date').value = '2026-07-30';
document.getElementById('f_type').value = 'expense';
document.getElementById('f_project').value = '办公采购';
document.getElementById('f_amount').value = '520';
document.getElementById('f_party').value = '得力文具(公司)';
document.getElementById('f_reimburser').value = '王五';
document.getElementById('f_remark').value = '买打印纸';

// 保存
document.getElementById('txSave').click();

// ---- 3. 校验已写入数据 ----
var all = FW.db.getList('internal');
var rec = all[all.length - 1];
console.log('[3] 新记录:', JSON.stringify(rec));
assert.strictEqual(rec.project, '办公采购', 'project 应写入');
assert.strictEqual(rec.party, '得力文具(公司)', '对方单位/个人应写入 rec.party');
assert.strictEqual(rec.reimburser, '王五', '报销人应写入 rec.reimburser');

// ---- 4. 列表展示（表头 + 行） ----
var tableHtml = document.getElementById('txTable') ? document.getElementById('txTable').outerHTML : '';
assert(/对方\/个人/.test(tableHtml), '流水列表表头应包含「对方/个人」列');
assert(/报销人/.test(tableHtml), '流水列表表头应包含「报销人」列');
assert(/得力文具\(公司\)/.test(tableHtml), '列表应展示对方单位');
assert(/王五/.test(tableHtml), '列表应展示报销人');

// ---- 5. 导出 CSV 应包含两列及数据 ----
var capCsv = '';
global.Blob = function (parts) { capCsv = parts.join(''); this.parts = parts; };
global.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} };
var expBtn = document.getElementById('expTxBtn');
assert.ok(expBtn, '应存在「导出表格」按钮');
// 导出已改为下拉菜单：点 expTxBtn 仅开菜单，需再点菜单里的 CSV 项才真正导出
var csvBtn = document.querySelector('#expTxMenu button[data-fmt="csv"]');
assert.ok(csvBtn, '导出菜单应含「CSV」项');
csvBtn.click();
console.log('[5] 导出 CSV 片段:', capCsv.split('\r\n')[0], '|', capCsv.split('\r\n')[1]);
assert(/对方单位\/个人/.test(capCsv), '导出 CSV 表头应含「对方单位/个人」');
assert(/报销人/.test(capCsv), '导出 CSV 表头应含「报销人」');
assert(/得力文具\(公司\)/.test(capCsv), '导出 CSV 数据行应含对方单位');
assert(/王五/.test(capCsv), '导出 CSV 数据行应含报销人');

console.log('PASS: 新增流水「对方单位/个人」「报销人」字段写入、列表展示、导出 CSV 均正常');
