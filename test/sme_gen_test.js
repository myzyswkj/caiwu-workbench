// 小规模升一般纳税人预警：核心算法逻辑测试（复制 compute 的纯计算部分）
var assert = require('assert');

var DEFAULT_THRESHOLD = 5000000;

function levelOf(sales, threshold) {
  var ratio = threshold > 0 ? sales / threshold : 0;
  return ratio >= 1 ? 'danger' : (ratio >= 0.8 ? 'warn' : 'safe');
}
function monthsTo(sales, month, threshold) {
  var ratio = threshold > 0 ? sales / threshold : 0;
  if (ratio < 1 && month > 0) return Math.ceil((threshold - sales) / month);
  return null;
}

// 1. 安全区：380万 -> safe
assert.strictEqual(levelOf(3800000, DEFAULT_THRESHOLD), 'safe', '380万应为安全');
// 2. 关注区(>=80%)：420万 -> warn
assert.strictEqual(levelOf(4200000, DEFAULT_THRESHOLD), 'warn', '420万应为关注');
// 3. 触线(>=100%)：510万 -> danger
assert.strictEqual(levelOf(5100000, DEFAULT_THRESHOLD), 'danger', '510万应为应办登记');
// 4. 阈值边界 500万整 -> danger（≥100% 含等号）
assert.strictEqual(levelOf(5000000, DEFAULT_THRESHOLD), 'danger', '500万整应为应办登记');
// 5. 79.9% -> safe（<80%）
assert.strictEqual(levelOf(3995000, DEFAULT_THRESHOLD), 'safe', '399.5万应为安全');

// 6. 触线估算：380万，月均36万 -> ceil(120万/36万)=4 个月
assert.strictEqual(monthsTo(3800000, 360000, DEFAULT_THRESHOLD), 4, '应约4个月后触线');
// 7. 已超线不应估算
assert.strictEqual(monthsTo(5100000, 360000, DEFAULT_THRESHOLD), null, '已超线不估算触线月数');
// 8. 月均0不应估算
assert.strictEqual(monthsTo(3800000, 0, DEFAULT_THRESHOLD), null, '月均0不估算');

// 9. 自定义阈值：300万，250万 -> warn
assert.strictEqual(levelOf(2500000, 3000000), 'warn', '自定义阈值下250/300为关注');
// 10. 自定义阈值：300万，310万 -> danger
assert.strictEqual(levelOf(3100000, 3000000), 'danger', '自定义阈值下310万为应办登记');

// 11. 两种口径区间（复制 currentRange / baseLabel 纯逻辑）
function fmt(d) { var p = function (n) { return n < 10 ? '0' + n : '' + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function rangeOf(m) {
  if (m === 'year') { var d = new Date(); var from = new Date(d.getFullYear(), 0, 1); return { from: fmt(from), to: fmt(d), label: '自然年累计' }; }
  var d2 = new Date(); var start = new Date(d2.getFullYear(), d2.getMonth() - 11, 1); return { from: fmt(start), to: fmt(d2), label: '连续12个月滚动' };
}
var yr = rangeOf('year');
assert.strictEqual(yr.from.slice(5), '01-01', '自然年累计应从当年1月1日起算');
assert.strictEqual(yr.label, '自然年累计', 'year 口径名为自然年累计');
var rl = rangeOf('roll12');
assert.strictEqual(rl.label, '连续12个月滚动', 'roll12 口径名为连续12个月滚动');
// 滚动起点应为当前月前推11个月（同年则月份差11）
(function () {
  var d = new Date(); var expect = new Date(d.getFullYear(), d.getMonth() - 11, 1);
  assert.strictEqual(rl.from, fmt(expect), '连续12个月起点=当前月前推11个月当月1号');
})();

console.log('ALL_OK');
