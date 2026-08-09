// 科目智能匹配回归测试
// 1) 纯函数 CatMatch.match：覆盖「命中/不命中/大小写/禁用规则/二级分类/优先级」
// 2) 表单联动：输入摘要自动填分类；手动改过后停止自动（不覆盖）
// 3) 批量归类：为「无分类」流水按摘要补分类，不覆盖已有分类
// 做法：真实加载 catmatch.js + internal.js（最小 DOM/ FW 桩），真正执行函数而非镜像逻辑。
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// ---------- 1. 纯函数测试 ----------
var CM = require(path.resolve(__dirname, '../js/catmatch.js'));
ok('require catmatch 返回 match 函数', typeof CM.match === 'function');

ok('摘要含「发工资」→ 工资薪酬', (function () {
  var m = CM.match('本月发工资'); return m && m.cat1 === '工资薪酬';
})());
ok('摘要含「午餐招待客户」→ 餐饮招待', (function () {
  var m = CM.match('午餐招待客户'); return m && m.cat1 === '餐饮招待';
})());
ok('英文关键字不区分大小写（Hotel → 差旅费）', (function () {
  var m = CM.match('如家 Hotel 住宿'); return m && m.cat1 === '差旅费';
})());
ok('无关键字返回 null', CM.match('收到投资分红') === null);
ok('空文本返回 null', CM.match('') === null);
ok('disabled 规则不命中', (function () {
  var rules = [{ kw: ['工资'], cat1: '工资薪酬', enabled: false }];
  return CM.match('发工资', rules) === null;
})());
ok('规则带 cat2 时返回二级', (function () {
  var rules = [{ kw: ['高铁'], cat1: '交通出行', cat2: '高铁票' }];
  var m = CM.match('坐高铁去北京', rules); return m && m.cat1 === '交通出行' && m.cat2 === '高铁票';
})());
ok('靠前的规则优先命中', (function () {
  var rules = [{ kw: ['饭'], cat1: 'A' }, { kw: ['饭'], cat1: 'B' }];
  return CM.match('吃饭', rules).cat1 === 'A';
})());
ok('filterValid 过滤掉不存在的分类', (function () {
  var rules = [{ kw: ['工资'], cat1: '工资薪酬' }, { kw: ['x'], cat1: '不存在的分类' }];
  var v = CM.filterValid(rules, ['工资薪酬']);
  return v.length === 1 && v[0].cat1 === '工资薪酬';
})());

// ---------- 2. 表单联动（真实加载 internal.js） ----------
var DEFAULT_CATS = ['办公用品', '差旅费', '餐饮招待', '工资薪酬', '房租物业', '交通出行', '广告宣传', '材料采购', '设备购置', '税费', '利息收入', '其他收入', '其他支出'];
var CATS = DEFAULT_CATS.map(function (n) { return { name: n, children: [] }; });

function makeEl() {
  var el = {
    _html: '', value: '', dataset: {}, style: {},
    classList: { contains: function () { return false; }, add: function () {}, remove: function () {} },
    appendChild: function () {}, addEventListener: function () {}, removeEventListener: function () {},
    closest: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    focus: function () {},
    onclick: null, oninput: null, onchange: null, ondragover: null, ondragleave: null, ondrop: null
  };
  Object.defineProperty(el, 'innerHTML', { get: function () { return this._html; }, set: function (v) { this._html = String(v); } });
  return el;
}
var els = {};
function getEl(id) { if (!els[id]) els[id] = makeEl(); return els[id]; }
var documentShim = {
  getElementById: function (id) { return getEl(id); },
  createElement: function () { return makeEl(); },
  querySelector: function () { return null; },
  addEventListener: function () {}, removeEventListener: function () {}
};

