/* 往来账 DOM 冒烟测试：验证 预付类型 + 关联项目 字段的存储契约
 * （项目核算依赖 contacts 中 kind='预付' & project 聚合成「应收回款项」）
 */
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

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'contacts.js'), 'utf8');
window.eval(code);

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }

const mod = window.FW.modules.contacts;
mod.render();

// 顶部应有新增往来按钮
const addBtn = document.getElementById('cAdd');
assert(!!addBtn, '顶部含「＋ 新增往来」按钮');
addBtn.click();
assert(document.getElementById('modalMask').hidden === false, '点击新增后弹出表单');

// 表单含 预付 选项 与 关联项目 输入框
const kindSel = document.getElementById('c_kind');
assert(!!kindSel, '表单含类型下拉 c_kind');
assert(kindSel.querySelector('option[value="预付"]') != null, '类型下拉含「预付」选项');
assert(!!document.getElementById('c_project'), '表单含关联项目输入框 c_project');

// 填写并保存一条预付款（关联项目）
document.getElementById('c_party').value = '供应商甲';
kindSel.value = '预付';
document.getElementById('c_project').value = '项目A';
document.getElementById('c_amount').value = '60000';
document.getElementById('cSave').click();

const list = window.FW.db.getList('contacts');
assert(list.length === 1, '保存后往来账有 1 条记录');
assert(list[0].kind === '预付', '记录类型为 预付');
assert(list[0].project === '项目A', '记录关联项目 = 项目A');
assert(Number(list[0].amount) === 60000, '记录金额 = 60000');
assert(Number(list[0].settled) === 0, '初始已核销 = 0（未用完）');

// 列表渲染含「项目」列与「预付」标签
const c = document.getElementById('content');
assert(/预付/.test(c.textContent), '列表渲染含「预付」标签');
assert(/项目A/.test(c.textContent), '列表渲染含关联项目 项目A');

console.log('\n往来账测试：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
