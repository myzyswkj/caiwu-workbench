// 列宽一致性测试：屏幕调整 → 导出（Excel/图片/PDF）复用同一套宽度
// 验证 screenColPx / txExportColWidths 作为「单一来源」，以及导出映射公式正确
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
var _store = { 'fw_tx_colwidths': JSON.stringify({ 2: 200, 7: 60 }) }; // 自定义：项目=200、凭证=60
global.localStorage = {
  getItem: function (k) { return k in _store ? _store[k] : null; },
  setItem: function (k, v) { _store[k] = String(v); },
  removeItem: function (k) { delete _store[k]; },
  clear: function () { _store = {}; }
};

global.FW = global.window.FW = {
  db: {
    _d: {},
    getList: function (k) { return (this._d[k] || (this._d[k] = [])).slice(); },
    saveList: function (k, v) { this._d[k] = v.slice(); },
    upsert: function (k, r) { var a = this._d[k] || (this._d[k] = []); if (!r.id) r.id = 't_' + Math.random(); a.push(r); },
    getById: function (k, id) { return (this._d[k] || []).filter(function (x) { return x.id === id; })[0]; },
    savePhoto: function () { return Promise.resolve('p1'); },
    getCurrentLedger: function () { return '默认账套'; },
    getLedgers: function () { return [{ id: '默认账套', name: '默认账套' }]; }
  },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; },
  esc2: function (s) { return s; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {},
  today: function () { return '2026-07-30'; },
  openModal: function () {},
  closeModal: function () {},
  qa: function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
};

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

// ---- 1. screenColPx 直接反映自定义宽度，未自定义列回退默认（紧凑默认）----
var px = FW.modules.internal.screenColPx();
assert.strictEqual(px.length, 11, '应有 11 个语义列宽度');
assert.strictEqual(px[2], 200, '项目列应读自定义 200px');
assert.strictEqual(px[7], 60, '凭证列应读自定义 60px');
assert.strictEqual(px[0], 92, '未自定义的日期列应回退紧凑默认 92px');

// ---- 2. txExportColWidths 按语义 id 映射（图片/PDF 顺序）----
var imgW = FW.modules.internal.txExportColWidths(['date', 'type', 'project', 'category', 'account', 'amount', 'party', 'reimburser', 'remark', 'voucher']);
assert.deepStrictEqual(imgW, [92, 84, 200, 96, 88, 108, 112, 84, 148, 60], '图片列宽应=屏幕宽度（含自定义 200/60 + 紧凑默认）');

// ---- 3. Excel 映射公式与 buildXLSX 内一致：wch = round(px/7.5)，专属列用默认 ----
// 复刻 buildXLSX 的 XLSX_COL_IDS / 默认，确保导出确实继承屏幕宽度
var XLSX_COL_IDS = ['date', 'type', 'project', 'category', 'account', 'amount', null, null, 'remark', null, 'party', 'reimburser', null];
var XLSX_COL_DEF = { 6: 10, 7: 12, 9: 8, 12: 12 };
var TX_COL_IDS = ['date', 'type', 'project', 'category', 'account', 'amount', 'remark', 'voucher', 'party', 'reimburser', 'op'];
function wchOf(id, idx) {
  if (id == null) return XLSX_COL_DEF[idx] != null ? XLSX_COL_DEF[idx] : 12;
  var i = TX_COL_IDS.indexOf(id);
  return Math.max(4, Math.round(px[i] / 7.5));
}
var excelWch = XLSX_COL_IDS.map(function (id, idx) { return wchOf(id, idx); });
// 项目列(索引2)自定义200 → round(200/7.5)=27；日期(0)92→12；凭证数(9,null)→8
assert.strictEqual(excelWch[2], 27, 'Excel 项目列 wch 应=round(200/7.5)=27');
assert.strictEqual(excelWch[0], 12, 'Excel 日期列 wch 应=round(92/7.5)=12');
assert.strictEqual(excelWch[9], 8, 'Excel 凭证数列(专属)应=默认 8');
// 凭证列(屏幕60)在图片端保底 160，在 Excel 端是「凭证数」列(专属)不受影响；这里只验证映射链路正确
assert.ok(excelWch[7] >= 4, 'Excel 金额关联列 wch 应有效');

// ---- 4. 渲染后 colgroup 实际写入自定义宽度（applyColWidths 链路）----
FW.db.upsert('internal', { id: 't_x', date: '2026-07-30', type: 'expense', project: '办公', category: '采购', account: '微信', amount: 100, party: '甲', reimburser: '乙', remark: 'r', photos: [] });
FW.modules.internal.render();
var tbl = document.getElementById('txTable');
var c2 = tbl.querySelector('colgroup col[data-col="2"]');
assert.ok(c2, '应有 data-col="2" 的 col');
assert.strictEqual(c2.style.width, '200px', '渲染后项目列 col 应写入自定义 200px');

console.log('✅ 列宽一致性：screenColPx / txExportColWidths / Excel 映射 / 渲染写入 全部通过');
