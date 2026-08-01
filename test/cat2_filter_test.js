/* 流水明细二级分类筛选测试
 * 验证：流水明细筛选区在选了一级分类后，能继续按二级分类精确筛选。
 * 规则：category 字段形如 "一级 / 二级"；筛选支持 category（一级）+ category2（二级）。
 */
const fs = require('fs');
const path = require('path');

global.window = global;
function fakeEl() {
  return {
    addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {} },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    appendChild: function () {}, setAttribute: function () {}, innerHTML: '', textContent: ''
  };
}
global.document = {
  getElementById: function () { return fakeEl(); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return fakeEl(); }
};
const store = {};
global.FW = {
  db: {
    getList: function (k) { return store[k] || []; },
    saveList: function (k, v) { store[k] = v; return true; },
    upsert: function (k, item) { var a = store[k] || []; var i = a.findIndex(function (x) { return x.id === item.id; }); if (i >= 0) a[i] = item; else a.push(item); store[k] = a; return item; },
    remove: function (k, id) { store[k] = (store[k] || []).filter(function (x) { return x.id !== id; }); },
    uid: function (p) { return (p || '') + Math.random().toString(36).slice(2); }
  },
  esc: function (s) { return String(s == null ? '' : s); },
  fmtMoney: function (n) { return (Number(n) || 0).toFixed(2); },
  qa: function () { return []; },
  toast: function () {},
  openModal: function () {},
  closeModal: function () {},
  today: function () { return '2026-08-01'; }
};

function load(p) { return fs.readFileSync(path.join(__dirname, '..', 'js', p), 'utf8'); }
eval(load('ui.js'));
eval(load('internal.js'));

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  √ ' + name); } else { fail++; console.log('  × ' + name); } }
function ids(rows) { return rows.map(function (r) { return r.id; }).sort().join(','); }

// 分类树（一级 / 二级）
store['internal_cats'] = [
  { name: '材料采购', children: ['办公用品', '设备'] },
  { name: '餐饮', children: ['餐费'] }
];
// 流水：含「一级+二级」「只有一级」「不同一级」「无分类」
store['internal'] = [
  { id: 'r1', date: '2026-01-01', type: 'expense', amount: 10, category: '材料采购 / 办公用品' },
  { id: 'r2', date: '2026-01-02', type: 'expense', amount: 20, category: '材料采购 / 设备' },
  { id: 'r3', date: '2026-01-03', type: 'expense', amount: 30, category: '材料采购' },
  { id: 'r4', date: '2026-01-04', type: 'expense', amount: 40, category: '餐饮 / 餐费' },
  { id: 'r5', date: '2026-01-05', type: 'expense', amount: 50, category: '' }
];

console.log('— 二级分类提取 —');
ok('cat2Name 取出二级「办公用品」', FW.internalCalc.cat2Name(store['internal'][0]) === '办公用品');
ok('cat2Name 仅一级时返回空串', FW.internalCalc.cat2Name(store['internal'][2]) === '');

console.log('— 仅选一级分类（不过滤二级）—');
var onlyCat = FW.internalCalc.filterRows({ category: '材料采购', category2: '' });
ok('只选一级=材料采购 返回 3 条（含不同二级与仅有的一级）', ids(onlyCat) === 'r1,r2,r3');

console.log('— 选一级 + 二级 —');
var cat2a = FW.internalCalc.filterRows({ category: '材料采购', category2: '办公用品' });
ok('材料采购 / 办公用品 仅 r1', ids(cat2a) === 'r1');
var cat2b = FW.internalCalc.filterRows({ category: '材料采购', category2: '设备' });
ok('材料采购 / 设备 仅 r2', ids(cat2b) === 'r2');
var cat2c = FW.internalCalc.filterRows({ category: '材料采购', category2: '餐费' });
ok('一级选材料采购但二级填餐饮 → 0 条（二级不匹配）', ids(cat2c) === '');

console.log('— 二级为空表示「全部二级」，包含仅有的一级记录 —');
var allCat2 = FW.internalCalc.filterRows({ category: '材料采购', category2: '' });
ok('category2 空 = 全部二级，含无二级的 r3', ids(allCat2) === 'r1,r2,r3');

console.log('— 不选一级时不受二级影响 —');
var none = FW.internalCalc.filterRows({ category: '', category2: '' });
ok('不选一级返回全部 5 条', ids(none) === 'r1,r2,r3,r4,r5');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
