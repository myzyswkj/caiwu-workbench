// 流水表列宽拖拽功能 — 端到端测试
// 验证：colgroup/col-resizer 生成正确、默认宽度应用、拖拽后 localStorage 持久化、重置恢复
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
var _store = {};
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
    savePhoto: function () { return Promise.resolve('p1'); }
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

// jsdom 不计算布局，getBoundingClientRect 默认全 0；补 mock 让拖拽起点宽度=style.width 解析值
dom.window.Element.prototype.getBoundingClientRect = function () {
  var w = parseInt((this.style && this.style.width) || '', 10);
  return { width: isNaN(w) ? 0 : w, height: 20, top: 0, left: 0, right: w || 0, bottom: 20, x: 0, y: 0, toJSON: function () {} };
};

eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8'));

// 先插一条流水，保证列表渲染出 #txTable（空列表走 empty 分支）
FW.db.upsert('internal', { id: 't_demo', date: '2026-07-30', type: 'expense', project: '办公采购', category: '采购', account: '微信', amount: 520, party: '得力', reimburser: '王五', remark: '买打印纸', photos: [] });
FW.modules.internal.render();
var txWrap = document.getElementById('txWrap');
assert.ok(txWrap, '应存在 #txWrap 容器');

// ---- 1. colgroup + col 数量正确（11 列：日期/类型/项目/分类/账户/金额/备注/凭证/对方/报销人/操作）----
var tbl = document.getElementById('txTable');
assert.ok(tbl, '应渲染 #txTable');
var colgroup = tbl.querySelector('colgroup');
assert.ok(colgroup, '应存在 <colgroup>');
var cols = colgroup.querySelectorAll('col');
assert.strictEqual(cols.length, 11, '非批量模式下应有 11 个 <col>，实际=' + cols.length);

// ---- 2. col-resizer 数量：除最后一列外每列一个（共 10 个）----
var resizers = tbl.querySelectorAll('.col-resizer');
assert.strictEqual(resizers.length, 10, '应有 10 个拖拽手柄（最后一列无），实际=' + resizers.length);
// 最后一列「操作」不应有手柄
var lastTh = tbl.querySelectorAll('thead th')[10];
assert.ok(lastTh && !lastTh.querySelector('.col-resizer'), '操作列不应有拖拽手柄');

// ---- 3. 默认宽度已应用到 col（applyColWidths 在 drawTable 末尾调用）----
// 检查至少一个 col 的 style.width 被设为 px 值
var someW = cols[2].style.width; // 项目列
assert.ok(/^\d+px$/.test(someW), '默认宽度应写入 col.style.width，实际="' + someW + '"');
assert.strictEqual(cols[7].style.width, '96px', '凭证列默认宽度应为 96px（够放缩略图）');

// ---- 3b. 备注列带 col-sep-l 分隔类：金额 ↔ 备注 之间画竖线视觉"分开" ----
var remarkTh = tbl.querySelectorAll('thead th')[6];
assert.ok(remarkTh && remarkTh.classList.contains('col-sep-l'), '备注列表头应带 col-sep-l 分隔类');
var firstRow = tbl.querySelector('tbody tr');
var remarkTd = firstRow.children[6];
assert.ok(remarkTd && remarkTd.classList.contains('col-sep-l'), '备注列单元格应带 col-sep-l 分隔类');

// ---- 4. 拖拽：mousedown 手柄 → mousemove → mouseup → 持久化 ----
var rz = resizers[2]; // 项目列手柄（data-col=2）
var beforeW = parseInt(cols[2].style.width, 10);
var md = new dom.window.MouseEvent('mousedown', { clientX: 200, bubbles: true });
// 给手柄补 closest 支持（jsdom 已支持）
rz.dispatchEvent(md);
// document 级 mousemove / mouseup（bindColResize 用 document.addEventListener）
var mm = new dom.window.MouseEvent('mousemove', { clientX: 300, bubbles: true }); // +100
document.dispatchEvent(mm);
var afterMoveW = parseInt(cols[2].style.width, 10);
assert.strictEqual(afterMoveW, beforeW + 100, '拖拽中应实时更新列宽，before=' + beforeW + ' after=' + afterMoveW);
var mu = new dom.window.MouseEvent('mouseup', { clientX: 300, bubbles: true });
document.dispatchEvent(mu);
// localStorage 持久化
var saved = JSON.parse(localStorage.getItem('fw_tx_colwidths') || '{}');
assert.strictEqual(saved[2], beforeW + 100, '拖拽后应写入 localStorage[fW_tx_colwidths][2]，实际=' + JSON.stringify(saved));

// ---- 5. 双击手柄单列重置（不让一处拖坏需要重置整表）----
var rz2 = resizers[7]; // 凭证列
// 先把该列拖到 60px，再双击手柄看是否回到默认
var md2 = new dom.window.MouseEvent('mousedown', { clientX: 200, bubbles: true });
rz2.dispatchEvent(md2);
var mm2 = new dom.window.MouseEvent('mousemove', { clientX: 240, bubbles: true }); // +40
document.dispatchEvent(mm2);
var mu2 = new dom.window.MouseEvent('mouseup', { clientX: 240, bubbles: true });
document.dispatchEvent(mu2);
var dbl = new dom.window.MouseEvent('dblclick', { bubbles: true });
rz2.dispatchEvent(dbl);
assert.strictEqual(cols[7].style.width, '96px', '双击凭证列手柄后应恢复默认 96px');

// ---- 6. 拖拽下限保护：拖到极小不会越界 ----
var rzMin = resizers[1]; // 类型列
var beforeMin = parseInt(cols[1].style.width, 10);
rzMin.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 100, bubbles: true }));
// 极端左移到 -1000 → 数学结果 < 20 → 应被夹到 20
document.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: -1000, bubbles: true }));
var minW = parseInt(cols[1].style.width, 10);
assert.ok(minW >= 20, '拖拽下限应保护在 20px 以上，实际=' + minW);
document.dispatchEvent(new dom.window.MouseEvent('mouseup', { clientX: -1000, bubbles: true }));
// 持久化里也应被夹住
var saved2 = JSON.parse(localStorage.getItem('fw_tx_colwidths') || '{}');
assert.ok(!saved2[1] || saved2[1] >= 20, '持久化的列宽也应 >= 20');

// ---- 7. 重置列宽 ----
document.getElementById('fResetColW').click();
var cleared = localStorage.getItem('fw_tx_colwidths');
assert.ok(cleared === null || Object.keys(JSON.parse(cleared || '{}')).length === 0, '重置后列宽配置应被清空');
// 重置后默认宽度仍生效（凭证列 96px）
assert.strictEqual(cols[7].style.width, '96px', '重置后默认宽度仍生效');

// ---- 8. 紧凑默认值校验 ----
var DEFS = FW.modules.internal.TX_DEF_W || null; // 可能未暴露
var cur = FW.modules.internal.screenColPx();
// 没持久化时 = 默认；[日期, 类型, 项目, 分类, 账户, 金额, 备注, 凭证, 对方, 报销人, 操作]
assert.deepStrictEqual(cur, [92, 84, 116, 96, 88, 108, 148, 96, 112, 84, 108], '无持久化时 screenColPx 应返回紧凑默认列宽');

console.log('✅ 列宽拖拽：colgroup/手柄生成、默认宽度、拖拽持久化、双击单列重置、下限保护、重置 全部通过');
