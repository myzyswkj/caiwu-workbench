// 账户改名同步历史流水 — 端到端测试（驱动真实弹窗 DOM）
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSDOM = require('jsdom').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><body><div id="topActions"></div><div id="content"><div id="inOverview"></div><div id="inBody"></div></div></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.TextDecoder = dom.window.TextDecoder;
global.confirm = function () { return true; }; // 模拟用户点「同步」
global.localStorage = (function () {
  var s = {}; return { getItem: function (k) { return k in s ? s[k] : null; }, setItem: function (k, v) { s[k] = String(v); }, removeItem: function (k) { delete s[k]; }, clear: function () { s = {}; } };
})();

// FW 桩
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

// 加载 db + internal
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

// 种子数据：内部账本默认 6 个账户，其中含「微信」
// 普通流水（支出，账户=微信）
FW.db.upsert('internal', { id: 'a1', date: '2026-07-01', type: 'expense', project: '午饭', amount: 30, account: '微信', category: '餐饮' });
FW.db.upsert('internal', { id: 'a2', date: '2026-07-02', type: 'income', project: '红包', amount: 100, account: '微信', category: '' });
// 互转：微信 -> 银行卡
FW.db.upsert('internal', { id: 'a3', date: '2026-07-03', type: 'transfer', amount: 500, fromAccount: '微信', toAccount: '银行卡', account: '微信 → 银行卡' });

var before = FW.db.getList('internal');
assert.strictEqual(before.filter(function (t) { return t.account === '微信'; }).length, 2, '改名前 2 条普通记录账户=微信');
assert.strictEqual(before.filter(function (t) { return t.fromAccount === '微信'; }).length, 1, '改名前 1 条互转 fromAccount=微信');

// 渲染内账模块（注入 #topActions 等挂载点）
FW.modules.internal.render();
// 触发「账户管理」弹窗
document.getElementById('accMgrBtn').onclick();

// 在弹窗里把「微信」改名为「微信支付」（新版：一级账户输入 .acc-mgr-pname，oninput 实时更新）
var inputs = FW.qa('.acc-mgr-pname');
var weChatInput = inputs.filter(function (i) { return (i.value || '') === '微信'; })[0];
assert.ok(weChatInput, '弹窗中存在初始名为「微信」的一级账户输入');
weChatInput.value = '微信支付';
weChatInput.oninput(); // 实时更新账户树状态

// 点击保存
document.getElementById('accMgrSave').onclick();

var after = FW.db.getList('internal');
console.log('[after] accounts default:', JSON.stringify(FW.internalAccMgr.getAccounts()));
// 普通记录应同步
assert.strictEqual(after.filter(function (t) { return t.id === 'a1' && t.account === '微信支付'; }).length, 1, 'a1 账户已同步为 微信支付');
assert.strictEqual(after.filter(function (t) { return t.id === 'a2' && t.account === '微信支付'; }).length, 1, 'a2 账户已同步为 微信支付');
// 互转双侧应同步，且 account 合成串更新
var t3 = after.filter(function (t) { return t.id === 'a3'; })[0];
assert.strictEqual(t3.fromAccount, '微信支付', '互转 fromAccount 同步');
assert.strictEqual(t3.toAccount, '银行卡', '互转 toAccount 不变');
assert.strictEqual(t3.account, '微信支付 → 银行卡', '互转 account 合成串更新');
// 其他账户不受影响（如 银行卡 仍在）
assert.ok(FW.internalAccMgr.getAccounts().indexOf('银行卡') >= 0, '银行卡 仍在账户列表');
assert.ok(FW.internalAccMgr.getAccounts().indexOf('微信') < 0, '微信 已从列表移除');
assert.ok(FW.internalAccMgr.getAccounts().indexOf('微信支付') >= 0, '微信支付 已加入列表');

console.log('账户改名同步测试：全部断言通过 ✅');
