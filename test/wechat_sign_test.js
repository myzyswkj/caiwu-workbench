/* 回归测试：微信账单 Excel 中支出金额为负时，导入后应为正数且方向正确
 * 复现用户反馈「收入和支出有错误」的根因——负数支出导致汇总被抵消。
 */
var assert = require('assert');
var JSDOM = require('jsdom').JSDOM;

var dom = new JSDOM('<!DOCTYPE html><html><body><div id="content"></div></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.TextDecoder = dom.window.TextDecoder;

var store = {};
dom.window.FW = {
  db: { upsert: function (k, r) { (store[k] = store[k] || []).push(r); }, uid: function (p) { return p + Math.random(); } },
  esc: function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; },
  fmtMoney: function (n) { return (n < 0 ? '-' : '') + '¥' + Math.abs(n).toFixed(2); },
  toast: function () {}, openModal: function (t, b, cb) { cb(); }, closeModal: function () {}, qa: function () { return []; }, modules: {}
};

eval(require('fs').readFileSync(__dirname + '/../js/db.js', 'utf8'));
eval(require('fs').readFileSync(__dirname + '/../js/internal.js', 'utf8'));
var FW = dom.window.FW;

// 模拟微信 Excel（XLSX sheet_to_json 输出，raw:false）：支出金额为负数
var rowsArr = [
  ['微信支付账单明细'],
  ['微信昵称：[测试用户]'],
  ['起始时间：[2026-07-01 00:00:00] 终止时间：[2026-07-28 23:59:59]'],
  ['账单流水情况如下：'],
  [''],
  ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '备注'],
  ['2026-07-01 10:30:00', '收款', '张三', '转账', '收入', 100.0, '零钱', '已收钱', ''],
  ['2026-07-02 14:20:00', '付款', '美团', '外卖', '支出', -35.5, '零钱', '支付成功', ''],
  ['2026-07-03 09:00:00', '退款', '京东', '退货', '支出', -99.0, '微信', '已退款', ''],
  ['2026-07-04 12:00:00', '付款', '超市', '日用品', '支出', -50.0, '银行卡', '支付成功', '']
];

// 复刻 XLSX→CSV 转换逻辑（与 internal.js 中一致）
function rowsToCsv(arr) {
  return arr.map(function (row) {
    return row.map(function (cell) {
      var s = (cell == null ? '' : String(cell));
      if (s.indexOf(',') > -1 || s.indexOf('"') > -1 || s.indexOf('\n') > -1) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',');
  }).join('\r\n');
}

var csvText = rowsToCsv(rowsArr);
var res = FW.internalImport.parseWeChatBill(csvText);

console.log('解析结果: ok=' + res.ok + ', rows=' + res.rows.length + ', skipped=' + res.skipped);
res.rows.forEach(function (r, i) { console.log('  [' + i + '] ' + r.date + ' ' + r.type + ' ' + r.amount + ' ' + r.party); });

// 断言
assert.strictEqual(res.ok, true, '解析成功');
// 第 3 行（京东退款）因 status 含"已退款"被跳过 → 共 3 条有效
assert.strictEqual(res.rows.length, 3, '应有 3 条有效（退款行被跳过）');
assert.strictEqual(res.skipped, 1, '应跳过 1 条退款');

// 关键：支出金额必须为正数（修复前为 -35.5 / -50）；"交易对方"应写入 party，而非误入 project
var meituan = res.rows.find(function (r) { return r.party === '美团'; });
var chaoshi = res.rows.find(function (r) { return r.party === '超市'; });
assert.ok(meituan && meituan.type === 'expense' && meituan.amount === 35.5, '美团(-35.5) 应为正数支出 35.5，实际 ' + JSON.stringify(meituan));
assert.ok(chaoshi && chaoshi.type === 'expense' && chaoshi.amount === 50.0, '超市(-50) 应为正数支出 50，实际 ' + JSON.stringify(chaoshi));

var zhangsan = res.rows.find(function (r) { return r.party === '张三'; });
assert.ok(zhangsan && zhangsan.type === 'income' && zhangsan.amount === 100.0, '张三(100) 应为正数收入 100');

// 汇总校验：收入100，支出85.5（不应被负数抵消）
var totalInc = res.rows.filter(function (r) { return r.type === 'income'; }).reduce(function (a, r) { return a + r.amount; }, 0);
var totalExp = res.rows.filter(function (r) { return r.type === 'expense'; }).reduce(function (a, r) { return a + r.amount; }, 0);
assert.strictEqual(totalInc, 100.0, '总收入应为 100');
assert.strictEqual(totalExp, 85.5, '总支出应为 85.5（35.5+50），修复前会因负数变成 -85.5');

console.log('\n✅ 收入/支出方向 & 正数金额全部正确（修复前支出会被负数抵消成 -85.5）');
