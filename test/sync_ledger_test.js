/* 集成测试：云端同步后账本列表能否真正同步并刷新
 * 不加载 main.js（DOM 依赖重），直接 stub FW.refreshLedgers 作为刷新探针。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('./setup');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://example.com/' });
const { window } = dom;
global.window = window;
global.document = window.document;

// localStorage stub
function makeLS() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    key: i => Array.from(m.keys())[i] || null,
    get length() { return m.size; }
  };
}
const ls = makeLS();
global.localStorage = ls;
window.localStorage = ls;

// 云端快照：含一个本地没有的账本 L2，且云端 currentLedger 为 L2
const cloudPayload = {
  _app: '财务工作台', _version: 3, _exportedAt: new Date().toISOString(),
  raw: {
    ledgers: [{ id: 'L1', name: '默认账本' }, { id: 'L2', name: '公司账(云端)' }],
    currentLedger: 'L2',
    internal_L1: [{ id: 't1', date: '2026-01-01', type: '收入', item: 'x', amount: 100 }]
  },
  photos: []
};
const captured = {};
const fakeSb = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.com' } } } }),
    onAuthStateChange: () => {},
    signOut: () => Promise.resolve({})
  },
  from: () => ({
    upsert: (row) => { captured.upsert = row; return Promise.resolve({ error: null }); },
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { data: cloudPayload }, error: null }) }) })
  })
};
window.supabase = { createClient: () => fakeSb };
window.APP_CONFIG = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'y' };

const spy = { called: 0 };
function load(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  (0, eval)(code);
}

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); failures++; }
}

load('db.js');
window.FW.toast = function () {};
window.FW.modules = { sidebar: { render: function () {} } };
window.FW.refreshLedgers = function () { spy.called++; };
window.FW.db.setLedgers([{ id: 'L1', name: '默认账本' }]);
window.FW.db.setCurrentLedger('L1');

load('sync.js'); // init() 自动跑：getSession → onLogin → syncNow → pull(云端) → importAll

setTimeout(function () {
  console.log('--- 1) 拉取同步后账本应刷新并合并 ---');
  assert(spy.called > 0, '云端同步后调用了 FW.refreshLedgers（账本切换器已刷新）');
  const ids = window.FW.db.getLedgers().map(l => l.id);
  assert(ids.indexOf('L1') >= 0 && ids.indexOf('L2') >= 0, '本地账本列表已合并云端账本 L2 -> ' + JSON.stringify(ids));
  assert(window.FW.db.getCurrentLedger() === 'L1', '当前账本保持本地选中(L1)，未被云端 currentLedger 覆盖');

  console.log('--- 2) 新建账本应经 dirty 标记进入推送快照 ---');
  window.FW.db.setLedgers([
    { id: 'L1', name: '默认账本' },
    { id: 'L2', name: '公司账(云端)' },
    { id: 'L3', name: '新建本地账本' }
  ]);
  window.FW.sync.push(true).then(function () {
    const rawLedgers = captured.upsert && captured.upsert.data && captured.upsert.data.raw && captured.upsert.data.raw.ledgers;
    assert(rawLedgers && rawLedgers.some(l => l.id === 'L3'), '新建账本 L3 已进入推送快照(ledgers)');
    console.log(failures === 0 ? '\n全部通过 ✅' : ('\n失败 ' + failures + ' 项 ❌'));
    process.exit(failures === 0 ? 0 : 1);
  }).catch(function (e) {
    console.error('push 验证异常', e);
    process.exit(1);
  });
}, 400);
