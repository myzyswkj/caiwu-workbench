/* 银行对账功能测试（jsdom-free，纯逻辑）：
 * 1) guessBankMap 正确识别收入/支出/余额/对方/摘要列
 * 2) parseBankRowsCore 按列解析收入、支出、余额（含中文表头、跳过表头行）
 * 3) reconcile 自动勾对：精确(日期+金额) 与 模糊(±1天+金额) 匹配
 * 4) computeAdjust 余额调节表：两侧调节后余额一致即平衡
 */
const fs = require('fs');
const path = require('path');

global.window = global;
const store = {};
global.FW = {
  db: {
    getList: function (k) { return store[k] || []; },
    saveList: function (k, v) { store[k] = v; return true; },
    upsert: function (k, item) { var a = store[k] || []; var i = a.findIndex(function (x) { return x.id === item.id; }); if (i >= 0) a[i] = item; else a.push(item); store[k] = a; return item; },
    uid: function (p) { return (p || '') + Math.random().toString(36).slice(2); }
  },
  esc: function (s) { return String(s == null ? '' : s); },
  fmtMoney: function (n) { return (Number(n) || 0).toFixed(2); },
  qa: function () { return []; },
  toast: function () {},
  openModal: function () {}
};

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'internal.js'), 'utf8');
eval(code);

const R = FW.modules.internal.internalReconcile;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

console.log('--- 1) 银行列识别 guessBankMap ---');
const headers = ['交易日期', '摘要', '借方金额', '贷方金额', '账户余额', '交易对手'];
const map = R.guessBankMap(headers);
ok('识别日期列', map.dateCol === 0);
ok('识别收入列(贷方金额)', map.incomeCol === 3);
ok('识别支出列(借方金额)', map.expenseCol === 2);
ok('识别余额列', map.balanceCol === 4);
ok('识别对方列(交易对手)', map.partyCol === 5);
ok('识别摘要列', map.remarkCol === 1);

console.log('--- 2) 解析银行流水 parseBankRowsCore ---');
const rows = [
  ['交易日期', '摘要', '借方金额', '贷方金额', '账户余额', '交易对手'],
  ['2026-07-01', '工资入账', '', '5000.00', '15000.00', '张三公司'],
  ['2026-07-02', '采购付款', '320.50', '', '14679.50', '供应商甲'],
  ['2026/7/3', '微信提现', '1000', '', '13679.5', '']
];
const res = R.parseBankRowsCore(rows, map);
ok('跳过表头后解析 3 行', res.rows.length === 3);
ok('工资入账=收入5000', res.rows[0].type === 'income' && Math.abs(res.rows[0].amount - 5000) < 0.001);
ok('采购付款=支出320.5', res.rows[1].type === 'expense' && Math.abs(res.rows[1].amount - 320.5) < 0.001);
ok('微信提现=支出1000(支持/分隔日期)', res.rows[2].type === 'expense' && Math.abs(res.rows[2].amount - 1000) < 0.001);
ok('余额解析正确', Math.abs(res.rows[0].balance - 15000) < 0.001);
ok('对方/摘要保留', res.rows[0].party === '张三公司' && res.rows[0].summary === '工资入账');

console.log('--- 3) 自动勾对 reconcile ---');
const bankRows = res.rows; // 3 笔银行流水
const bookRows = [
  { id: 'b1', date: '2026-07-01', type: 'income', amount: 5000 },
  { id: 'b2', date: '2026-07-02', type: 'expense', amount: 320.5 },
  { id: 'b3', date: '2026-07-05', type: 'expense', amount: 88 } // 内账有、银行无（银行未达）
];
const recon = R.reconcile(bankRows, bookRows);
ok('精确匹配 2 笔(7-01收入/7-02支出)', recon.matched.length === 2);
ok('银行有内账无 1 笔(7-03提现)', recon.bankOnly.length === 1 && recon.bankOnly[0].date === '2026-07-03');
ok('内账有银行无 1 笔(7-05)', recon.bookOnly.length === 1 && recon.bookOnly[0].id === 'b3');

console.log('--- 3b) 模糊匹配(±1天) ---');
const bookRows2 = [
  { id: 'c1', date: '2026-07-02', type: 'income', amount: 5000 }, // 银行是7-01，差1天，金额相同
];
const recon2 = R.reconcile([bankRows[0]], bookRows2);
ok('±1天内金额相同也能勾对', recon2.matched.length === 1);

console.log('--- 4) 余额调节表 computeAdjust ---');
// 平衡场景：账面含企业未达(88)，银行含银行未达(1000提现)
// 令 bookBal = bankEnd + (enterRecv-enterPay) - (bankRecv-bankPay)
const bankEnd = 13679.5;
const enterRecv = 0, enterPay = 88, bankRecv = 1000, bankPay = 0;
const bookBal = bankEnd + (enterRecv - enterPay) - (bankRecv - bankPay); // = 13679.5 -88 -1000 = 12591.5
// 但注意：上面的 recon 里 bankOnly 是提现1000(income? 不，提现是支出)
// 重新构造与本 recon 一致：bankOnly=支出1000, bookOnly=支出88
// 平衡场景：bankEnd=13679.5，企业未达=支出88(已记账面)，银行未达=支出1000(未记账面)
// 平衡要求 bookBal - 1000 == 13679.5 - 88  → bookBal = 14591.5
const adjBal = R.computeAdjust(recon, 14591.5, 13679.5);
ok('平衡场景 balanced=true', adjBal.balanced === true);
ok('adjBook = 13591.5', Math.abs(adjBal.adjBook - 13591.5) < 0.001);
ok('adjBank = 13591.5', Math.abs(adjBal.adjBank - 13591.5) < 0.001);
ok('两侧调节后余额相等', Math.abs(adjBal.adjBook - adjBal.adjBank) < 0.001);

console.log('--- 4b) 不平衡检测 ---');
const adj3 = R.computeAdjust(recon, 10000, 13679.5);
ok('账面与银行差较大→不平衡', adj3.balanced === false);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有 ' + fail + ' 项失败') + '（通过 ' + pass + ' 项）');
process.exit(fail === 0 ? 0 : 1);
