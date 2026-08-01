/* 合同台账 DOM 冒烟测试：验证 render / 新增 / 汇总 / 删除 */
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

// ---- FW 桩 ----
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

// ---- 载入 invoices.js ----
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'invoices.js'), 'utf8');
window.eval(code);

// ---- 测试 ----
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }

const mod = window.FW.modules.invoices;
mod.setTab('contract');

const c = document.getElementById('content');
assert(c.querySelector('#ctSummary'), '合同视图含汇总区 #ctSummary');
assert(c.querySelector('#ctWrap'), '合同视图含表格容器 #ctWrap');
assert(c.querySelector('.empty'), '空列表显示空状态提示');

// 顶部操作区：新增合同按钮
const addBtn = document.getElementById('addCtBtn');
assert(!!addBtn, '顶部含「＋ 新增合同」按钮');
addBtn.click();

// 表单已弹出
assert(document.getElementById('modalMask').hidden === false, '点击新增后弹出表单弹窗');
assert(!!document.getElementById('c_no'), '表单含合同编号输入');
document.getElementById('c_no').value = 'HT-2026-001';
document.getElementById('c_name').value = '办公设备采购合同';
document.getElementById('c_party').value = '深圳XX科技有限公司';
document.getElementById('c_type').value = '采购合同';
document.getElementById('c_sign').value = '2026-03-01';
document.getElementById('c_due').value = '2026-09-01';
document.getElementById('c_amt').value = '120000';
document.getElementById('c_pay').value = '分期付款';
document.getElementById('c_status').value = '履行中';
document.getElementById('ctSave').click();

// 列表应有 1 行
const rows = c.querySelectorAll('#ctWrap tbody tr');
assert(rows.length === 1, '保存后列表有 1 行合同（实际 ' + rows.length + '）');
assert(/HT-2026-001/.test(rows[0].textContent), '行内显示合同编号 HT-2026-001');
assert(/履行中/.test(rows[0].textContent), '行内显示履行状态标签');
assert(/¥120,000\.00/.test(rows[0].textContent), '行内显示格式化金额');

// 汇总：合同总数 1，总金额 120000
const statText = document.getElementById('ctSummary').textContent;
assert(/合同总数/.test(statText) && /1/.test(statText), '汇总区显示合同总数=1');
assert(/120,000/.test(statText), '汇总区显示合同总金额=120000');

// 再新增一条已终止合同，验证状态金额汇总
document.getElementById('addCtBtn').click();
document.getElementById('c_no').value = 'HT-2026-002';
document.getElementById('c_amt').value = '80000';
document.getElementById('c_status').value = '已终止';
document.getElementById('ctSave').click();
assert(c.querySelectorAll('#ctWrap tbody tr').length === 2, '第二条保存后列表有 2 行');

// 删除第一条
const delBtn = c.querySelector('#ctWrap .row-del');
delBtn.click();
assert(c.querySelectorAll('#ctWrap tbody tr').length === 1, '删除后列表回到 1 行');

// tabs 数组含合同台账
const tabKeys = mod.tabs.map(function (t) { return t.key; });
assert(tabKeys.indexOf('contract') >= 0, '模块 tabs 含 contract 键');
assert(tabKeys.indexOf('stock') >= 0, '模块 tabs 含 stock 键');
assert(JSON.stringify(tabKeys) === JSON.stringify(['all', 'in', 'out', 'contract', 'stock']), 'tabs 共 5 项（全部/进项/销项/合同/库存）');

console.log('— 合同文档关键信息提取 —');
var sampleText = [
  '本合同由甲方（深圳市某某科技有限公司）与乙方于2026年3月15日签订。',
  '合同编号：HT-2026-0078',
  '签订日期：2026年3月15日',
  '到期日：2026年9月15日',
  '合同总金额：人民币1,234,567.00元',
  '付款方式：一次性付款',
  '负责人：张三'
].join('\n');
var ext = window.FW.contractCalc.extractContractFields(sampleText, 'XX采购合同.pdf');
assert(ext.no === 'HT-2026-0078', '提取合同编号 HT-2026-0078（实际 ' + ext.no + '）');
assert(ext.party === '深圳市某某科技有限公司', '提取对方单位（甲方）（实际 ' + ext.party + '）');
assert(ext.signDate === '2026-03-15', '提取签订日期 2026-03-15（实际 ' + ext.signDate + '）');
assert(ext.dueDate === '2026-09-15', '提取到期日 2026-09-15（实际 ' + ext.dueDate + '）');
assert(Math.abs((ext.amount || 0) - 1234567) < 0.01, '提取合同金额 1234567（实际 ' + ext.amount + '）');
assert(ext.payMethod === '一次性付款', '提取付款方式 一次性付款（实际 ' + ext.payMethod + '）');
assert(ext.owner === '张三', '提取负责人 张三（实际 ' + ext.owner + '）');
assert(ext.name === 'XX采购合同', '文件名兜底合同名称 XX采购合同（实际 ' + ext.name + '）');

// 金额含「万」单位换算
var extWan = window.FW.contractCalc.extractContractFields('合同总价：人民币 50万元整');
assert(Math.abs((extWan.amount || 0) - 500000) < 0.01, '「50万元」换算为 500000（实际 ' + extWan.amount + '）');

// 空文本（如图片/扫描件无OCR）不误提取
var extEmpty = window.FW.contractCalc.extractContractFields('', 'scan.jpg');
assert(extEmpty.no === undefined && extEmpty.amount === undefined, '空文本不误提取字段');

console.log('— 合同附件数据结构与列表展示 —');
window.FW.db.upsert('contracts', { id: 'ct_test_1', no: 'HT-2026-0099', name: '带附件合同', party: '乙公司', type: '销售合同', signDate: '2026-02-01', dueDate: '', amount: 50000, payMethod: '月结', status: '履行中', owner: '', remark: '', photos: [], docFiles: [{ id: 'f1', name: 'contract.pdf', type: 'application/pdf', size: 1024 }], attachments: [{ id: 'f2', name: 'invoice.xlsx', type: '', size: 2048 }] });
mod.setTab('contract');
var rows2 = c.querySelectorAll('#ctWrap tbody tr');
var attRow = null;
rows2.forEach(function (r) { if (/HT-2026-0099/.test(r.textContent)) attRow = r; });
assert(!!attRow, '找到带附件合同行');
assert(attRow && /📎 2/.test(attRow.textContent), '附件列显示 📎 2（1正文+1附件，实际 ' + (attRow ? attRow.textContent.replace(/📎/g, '📎') : '') + '）');

// 点击附件按钮弹出附件列表
var attBtn = attRow.querySelector('[data-att]');
attBtn.click();
var mb = document.getElementById('modalBody').textContent;
var mt = document.getElementById('modalTitle').textContent;
assert(/合同附件（2）/.test(mt), '附件弹窗标题 合同附件（2）（实际 ' + mt + '）');
assert(/contract\.pdf/.test(mb) && /invoice\.xlsx/.test(mb), '附件弹窗列出文件名');

console.log('\n合同台账测试：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
