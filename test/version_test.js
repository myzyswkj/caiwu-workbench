/* 版本与备份 测试（fake DOM + localStorage 桩）
 * 1) VERSIONS 非空，第一条为当前版本
 * 2) render() 不抛错，输出含版本日志 / 数据备份与恢复 / ver-table
 * 3) 恢复此版本按钮 → 写入 localStorage 恢复请求；取消请求 → 清除
 * 4) 备份日志追加与读取
 */
global.window = global;

function fakeEl() {
  return {
    addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {} },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    appendChild: function () {}, setAttribute: function () {}, closest: function () { return null; },
    innerHTML: '', textContent: '', onclick: null, oninput: null, onchange: null, click: function () {}, files: []
  };
}
const domEls = {};
global.document = {
  getElementById: function (id) { if (!domEls[id]) domEls[id] = fakeEl(); return domEls[id]; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return fakeEl(); },
  body: fakeEl()
};

// localStorage 桩
const lsStore = {};
global.localStorage = {
  getItem: function (k) { return lsStore[k] === undefined ? null : lsStore[k]; },
  setItem: function (k, v) { lsStore[k] = String(v); },
  removeItem: function (k) { delete lsStore[k]; }
};

// 恢复按钮桩（render 通过 FW.qa 找到并绑定 onclick）
const fakeRbBtn = { getAttribute: function () { return 'fba41c3'; }, onclick: null };

global.FW = {
  esc: function (s) { return String(s == null ? '' : s); },
  toast: function () {},
  qa: function (sel) { return (sel && sel.indexOf('data-rollback') >= 0) ? [fakeRbBtn] : []; },
  modules: {},
  db: {
    exportAll: function () { return Promise.resolve({ photos: [] }); },
    importAll: function () { return Promise.resolve(); }
  }
};
global.confirm = function () { return true; };

const fs = require('fs');
const path = require('path');
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'version.js'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// 1) VERSIONS
const V = global.FW.versionCalc.VERSIONS;
ok('VERSIONS 非空', V.length > 0);
ok('第一条为当前版本(current)', V[0].status === 'current');
ok('当前版本号存在', !!V[0].v);

// 2) render 不抛错 + 关键片段
let html = '';
try {
  global.FW.modules.version.render();
  html = domEls['content'].innerHTML;
  ok('render() 不抛错', true);
} catch (e) { ok('render() 不抛错', false); console.log('    ' + e.stack); }
ok('含「版本日志」', html.indexOf('版本日志') >= 0);
ok('含「数据备份与恢复」', html.indexOf('数据备份与恢复') >= 0);
ok('含版本表 ver-table', html.indexOf('ver-table') >= 0);
ok('当前版本行高亮 ver-cur', html.indexOf('ver-cur') >= 0);

// 3) 恢复请求：触发 fakeRbBtn.onclick（render 已绑定）
let rb = null;
try {
  if (fakeRbBtn.onclick) fakeRbBtn.onclick();
  rb = global.FW.versionCalc.getRollback();
  ok('点击恢复按钮写入 localStorage 请求', !!rb && rb.v === 'fba41c3');
} catch (e) { ok('点击恢复按钮写入请求', false); console.log('    ' + e.stack); }
// 取消请求
try {
  var cancel = domEls['verRbCancel'];
  if (cancel && cancel.onclick) cancel.onclick();
  ok('取消请求后 getRollback 为空', global.FW.versionCalc.getRollback() === null);
} catch (e) { ok('取消请求', false); console.log('    ' + e.stack); }

// 4) 备份日志
global.FW.versionCalc.addBackupLog('export', '含 0 张照片凭证');
global.FW.versionCalc.addBackupLog('import', '已恢复数据');
const log = global.FW.versionCalc.getBackupLog();
ok('备份日志记录非空', log.length >= 2);
ok('最新一条为 import', log[0] && log[0].type === 'import');
ok('导出记录存在', log.some(function (x) { return x.type === 'export'; }));

console.log('\n版本与备份 测试：' + pass + ' 通过' + (fail ? (', ' + fail + ' 失败') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
