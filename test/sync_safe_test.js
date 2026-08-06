/* 同步安全测试：验证「拉取出错时绝不 push 覆盖云端」，以及两种安全同步模式。
 * 用最小桩模拟 Supabase + FW.db，避免依赖真实网络与 IndexedDB。 */
var path = require('path');

// ---------- 全局桩 ----------
global.window = global;
global.addEventListener = function () {};
global.confirm = function () { return true; };

var els = {};
global.document = {
  readyState: 'complete',
  getElementById: function (id) {
    if (!els[id]) els[id] = { innerHTML: '', onclick: null, style: {}, dataset: {}, textContent: '', value: '', classList: { add: function () {}, remove: function () {} } };
    return els[id];
  },
  addEventListener: function () {},
  querySelector: function () { return null; },
  visibilityState: 'visible'
};

var upsertCalls = 0;
var lastMerge = null;
var pullScenario = 'data'; // 'data' | 'empty' | 'error'

var mockSb = {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.com' } } } }); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    signOut: function () { return Promise.resolve({}); }
  },
  from: function () {
    return {
      select: function () {
        return {
          eq: function () {
            return {
              maybeSingle: function () {
                if (pullScenario === 'data') return Promise.resolve({ data: { data: { raw: { internal_L1: [] } } }, error: null });
                if (pullScenario === 'empty') return Promise.resolve({ data: null, error: null });
                return Promise.resolve({ error: { code: 'NET', message: '网络错误' }, data: null });
              }
            };
          }
        };
      },
      upsert: function () { upsertCalls++; return Promise.resolve({ error: null }); }
    };
  }
};
global.supabase = { createClient: function () { return mockSb; } };
global.APP_CONFIG = { SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'y' };

global.FW = {
  toast: function () {},
  ui: { setAuth: function () {}, setSyncTime: function () {} },
  esc: function (s) { return s; },
  refreshLedgers: function () {},
  modules: { sidebar: { render: function () {} } },
  setModule: function () {},
  internalAccMgr: { refreshAccts: function () {} },
  openModal: function () {},
  closeModal: function () {},
  db: {
    cryptoEnabled: function () { return false; },
    isUnlocked: function () { return true; },
    getCurrentLedger: function () { return 'L1'; },
    setCurrentLedger: function () {},
    exportSyncSnapshot: function () { return Promise.resolve({ raw: { internal_L1: [] }, photos: [] }); },
    importAll: function (snap, merge) { lastMerge = merge; return Promise.resolve(); },
    encryptSnapshot: function (obj) { return Promise.resolve(obj); },
    decryptSnapshot: function (payload) { return Promise.resolve(payload); }
  }
};

// 加载 sync.js（执行 init：恢复登录态，但**不再**自动同步；同步需手动调用 syncNow）
require(path.resolve(__dirname, '../js/sync.js'));

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  // init 不应自动同步（手动同步设计）：先验证「未自动」，再手动触发
  await delay(200);
  ok('init 后未自动同步：upsert 调用次数为 0（手动同步设计）', upsertCalls === 0);
  ok('init 后未自动同步：merge 未触发', lastMerge === null);

  // Case 1：手动调用 syncNow（云端有数据）应合并并推送
  await global.FW.sync.syncNow();
  ok('手动同步-云端有数据：已调用 upsert 推送合并数据', upsertCalls === 1);
  ok('手动同步-合并模式 merge=true', lastMerge === true);

  // Case 2：拉取出错时，绝不推送覆盖云端
  pullScenario = 'error';
  upsertCalls = 0;
  await global.FW.sync.syncNow();
  ok('拉取出错：本次同步未调用 upsert（不覆盖云端）', upsertCalls === 0);

  // Case 3：云端有数据再次同步，应合并并推送
  pullScenario = 'data';
  upsertCalls = 0;
  await global.FW.sync.syncNow();
  ok('云端有数据：再次调用 upsert 推送', upsertCalls === 1);

  // Case 4：以云端为准覆盖本机 → importAll(merge=false)，且不推送
  pullScenario = 'data';
  upsertCalls = 0;
  lastMerge = null;
  await global.FW.sync.overwriteFromCloud();
  ok('以云端为准：importAll 使用覆盖模式 merge=false', lastMerge === false);
  ok('以云端为准：不调用 upsert（不推送）', upsertCalls === 0);

  // Case 5：以本机为准覆盖云端 → 调用 upsert
  upsertCalls = 0;
  await global.FW.sync.forcePushLocal();
  ok('以本机为准：调用 upsert 覆盖云端', upsertCalls === 1);

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
