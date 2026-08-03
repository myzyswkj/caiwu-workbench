/* 冒烟测试：验证微信账单模式支持 .xlsx 文件导入
 * 模拟：XLSX 解析出微信账单格式的行 → 转 CSV → parseWeChatBill → 得到正确记录
 */
var assert = require('assert');
var JSDOM = require('jsdom').JSDOM;

// 创建 DOM 环境（internal.js 依赖 window/document）
var dom = new JSDOM('<!DOCTYPE html><html><body><div id="content"></div></body></html>', {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.TextDecoder = dom.window.TextDecoder;

// ---- 1. 构建最小 FW 桩（挂在 window 上，因为 internal.js IIFE 用的是 window） ----
var store = {};
dom.window.FW = {
  db: {
    upsert: function (k, r) { if (!store[k]) store[k] = []; store[k].push(r); },
    uid: function (p) { return p + '_' + Date.now() + '_' + Math.floor(Math.random() * 999); }
  },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {},
  openModal: function (t, b, cb) { cb(); },
  closeModal: function () {},
  qa: function (s) { return document.querySelectorAll(s); },
  modules: {}
};

// 加载 db
eval(require('fs').readFileSync(__dirname + '/../js/db.js', 'utf8'));

// ---- 2. 加载 internal.js（含修复后的导入逻辑） ----
eval(require('fs').readFileSync(__dirname + '/../js/internal.js', 'utf8'));

var FW = dom.window.FW; // internal.js IIFE 把结果挂到了 window.FW

// ---- 3. 模拟微信账单 Excel 数据（XLSX sheet_to_json 后的二维数组） ----
var mockWechatRows = [
  ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额（元）', '支付方式', '当前状态', '备注'],
  ['2026-07-01 10:30:00', '收款', '张三', '转账', '收入', '100.00', '零钱', '已收钱', ''],
  ['2026-07-02 14:20:00', '付款', '美团', '外卖-午餐', '支出', '35.50', '零钱', '已支付', ''],
  ['2026-07-03 09:00:00', '退款', '京东', '退货', '', '-99.00', '微信', '已退款', '不计收支']
];

// ---- 4. 将 mock 行转为 CSV（模拟 XLSX→CSV 转换逻辑） ----
function rowsToCsv(rowsArr) {
  return rowsArr.map(function (row) {
    return row.map(function (cell) {
      var s = (cell == null ? '' : String(cell));
      if (s.indexOf(',') > -1 || s.indexOf('"') > -1 || s.indexOf('\n') > -1) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',');
  }).join('\r\n');
}

var csvText = rowsToCsv(mockWechatRows);
console.log('[1] CSV 转换结果前两行:');
console.log(csvText.split('\r\n')[0]);
console.log(csvText.split('\r\n')[1]);

// ---- 5. 用 parseWeChatBill 解析 ----
var result = FW.internalImport.parseWeChatBill(csvText);

console.log('[2] 解析结果: ok=' + result.ok + ', rows=' + result.rows.length + ', skipped=' + result.skipped);
if (!result.ok) console.log('[2] 错误: ' + result.msg);

// ---- 6. 断言 ----
assert.strictEqual(result.ok, true, '解析应成功');
assert.strictEqual(result.rows.length, 2, '应有 2 条有效记录（第 3 条"不计收支"被跳过）');
assert.strictEqual(result.skipped, 1, '应跳过 1 条');
assert.strictEqual(result.rows[0].type, 'income', '第 1 条应为收入');
assert.strictEqual(result.rows[0].amount, 100.0, '第 1 条金额=100');
assert.strictEqual(result.rows[0].party, '张三', '第 1 条对方=张三（应写入 party，不再误入 project）');
assert.strictEqual(result.rows[0].project, '', '第 1 条 project 应为空');
assert.strictEqual(result.rows[1].type, 'expense', '第 2 条应为支出');
assert.strictEqual(result.rows[1].amount, 35.5, '第 2 条金额=35.5');
assert.strictEqual(result.rows[1].party, '美团', '第 2 条对方=美团（应写入 party）');
assert.strictEqual(result.rows[1].project, '', '第 2 条 project 应为空');

// ---- 7. 验证 csvSplit 能正确处理转换后的 CSV ----
var splitResult = FW.internalImport.csvSplit(csvText.split('\r\n')[0]);
console.log('[3] 表头 csvSplit 结果: ' + JSON.stringify(splitResult.slice(0, 4)));
assert(splitResult.indexOf('交易时间') > -1, '表头应包含"交易时间"');
assert(splitResult.indexOf('收/支') > -1, '表头应包含"收/支"');

console.log('\n✅ 全部 ' + 7 + ' 项断言通过 — 微信账单 XLSX→CSV→parseWeChatBill 路径正常');
