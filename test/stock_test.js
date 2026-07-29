/* 库存台账 DOM 冒烟测试：验证 render / 新增(入/出) / 汇总 / 删除 / tabs */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = `<!DOCTYPE html><html><body>
<div id="content"></div>
<div id="topActions"></div>
<div class="modal-mask" id="modalMask" hidden><div class="modal" id="modal"><div class="modal-head"><span id="modalTitle"></span><button id="modalClose">x</button></div><div class="modal-body" id="modalBody"></div></div></div>
<div class="toast" id="toast" hidden></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const document = window.document;

const _store = {};
const LEDGER = 'L1';
function k(base) { return 'fw_' + base + '_' + LEDGER; }
window.FW = {
  db: {
    getList: function (base) { try { return JSON.parse(window.localStorage.getItem(k(base)) || '[]'); } catch (e) { return []; } },
    saveList: function (base, arr) { window.localStorage.setItem(k(base), JSON.stringify(arr)); },
    upsert: function (base, item) {
      var arr = window.FW.db.getList(base);
      var i = arr.findIndex(function (x) { return x.id === item.id; });
      if (i >= 0) arr[i] = item; else arr.push(item);
      window.FW.db.saveList(base, arr); return item;
    },
    getById: function (base, id) { return window.FW.db.getList(base).find(function (x) { return x.id === id; }) || null; },
    remove: function (base, id) { var arr = window.FW.db.getList(base).filter(function (x) { return x.id !== id; }); window.FW.db.saveList(base, arr); },
    uid: function (p) { return (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
    getPhoto: function () { return Promise.resolve(null); },
    savePhoto: function () { return Promise.resolve('p_' + Math.random().toString(36).slice(2, 8)); },
    deletePhoto: function () { return Promise.resolve(); },
    deletePhotos: function () { return Promise.resolve(); }
  },
  esc: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  fmtMoney: function (x) { return '¥' + (Number(x) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  today: function () { return '2026-07-29'; },
  toast: function () {},
  qa: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
  openModal: function (title, body, onShow) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = body;
    document.getElementById('modalMask').hidden = false;
    if (onShow) onShow();
  },
  closeModal: function () { document.getElementById('modalMask').hidden = true; }
};
window.print = function () {};
window.confirm = function () { return true; };

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'invoices.js'), 'utf8');
window.eval(code);

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }

const mod = window.FW.modules.invoices;
mod.setTab('stock');

const c = document.getElementById('content');
assert(c.querySelector('#stSummary'), '库存视图含汇总区 #stSummary');
assert(c.querySelector('#stWrap'), '库存视图含表格容器 #stWrap');
assert(c.querySelector('.empty'), '空列表显示空状态提示');

const addBtn = document.getElementById('addStBtn');
assert(!!addBtn, '顶部含「＋ 新增单据」按钮');

// 入库：采购入库 100 件 @ 10
addBtn.click();
assert(document.getElementById('modalMask').hidden === false, '点击新增后弹出表单');
assert(!!document.getElementById('s_item'), '表单含商品名称输入');
document.getElementById('s_item').value = 'A4打印纸';
document.getElementById('s_qty').value = '100';
document.getElementById('s_price').value = '10';
document.getElementById('s_type').value = '采购入库';
document.getElementById('stSave').click();
assert(c.querySelectorAll('#stWrap tbody tr').length === 1, '保存后列表有 1 行');

// 出库：销售出库 30 件 @ 15（金额应自动=450）
addBtn.click();
document.getElementById('s_item').value = 'A4打印纸';
document.getElementById('s_qty').value = '30';
document.getElementById('s_price').value = '15';
document.getElementById('s_type').value = '销售出库';
document.getElementById('stSave').click();
assert(c.querySelectorAll('#stWrap tbody tr').length === 2, '第二条保存后列表有 2 行');

// 退货：采购退货 5 件 @ 10（出库方向）
addBtn.click();
document.getElementById('s_item').value = 'A4打印纸';
document.getElementById('s_qty').value = '5';
document.getElementById('s_price').value = '10';
document.getElementById('s_type').value = '采购退货';
document.getElementById('stSave').click();
assert(c.querySelectorAll('#stWrap tbody tr').length === 3, '第三条保存后列表有 3 行');

// 汇总：入库100/出30/退5/结存=100-30-5=65
const sumText = document.getElementById('stSummary').textContent;
assert(/入库合计/.test(sumText) && /100/.test(sumText), '汇总区显示入库合计数量=100');
assert(/出库合计/.test(sumText) && /35/.test(sumText), '汇总区显示出库合计数量=35(销售出库30+采购退货5)');
assert(/退货合计/.test(sumText) && /5/.test(sumText), '汇总区显示退货合计数量=5');
assert(/库存结存/.test(sumText) && /65/.test(sumText), '汇总区显示库存结存=65(100-35)');

// 销售出库行方向标记"出"，且金额=450
const rows = c.querySelectorAll('#stWrap tbody tr');
let outRow = null;
rows.forEach(function (r) { if (/销售出库/.test(r.textContent)) outRow = r; });
assert(!!outRow && /450\.00/.test(outRow.textContent), '销售出库行金额按 30×15=450 自动计算');
assert(/−30/.test(outRow.textContent), '出库数量显示为 −30');

// 删除一行
c.querySelector('#stWrap .row-del').click();
assert(c.querySelectorAll('#stWrap tbody tr').length === 2, '删除后列表回到 2 行');

// tabs 数组含库存台账
const tabKeys = mod.tabs.map(function (t) { return t.key; });
assert(tabKeys.indexOf('stock') >= 0, '模块 tabs 含 stock 键');
assert(tabKeys.length === 5, 'tabs 共 5 项（全部/进项/销项/合同/库存）');

console.log('\n库存台账测试：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