var dbData = [
  { id: 'e1', type: 'expense', amount: 100, remark: '发工资', category: '' },
  { id: 'e2', type: 'expense', amount: 50, remark: '午餐招待客户', category: '' },
  { id: 'e3', type: 'income', amount: 200, remark: '收到一笔货款', category: '' },
  { id: 'e4', type: 'expense', amount: 30, remark: '打车去机场', category: '餐饮招待' } // 已有分类，批量时不应被覆盖
];
var FW = {
  esc: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  fmtMoney: function (n) { return '¥' + (Number(n) || 0).toFixed(2); },
  today: function () { return '2026-08-09'; },
  toast: function () {},
  openModal: function (title, body, cb) { captured = { title: title, body: body, cb: cb }; },
  closeModal: function () {},
  qa: function () { return []; },
  nav: undefined,
  modules: {},
  db: {
    getList: function (key) {
      if (key === 'internal_cats') return CATS;
      if (key === 'internal_catrules') return [];
      return dbData;
    },
    getById: function (key, id) { return dbData.find(function (x) { return x.id === id; }) || null; },
    uid: function () { return 'uid_' + Math.random().toString(36).slice(2); },
    upsert: function (key, item) {
      var arr = (key === 'internal') ? dbData : [];
      var i = arr.findIndex(function (x) { return x.id === item.id; });
      if (i >= 0) arr[i] = item; else arr.push(item);
    },
    savePhoto: function () { return Promise.resolve('pid'); },
    getPhoto: function () { return Promise.resolve(null); },
    deletePhoto: function () {}
  }
};

var captured = null;
global.window = { FW: FW };
global.document = documentShim;
global.FW = FW;

// 先加载 catmatch（挂 window.CatMatch），再加载 internal.js
var cmCode = fs.readFileSync(path.resolve(__dirname, '../js/catmatch.js'), 'utf8');
vm.runInThisContext(cmCode, { filename: 'catmatch.js' });
var intCode = fs.readFileSync(path.resolve(__dirname, '../js/internal.js'), 'utf8');
vm.runInThisContext(intCode, { filename: 'internal.js' });

var M = global.window.FW.modules.internal;
ok('internal.js 暴露 autoMatchCat / bulkAutoCategorize', !!(M && M.autoMatchCat && M.bulkAutoCategorize));

// 打开新增表单，渲染支出动态区，使 f_cat1/f_cat2 存在
captured = null; M.openForm();
getEl('f_type').value = 'expense';
captured.cb();
// 模拟浏览器：select 的 options 由 innerHTML 的 <option> 渲染出来
getEl('f_cat1').options = CATS.map(function (c) { return { value: c.name }; });
getEl('f_cat2').options = [{ value: '' }];

// 输入「发工资」→ 自动匹配工资薪酬
getEl('f_remark').value = '发工资';
getEl('f_remark').oninput();
ok('输入摘要「发工资」自动把一级分类设为 工资薪酬', getEl('f_cat1').value === '工资薪酬');
ok('自动匹配后在表单内显示提示条', /已自动匹配/.test(getEl('catHint').innerHTML));

// 用户手动改分类为「餐饮招待」→ 之后输入再触发也不覆盖
getEl('f_cat1').value = '餐饮招待';
getEl('f_cat1').onchange();
getEl('f_remark').value = '午餐请客户';
getEl('f_remark').oninput();
ok('用户手动改过分类后停止自动匹配（不被覆盖）', getEl('f_cat1').value === '餐饮招待');

// ---------- 3. 批量归类 ----------
try { M.bulkAutoCategorize(); } catch (e) { /* 测试桩里 render() 可能抛，但归类已先写入 dbData */ }
ok('批量：e1(发工资) 归类为 工资薪酬', dbData[0].category === '工资薪酬');
ok('批量：e2(午餐招待) 归类为 餐饮招待', dbData[1].category === '餐饮招待');
ok('批量：e3(收到货款) 无匹配规则，仍为空白', dbData[2].category === '');
ok('批量：e4 已有分类(餐饮招待) 不被覆盖', dbData[3].category === '餐饮招待');
ok('批量：无匹配规则的 e3 未被改动金额/类型', dbData[2].type === 'income' && dbData[2].amount === 200);

console.log('\n科目智能匹配测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
