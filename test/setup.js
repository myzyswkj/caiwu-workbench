/* ============================================================
 * 测试公共依赖解析（jsdom / fake-indexeddb）
 *
 * 解决问题：裸 require('jsdom') 仅在项目本地装了依赖（npm install）后能解析；
 * 否则抛 MODULE_NOT_FOUND，导致 10 个测试文件在新环境全崩。
 *
 * 本 shim 的策略：
 *   1) 优先 require('jsdom') —— 项目执行过 `npm install` 后命中本地 node_modules
 *   2) 回退到 WorkBuddy 沙箱 workspace 路径 —— 免安装即可在当前环境跑
 *   3) 都没有则抛出明确错误，提示执行 npm install
 *
 * 各测试文件统一改为：var JSDOM = require('./setup').JSDOM;
 * 或：const { JSDOM } = require('./setup');
 * fake-indexeddb：var fidb = require('./setup').fakeIndexedDB;（可能为 null）
 * ============================================================ */
var JSDOM, fakeIndexedDB;

try {
  JSDOM = require('jsdom').JSDOM;
} catch (e1) {
  try {
    JSDOM = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom').JSDOM;
  } catch (e2) {
    throw new Error('未找到 jsdom。请在项目根目录执行 `npm install`，或确认依赖已安装。');
  }
}

try {
  fakeIndexedDB = require('fake-indexeddb');
} catch (e1) {
  try {
    fakeIndexedDB = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/fake-indexeddb');
  } catch (e2) {
    fakeIndexedDB = null; // 无 IDB 时照片往返测试自动跳过，不阻断其余用例
  }
}

module.exports = { JSDOM: JSDOM, fakeIndexedDB: fakeIndexedDB };
