// 流水明细页「按账户（收支维度）」小表：随筛选实时重算，5 列简洁表（账户/收入/支出/互转/净额）。
// 锁定 HTML 结构 + 数据口径（含互转 transfer 处理），保证后续修改不会破坏老板视角的核心数据展示。
// 风格与 test/internal_export_test.js 一致：把函数逻辑复制进测试做纯函数验证（FW.db 等运行时不在此处调用）。
'use strict';
var assert = require('assert');

// 与 ui.js 风格一致：fmtMoney 千分位 + 两位小数；esc 转义 HTML
function fmtMoney(n) {
  var v = Math.round((Number(n) || 0) * 100) / 100;
  var s = v.toFixed(2);
  var parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// 与 internal.js buildAccMap 一致
function buildAccMap(rows) {
  var map = {};
  function ensure(k) { if (!map[k]) map[k] = { income: 0, expense: 0, transfer: 0 }; return map[k]; }
  rows.forEach(function (t) {
    var a = Number(t.amount) || 0;
    if (t.type === 'income') { ensure(t.account || '其他').income += a; }
    else if (t.type === 'expense') { ensure(t.account || '其他').expense += a; }
    else if (t.type === 'refund') { ensure(t.account || '其他').expense -= a; }
    else if (t.type === 'transfer') {
      if (t.fromAccount) ensure(t.fromAccount).transfer -= a;
      if (t.toAccount) ensure(t.toAccount).transfer += a;
    }
  });
  return map;
}

// 与 internal.js accSummaryHtml 行为一致
function accSummaryHtml(rows) {
  if (!rows || !rows.length) return '';
  var accMap = buildAccMap(rows);
  var keys = Object.keys(accMap);
  if (!keys.length) return '';
  keys.sort(function (a, b) {
    var va = accMap[a], vb = accMap[b];
    return (vb.income + vb.expense + Math.abs(vb.transfer || 0)) - (va.income + va.expense + Math.abs(va.transfer || 0));
  });
  function trCls(n) { return n > 0 ? 'income' : (n < 0 ? 'expense' : ''); }
  var totalIn = 0, totalEx = 0, totalTr = 0, totalNet = 0;
  var trs = keys.map(function (k) {
    var v = accMap[k];
    var tr = v.transfer || 0;
    var net = v.income - v.expense;
    totalIn += v.income; totalEx += v.expense; totalTr += tr; totalNet += net;
    return '<tr>' +
      '<td>' + esc(k) + '</td>' +
      '<td class="num income">' + fmtMoney(v.income) + '</td>' +
      '<td class="num expense">' + fmtMoney(v.expense) + '</td>' +
      '<td class="num ' + trCls(tr) + '">' + fmtMoney(tr) + '</td>' +
      '<td class="num ' + (net >= 0 ? 'income' : 'expense') + '"><b>' + fmtMoney(net) + '</b></td>' +
      '</tr>';
  }).join('');
  trs += '<tr class="acc-sum-row">' +
    '<td>合计（' + keys.length + ' 账户）</td>' +
    '<td class="num income">' + fmtMoney(totalIn) + '</td>' +
    '<td class="num expense">' + fmtMoney(totalEx) + '</td>' +
    '<td class="num ' + trCls(totalTr) + '">' + fmtMoney(totalTr) + '</td>' +
    '<td class="num ' + (totalNet >= 0 ? 'income' : 'expense') + '"><b>' + fmtMoney(totalNet) + '</b></td>' +
    '</tr>';
  return '<div class="flow-acc-head">按账户（收支维度）</div>' +
    '<table class="flow-acc-tbl"><thead><tr><th>账户</th><th class="num">收入</th><th class="num">支出</th><th class="num">互转</th><th class="num">净额</th></tr></thead><tbody>' + trs + '</tbody></table>' +
    '<div class="flow-acc-note">互转 = 转入 − 转出（账户互转净头寸，单列不影响收支净额）</div>';
}

// ===== 1. 空数据返回空字符串 =====
assert.strictEqual(accSummaryHtml([]), '', '空 rows 返回空字符串');
assert.strictEqual(accSummaryHtml(null), '', 'null rows 返回空字符串');
assert.strictEqual(accSummaryHtml(undefined), '', 'undefined rows 返回空字符串');

// ===== 2. 5 列顺序：账户/收入/支出/互转/净额 =====
var rows = [
  { type: 'income',  account: '公户账户', amount: 49230.37 },
  { type: 'expense', account: '公户账户', amount: 5000 }
];
var html = accSummaryHtml(rows);
var headMatch = html.match(/<thead>[\s\S]*?<\/thead>/);
assert.ok(headMatch, '存在表头块');
var thCount = (headMatch[0].match(/<\/th>/g) || []).length;
assert.strictEqual(thCount, 5, '5 个表头列（账户/收入/支出/互转/净额）');
assert.ok(html.indexOf('>账户</th>') > -1, '表头包含「账户」');
assert.ok(html.indexOf('>收入</th>') > -1, '表头包含「收入」');
assert.ok(html.indexOf('>支出</th>') > -1, '表头包含「支出」');
assert.ok(html.indexOf('>互转</th>') > -1, '表头包含「互转」');
assert.ok(html.indexOf('>净额</th>') > -1, '表头包含「净额」');

// ===== 3. 互转正负着色（>0 income 红，<0 expense 绿，=0 无色） =====
var trRows = [
  { type: 'income',  account: 'A', amount: 1000 },
  { type: 'transfer', fromAccount: 'A', toAccount: 'B', amount: 600 }, // A: -600, B: +600
  { type: 'transfer', fromAccount: 'C', toAccount: 'A', amount: 200 }  // A: +200, C: -200
];
var trHtml = accSummaryHtml(trRows);
// A 的互转 = -600 + 200 = -400 → expense 色（绿）
assert.ok(/A[\s\S]{0,500}?num expense">-400\.00/.test(trHtml), 'A 互转 -400 着色为 expense（绿）');
// B 的互转 = +600 → income 色（红）
assert.ok(/B[\s\S]{0,500}?num income">600\.00/.test(trHtml), 'B 互转 +600 着色为 income（红）');

// ===== 4. 净额 = 收入 - 支出（含 refund 抵减） =====
var netRows = [
  { type: 'income',  account: 'X', amount: 1000 },
  { type: 'expense', account: 'X', amount: 300 },
  { type: 'refund',  account: 'X', amount: 200 }  // expense -= 200 → 净支出 100, net = 1000-100 = 900
];
var netHtml = accSummaryHtml(netRows);
assert.ok(/X[\s\S]{0,600}?num income"><b>900\.00/.test(netHtml), 'X 净额 = 1000 - (300-200) = 900，income 色');
assert.ok(/X[\s\S]{0,500}?num income">1,000\.00/.test(netHtml), 'X 收入 1,000.00 着色 income');
assert.ok(/X[\s\S]{0,500}?num expense">100\.00/.test(netHtml), 'X 支出净额 = 300-200 = 100，expense 色');

// ===== 5. 合计行：账户数 + 合计 =====
var sumRows = [
  { type: 'income',  account: 'P', amount: 1000 },
  { type: 'expense', account: 'P', amount: 400 },
  { type: 'income',  account: 'Q', amount: 500 },
  { type: 'expense', account: 'Q', amount: 200 }
];
var sumHtml = accSummaryHtml(sumRows);
assert.ok(/合计（2 账户）/.test(sumHtml), '合计行标 2 账户');
assert.ok(/合计（2 账户）[\s\S]{0,500}?1,500\.00/.test(sumHtml), '合计收入 1,500');
assert.ok(/合计（2 账户）[\s\S]{0,600}?600\.00/.test(sumHtml), '合计支出 600');
assert.ok(/合计（2 账户）[\s\S]{0,800}?900\.00/.test(sumHtml), '合计净额 900');
assert.ok(/acc-sum-row/.test(sumHtml), '合计行带 acc-sum-row 类（用于金底/金线样式）');

// ===== 6. 排序：按「收入+支出+|互转|」降序 =====
var sortRows = [
  { type: 'income', account: '小', amount: 100 },
  { type: 'income', account: '大', amount: 10000 },
  { type: 'expense', account: '大', amount: 8000 }
];
var sortHtml = accSummaryHtml(sortRows);
var posD = sortHtml.indexOf('<td>大</td>');
var posX = sortHtml.indexOf('<td>小</td>');
assert.ok(posD > -1 && posX > -1 && posD < posX, '按活动量降序：大 在 小 之前');

// ===== 7. 仅含 transfer 行也展示（边界场景） =====
var onlyTransfer = [
  { type: 'transfer', fromAccount: 'A', toAccount: 'B', amount: 500 }
];
var onlyHtml = accSummaryHtml(onlyTransfer);
assert.ok(onlyHtml.length > 0, '仅含 transfer 也能渲染小表');
assert.ok(/A[\s\S]{0,500}?num expense">-500\.00/.test(onlyHtml), 'A 转出 -500 expense 色');
assert.ok(/B[\s\S]{0,500}?num income">500\.00/.test(onlyHtml), 'B 转入 +500 income 色');

// ===== 8. 标题 + 注脚 =====
assert.ok(html.indexOf('按账户（收支维度）') > -1, '包含「按账户（收支维度）」标题');
assert.ok(html.indexOf('互转 = 转入 − 转出') > -1, '包含互转口径注脚');

// ===== 9. 互转权重参与排序：仅靠互转入账的账户也参与排序 =====
var weightRows = [
  { type: 'transfer', fromAccount: '低', toAccount: '高', amount: 1 },     // 低：互转 -1；高：互转 +1
  { type: 'income',  account: '高', amount: 100000 }                       // 高：收入 100000 → 权重 100001
];
var weightHtml = accSummaryHtml(weightRows);
var posG = weightHtml.indexOf('<td>高</td>');
var posD2 = weightHtml.indexOf('<td>低</td>');
assert.ok(posG > -1 && posD2 > -1 && posG < posD2, '靠互转入账的账户也参与排序（与收入一起算权重）');

// ===== 10. 合计行互转合计为 0（数学恒等：互转净额恒为 0） =====
var zeroTransferRows = [
  { type: 'transfer', fromAccount: '甲', toAccount: '乙', amount: 1234.56 }
];
var zeroHtml = accSummaryHtml(zeroTransferRows);
// 合计行：互转 = +1234.56 + (-1234.56) = 0
assert.ok(/合计[\s\S]{0,800}?>\s*0\.00\s*</.test(zeroHtml), '合计行互转 = 0.00（恒等式：转入 + 转出 = 0）');

console.log('ALL_OK');
