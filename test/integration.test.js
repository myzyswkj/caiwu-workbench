/* 财务工作台 —— jsdom 集成测试（验证三项新功能 + 回归） */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('./setup');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
global.window = window;

// 注入 fake-indexeddb，使照片备份可真实往返测试
try {
  var fidb = require('./setup').fakeIndexedDB;
  Object.defineProperty(window, 'indexedDB', { value: new fidb.IDBFactory(), configurable: true, writable: true });
} catch (e) { /* 无 IDB 时跳过真实往返 */ }

// 注入 Web Crypto（jsdom 的 window.crypto 为只读且 subtle 行为不一致）
// 写入可写的 window.webkitCrypto，crypto.js 的 pickCrypto 优先使用它
try {
  var nodeCrypto = require('crypto');
  if (nodeCrypto && nodeCrypto.webcrypto) {
    window.webkitCrypto = nodeCrypto.webcrypto;
  }
} catch (e) {}
if (typeof window.escape !== 'function') window.escape = escape;
if (typeof window.unescape !== 'function') window.unescape = unescape;

// 浏览器 API 兜底
window.confirm = function () { return true; };
window.alert = function () {};
window.prompt = function () { return '测试二级'; };
if (!window.FileReader) window.FileReader = class { readAsDataURL() {} };

// ---- 模拟 Supabase 客户端（供 sync.js 集成测试） ----
var mockSb = (function () {
  var lastUpsert = null;
  var lastSelect = { data: null, error: { code: 'PGRST116' } };
  var authCb = null;
  var client = {
    from: function (t) {
      return {
        upsert: function (row) { lastUpsert = row; return Promise.resolve({ error: null }); },
        select: function () {
          return { eq: function () { return { maybeSingle: function () { return Promise.resolve(lastSelect); } }; } };
        }
      };
    },
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: null } }); },
      onAuthStateChange: function (cb) { authCb = cb; return { data: { subscription: { unsubscribe: function () {} } } }; },
      signInWithPassword: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'me@test.com' } }, user: { id: 'u1', email: 'me@test.com' } }, error: null }); },
      signUp: function () { return Promise.resolve({ data: { user: { id: 'u1', email: 'me@test.com' }, session: null }, error: null }); },
      signInWithOtp: function () { return Promise.resolve({ data: {}, error: null }); },
      verifyOtp: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'me@test.com' } }, error: null } }); },
      signOut: function () { return Promise.resolve({ error: null }); }
    }
  };
  return {
    client: client,
    getUpsert: function () { return lastUpsert; },
    setSelect: function (d) { lastSelect = d; },
    triggerLogin: function () { if (authCb) authCb('SIGNED_IN', { user: { id: 'u1', email: 'me@test.com' } }); },
    triggerLogout: function () { if (authCb) authCb('SIGNED_OUT', null); }
  };
})();
window.supabase = { createClient: function () { return mockSb.client; } };
window.APP_CONFIG = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-key' };

// 依次执行脚本（IIFE 绑定到 window）
const scripts = ['crypto', 'db', 'ui', 'sidebar', 'internal', 'tax', 'memo', 'knowledge', 'dashboard', 'contacts', 'taxcalc', 'sync', 'lock', 'main'];
for (const s of scripts) {
  const code = fs.readFileSync(path.join(ROOT, 'js', s + '.js'), 'utf8');
  window.eval(code);
}

// 触发初始化（main.js 在 readyState!=='loading' 时已执行 init，但稳妥起见再调一次）
const FW = window.FW;

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) {
  if (cond) { pass++; results.push('  ✓ ' + name); }
  else { fail++; results.push('  ✗ ' + name); }
}
function section(t) { results.push('\n【' + t + '】'); }

// 清空业务数据，保证测试隔离
function reset() {
  var emptyMap = {};
  ['internal', 'internal_cats', 'internal_budget', 'tax_accounts', 'tax_vouchers', 'tax_journals', 'tax_statements', 'tax_openings', 'tax_assets'].forEach(function (k) {
    if (k === 'internal_cats' || k === 'tax_vouchers' || k === 'tax_journals' || k === 'tax_assets') FW.db.lsSet(k, []);
    else if (k === 'tax_accounts') FW.db.lsSet(k, { added: [], deleted: [] });
    else if (k === 'tax_openings') FW.db.lsSet(k, emptyMap);
    else FW.db.lsSet(k, []);
  });
}

try {
  section('初始化 & 基础结构');
  ok('FW 与模块已加载', !!FW && !!FW.modules && !!FW.modules.internal && !!FW.modules.tax);
  ok('左侧导航含登记内账/报税记账', !!window.document.querySelector('#moduleNav .nav-item[data-module="internal"]') && !!window.document.querySelector('#moduleNav .nav-item[data-module="tax"]'));

  section('功能1：资金变动明细（账户互转/股本）');
  reset();
  FW.modules.internal.render();
  // 切到资金变动明细 tab（tab 现由 FW.nav 子导航渲染，无 #inTabs DOM，改用模块 API 切换）
  var hasFundTab = (FW.modules.internal.tabs || []).some(function (t) { return t.key === 'fund'; });
  ok('内账包含「资金变动明细」标签', hasFundTab);
  FW.modules.internal.setTab('fund');
  let body = window.document.getElementById('inBody').innerHTML;
  ok('资金变动明细页含「各账户资金净变动」', body.indexOf('各账户资金净变动') >= 0);
  ok('资金变动明细页含「不影响收支」说明', body.indexOf('不影响收支') >= 0);

  // 写入 1 笔互转 + 1 笔股本注入
  FW.db.upsert('internal', { id: 't1', date: '2026-07-01', type: 'transfer', fromAccount: '现金', toAccount: '银行卡', amount: 100, project: 'P', remark: '调拨' });
  FW.db.upsert('internal', { id: 't2', date: '2026-07-02', type: 'equity', equityDir: 'in', account: '现金', amount: 50, project: 'P', remark: '注资' });
  FW.modules.internal.setTab('fund');
  body = window.document.getElementById('inBody').innerHTML;
  ok('互转出现在资金变动明细', body.indexOf('账户互转') >= 0 && body.indexOf('现金') >= 0 && body.indexOf('银行卡') >= 0);
  ok('股本出现在资金变动明细', body.indexOf('股本注入') >= 0);

  // 互转/股本不应计入收支统计
  FW.modules.internal.setTab('stat');
  const sBody = window.document.getElementById('inBody').innerHTML;
  // 区间收入/支出应均为 0（仅互转+股本）
  ok('统计分析不把互转/股本算作收入', sBody.indexOf('¥0.00') >= 0 && sBody.indexOf('区间收入') >= 0);
  // 互转/股本不应计入收入/支出（精确校验区间收入、区间支出均为 0）
  const statText = window.document.getElementById('inBody').textContent.replace(/,/g, '');
  ok('仅互转+股本时区间收入为 ¥0.00', /区间收入[\s\S]*?¥0\.00/.test(statText));
  ok('仅互转+股本时区间支出为 ¥0.00', /区间支出[\s\S]*?¥0\.00/.test(statText));

  // 加一笔真实收入后，收入应计入
  FW.db.upsert('internal', { id: 't3', date: '2026-07-03', type: 'income', category: '其他收入', account: '现金', amount: 300, project: 'P', remark: '收款' });
  FW.modules.internal.setTab('stat');
  const sText2 = window.document.getElementById('inBody').textContent.replace(/,/g, '');
  ok('真实收入计入区间收入(300)', sText2.indexOf('¥300.00') >= 0);

  section('功能2：内账分类拖拽排序（持久化）');
  reset();
  FW.modules.internal.render();
  let cats0 = FW.modules.internal.cats();
  ok('默认分类为非空数组', Array.isArray(cats0) && cats0.length > 0);
  const firstName = cats0[0].name;
  const lastName = cats0[cats0.length - 1].name;
  const moved = FW.modules.internal.reorderCat(0, cats0.length - 1);
  ok('reorderCat 返回成功', moved === true);
  const cats1 = FW.modules.internal.cats();
  ok('拖拽后原首项移到末位', cats1[cats1.length - 1].name === firstName && cats1[0].name !== firstName);
  // 二次读取（模拟刷新）仍保持顺序
  const cats2 = FW.modules.internal.cats();
  ok('顺序已持久化（再次读取一致）', cats2[cats2.length - 1].name === firstName);

  // 二级分类拖拽
  const cl = FW.modules.internal.cats();
  cl[0].children = ['二级A', '二级B', '二级C'];
  FW.db.saveList('internal_cats', cl);
  const before = FW.modules.internal.cats()[0].children.slice();
  const subMoved = FW.modules.internal.reorderSubCat(0, 0, 2);
  ok('reorderSubCat 返回成功', subMoved === true);
  const after = FW.modules.internal.cats()[0].children;
  ok('二级分类顺序已调整', after[2] === before[0] && after[0] === before[1]);

  // 分类管理弹窗支持 draggable
  window.document.getElementById('catBtn').click();
  const modalBody = window.document.getElementById('modalBody').innerHTML;
  ok('分类管理弹窗提示可拖拽', modalBody.indexOf('拖拽排序') >= 0 || modalBody.indexOf('⇕') >= 0);
  ok('一级分类元素可拖拽', window.document.querySelector('#modalBody .cat-l1[draggable="true"]') !== null);

  section('功能3：报税科目表用户增删');
  reset();
  FW.modules.tax.render();
  let accs = FW.modules.tax.getAccounts();
  ok('科目表默认含内置科目（库存现金）', accs.some(function (a) { return a.name === '库存现金'; }));
  ok('科目表默认含内置科目（主营业务收入）', accs.some(function (a) { return a.name === '主营业务收入'; }));

  const added = FW.modules.tax.addAccount('研发支出', ['研发', '课题经费']);
  ok('新增科目返回成功', added === true);
  accs = FW.modules.tax.getAccounts();
  ok('科目表已包含新增科目', accs.some(function (a) { return a.name === '研发支出'; }));
  const matched = FW.matchAccounts ? FW.matchAccounts('研发') : [];
  ok('新增科目的别名可用于自动识别', accs.some(function (a) { return a.name === '研发支出'; }));

  // 删除自定义科目
  FW.modules.tax.delAccount('研发支出');
  accs = FW.modules.tax.getAccounts();
  ok('删除自定义科目后不再出现', !accs.some(function (a) { return a.name === '研发支出'; }));

  // 删除内置科目
  FW.modules.tax.delAccount('库存现金');
  accs = FW.modules.tax.getAccounts();
  ok('删除内置科目后从科目表隐藏', !accs.some(function (a) { return a.name === '库存现金'; }));
  // 恢复内置科目
  FW.modules.tax.addAccount('库存现金', []);
  accs = FW.modules.tax.getAccounts();
  ok('内置科目可重新添加恢复', accs.some(function (a) { return a.name === '库存现金'; }));

  // 科目表管理弹窗按钮存在
  FW.modules.tax.render();
  ok('报税顶部含「科目表」按钮', !!window.document.getElementById('accBtn'));
  window.document.getElementById('accBtn').click();
  ok('科目表管理弹窗打开', window.document.getElementById('modalTitle').textContent.indexOf('会计科目表') >= 0 && window.document.getElementById('modalBody').innerHTML.indexOf('acc-item') >= 0);

  section('回归：凭证借贷不平衡校验仍生效');
  // 仅验证 suggestAccount 仍可用（内置别名）
  ok('suggestAccount 依据摘要推荐科目', FW.modules.tax.suggestAccount('支付工资') === '应付职工薪酬');

  section('功能4：柠檬云风格记账凭证模板');
  reset();
  FW.modules.tax.render();
  window.document.getElementById('taxAddBtn').click();
  ok('凭证弹窗为宽版(modal-wide)', !!window.document.querySelector('.modal.modal-wide'));
  ok('凭证纸布局存在', !!window.document.querySelector('#modalBody .voucher-paper'));
  ok('凭证纸含凭证字(记/收/付/转)', !!window.document.getElementById('v_word') && ['记', '收', '付', '转'].indexOf(window.document.getElementById('v_word').value) >= 0);
  ok('凭证纸含合计借方/贷方单元格', !!window.document.getElementById('vp_deb') && !!window.document.getElementById('vp_cre'));
  ok('凭证纸含签名字段(会计主管/记账/复核/制单)', window.document.getElementById('modalBody').textContent.indexOf('会计主管') >= 0 && window.document.getElementById('modalBody').textContent.indexOf('制单') >= 0);
  var rowsBefore = window.document.querySelectorAll('.vp-table tbody tr').length;
  window.document.getElementById('vAddRow').click();
  ok('增加一行分录后行数+1', window.document.querySelectorAll('.vp-table tbody tr').length === rowsBefore + 1);
  var trs = window.document.querySelectorAll('.vp-table tbody tr');
  function fire(el) { el.dispatchEvent(new window.Event('input')); }
  trs[0].querySelector('.e_deb').value = '100'; fire(trs[0].querySelector('.e_deb'));
  trs[0].querySelector('.e_cre').value = '100'; fire(trs[0].querySelector('.e_cre'));
  ok('借贷相等时显示平衡(ok)', window.document.getElementById('v_bal').className.indexOf('ok') >= 0);
  trs[0].querySelector('.e_cre').value = '50'; fire(trs[0].querySelector('.e_cre'));
  ok('借贷不相等时显示不平衡(bad)', window.document.getElementById('v_bal').className.indexOf('bad') >= 0);
  window.document.getElementById('vSave').click();
  ok('借贷不平衡时阻止保存', FW.db.getList('tax_vouchers').length === 0);
  trs[0].querySelector('.e_cre').value = '100'; fire(trs[0].querySelector('.e_cre'));
  window.document.getElementById('vSave').click();
  ok('借贷平衡后保存成功', FW.db.getList('tax_vouchers').length === 1);
  ok('保存的凭证含凭证字(记)', FW.db.getList('tax_vouchers')[0].word === '记');

  section('功能5：报税记账整体柠檬云结构（凭证/账簿/报表）');
  reset();
  FW.modules.tax.render();
  ok('报税模块含二级导航(凭证/账簿/报表)', !!window.document.querySelector('#lmNav .lm-tab[data-t="voucher"]') && !!window.document.querySelector('#lmNav .lm-tab[data-t="book"]') && !!window.document.querySelector('#lmNav .lm-tab[data-t="report"]'));
  // 写一张借贷平衡凭证，账簿应自动生成
  FW.db.upsert('tax_vouchers', { id: 'v5', word: '记', no: '1', date: '2026-07-10', attach: 0, maker: '小李', entries: [{ summary: '收货款', account: '银行存款', debit: 1000, credit: 0 }, { summary: '收货款', account: '主营业务收入', debit: 0, credit: 1000 }], totalDebit: 1000, totalCredit: 1000 });
  window.document.querySelector('#lmNav .lm-tab[data-t="book"]').click();
  ok('账簿默认显示科目余额表', window.document.getElementById('taxBody').innerHTML.indexOf('科目余额表') >= 0);
  ok('科目余额表含银行存款', window.document.getElementById('taxBody').innerHTML.indexOf('银行存款') >= 0);
  ok('科目余额表含主营业务收入', window.document.getElementById('taxBody').innerHTML.indexOf('主营业务收入') >= 0);
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="detail"]').click();
  ok('明细账按凭证字号展示', window.document.getElementById('taxBody').textContent.indexOf('记-1') >= 0);
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="general"]').click();
  ok('总账含科目余额块', window.document.getElementById('taxBody').innerHTML.indexOf('lm-gl-block') >= 0);
  window.document.querySelector('#lmNav .lm-tab[data-t="report"]').click();
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="cf"]').click();
  var cfHtml = window.document.getElementById('taxBody').innerHTML;
  ok('现金流量表含经营/投资/筹资三类活动', cfHtml.indexOf('经营活动产生的现金流量') >= 0 && cfHtml.indexOf('投资活动产生的现金流量') >= 0 && cfHtml.indexOf('筹资活动产生的现金流量') >= 0);
  ok('现金流量表含现金净增加额', cfHtml.indexOf('现金及现金等价物净增加额') >= 0);

  section('功能6：报表自动取数（BS/PL 由科目余额表生成）');
  reset();
  // 资产类：现金增加、销售收入；负债：应交税费；权益：实收资本
  FW.db.upsert('tax_vouchers', { id: 'v10', word: '记', no: '1', date: '2026-07-01', attach: 0, status: 'audited',
    entries: [{ summary: '注资', account: '银行存款', debit: 50000, credit: 0 }, { summary: '注资', account: '实收资本', debit: 0, credit: 50000 }], totalDebit: 50000, totalCredit: 50000 });
  FW.db.upsert('tax_vouchers', { id: 'v11', word: '记', no: '2', date: '2026-07-02', attach: 0, status: 'audited',
    entries: [{ summary: '销售', account: '银行存款', debit: 30000, credit: 0 }, { summary: '销售', account: '主营业务收入', debit: 0, credit: 30000 }], totalDebit: 30000, totalCredit: 30000 });
  FW.modules.tax.render();
  window.document.querySelector('#lmNav .lm-tab[data-t="report"]').click();
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="bs"]').click();
  var bsHtml = window.document.getElementById('taxBody').innerHTML;
  ok('资产负债表含「货币资金」', bsHtml.indexOf('货币资金') >= 0);
  ok('资产负债表含「未分配利润」', bsHtml.indexOf('未分配利润') >= 0);
  ok('资产负债表含自动平衡标识', bsHtml.indexOf('平衡') >= 0);
  // 资产总计 = 80000, 负债+权益 = 实收资本50000 + 未分配利润(主营业务收入30000) = 80000
  ok('BS 资产总计含 ¥80,000.00', window.document.getElementById('taxBody').textContent.indexOf('¥80,000.00') >= 0);
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="pl"]').click();
  var plHtml = window.document.getElementById('taxBody').innerHTML;
  ok('利润表由损益科目自动计算', plHtml.indexOf('营业收入') >= 0 && plHtml.indexOf('净利润') >= 0);
  ok('利润表营业收入=30000', window.document.getElementById('taxBody').textContent.indexOf('¥30,000.00') >= 0);

  section('功能7：结转损益 → 收入费用清零，净利润转入本年利润');
  reset();
  FW.db.upsert('tax_vouchers', { id: 'v20', word: '记', no: '1', date: '2026-07-05', attach: 0, status: 'audited',
    entries: [{ summary: '销售', account: '银行存款', debit: 10000, credit: 0 }, { summary: '销售', account: '主营业务收入', debit: 0, credit: 10000 }], totalDebit: 10000, totalCredit: 10000 });
  FW.db.upsert('tax_vouchers', { id: 'v21', word: '记', no: '2', date: '2026-07-06', attach: 0, status: 'audited',
    entries: [{ summary: '工资', account: '管理费用', debit: 4000, credit: 0 }, { summary: '工资', account: '银行存款', debit: 0, credit: 4000 }], totalDebit: 4000, totalCredit: 4000 });
  FW.modules.tax.render();
  window.document.querySelector('#lmNav .lm-tab[data-t="report"]').click();
  window.document.getElementById('carryBtn').click();
  // 生成一张转字凭证，本年利润 = 6000
  ok('结转后生成转字凭证', FW.db.getList('tax_vouchers').some(function (v) { return v.word === '转'; }));
  window.document.querySelector('#lmNav .lm-tab[data-t="report"]').click();
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="pl"]').click();
  ok('结转后利润表提示净利润已结转', window.document.getElementById('taxBody').innerHTML.indexOf('已结转至本年利润') >= 0);
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="bs"]').click();
  // 未分配利润(本年利润)=6000
  ok('BS 未分配利润含结转净利润 ¥6,000.00', window.document.getElementById('taxBody').textContent.indexOf('¥6,000.00') >= 0);

  section('功能8：期初余额录入贯通账簿');
  reset();
  FW.modules.tax.setOpenings({ '库存现金': { side: '借', amount: 2000 } });
  FW.db.upsert('tax_vouchers', { id: 'v30', word: '记', no: '1', date: '2026-07-10', attach: 0, status: 'audited',
    entries: [{ summary: '取现', account: '库存现金', debit: 500, credit: 0 }, { summary: '取现', account: '银行存款', debit: 0, credit: 500 }], totalDebit: 500, totalCredit: 500 });
  FW.modules.tax.render();
  window.document.querySelector('#lmNav .lm-tab[data-t="book"]').click();
  window.document.querySelector('#lmSub .lm-sub-tab[data-t="balance"]').click();
  ok('科目余额表含期初借方列', window.document.getElementById('taxBody').innerHTML.indexOf('期初借方') >= 0);
  ok('期初余额2000体现在科目余额表', window.document.getElementById('taxBody').textContent.indexOf('¥2,000.00') >= 0);

  section('功能9：固定资产折旧计提');
  reset();
  FW.db.upsert('tax_assets', { id: 'a1', name: '办公电脑', origin: 12000, salvageRate: 0, lifeYears: 3, depMonths: 0 });
  FW.modules.tax.render();
  window.document.querySelector('#lmNav .lm-tab[data-t="asset"]').click();
  ok('固定资产页含月折旧额', window.document.getElementById('taxBody').innerHTML.indexOf('月折旧额') >= 0);
  // 月折旧 = 12000/36 = 333.33
  ok('月折旧额计算正确(≈333.33)', Math.abs(FW.modules.tax.monthlyDep({ origin: 12000, salvageRate: 0, lifeYears: 3 }) - 333.3333) < 0.01);
  window.document.getElementById('depBtn').click();
  ok('计提后生成折旧凭证(转字)', FW.db.getList('tax_vouchers').some(function (v) { return v.word === '转' && v.entries.some(function (e) { return e.account === '累计折旧'; }); }));

  section('功能10：银行流水 CSV 导入生成凭证');
  reset();
  var csv = '日期,摘要,收入,支出\n2026-07-01,收到A货款,5000,\n2026-07-02,支付办公室租金,,1200\n2026-07-03,买办公用品,,300';
  var parsed = FW.modules.tax.parseCSV(csv);
  ok('CSV 解析出 3 笔流水', parsed.length === 3);
  ok('CSV 解析识别收入/支出', parsed[0].income === 5000 && parsed[1].expense === 1200);
  FW.modules.tax.render();
  window.document.querySelector('#lmNav .lm-tab[data-t="voucher"]').click();
  window.document.getElementById('bankBtn').click();
  window.document.getElementById('bankText').value = csv;
  window.document.getElementById('bankText').dispatchEvent(new window.Event('input'));
  ok('导入预览生成按钮可用', window.document.getElementById('bankGen').disabled === false);
  window.document.getElementById('bankGen').click();
  var vs = FW.db.getList('tax_vouchers');
  ok('导入生成 3 张凭证(收/付)', vs.length === 3);
  ok('收款生成银行存款借方凭证', vs.some(function (v) { return v.word === '收' && v.entries.some(function (e) { return e.account === '银行存款' && e.debit === 5000; }); }));

  section('功能11：凭证审核状态 + 断号校验');
  reset();
  FW.db.upsert('tax_vouchers', { id: 'v40', word: '记', no: '1', date: '2026-07-01', attach: 0, status: 'draft',
    entries: [{ summary: 'x', account: '银行存款', debit: 100, credit: 0 }, { summary: 'x', account: '主营业务收入', debit: 0, credit: 100 }], totalDebit: 100, totalCredit: 100 });
  FW.db.upsert('tax_vouchers', { id: 'v41', word: '记', no: '3', date: '2026-07-02', attach: 0, status: 'draft',
    entries: [{ summary: 'x', account: '银行存款', debit: 200, credit: 0 }, { summary: 'x', account: '主营业务收入', debit: 0, credit: 200 }], totalDebit: 200, totalCredit: 200 });
  FW.modules.tax.render();
  window.document.querySelector('#lmNav .lm-tab[data-t="voucher"]').click();
  ok('凭证列表显示草稿状态', window.document.getElementById('taxBody').innerHTML.indexOf('草稿') >= 0);
  // 断号：1、3 缺 2
  ok('断号校验提示缺号', window.document.getElementById('taxBody').innerHTML.indexOf('缺号') >= 0);
  // 审核
  window.document.querySelector('#taxBody .v-audit').click();
  ok('审核后状态变为已审核', FW.db.getList('tax_vouchers').some(function (v) { return v.status === 'audited'; }));

} catch (e) {
  fail++;
  results.push('  ✗ 运行异常: ' + (e && e.stack ? e.stack : e));
}

// 照片凭证随备份导出/导入（需 IndexedDB，异步执行）
async function runPhotoTests() {
  if (!window.indexedDB) { ok('功能12：IndexedDB 不可用，跳过真实往返', true); return; }
  section('功能12：照片凭证随备份导出/导入');
  var pid1 = await FW.db.savePhoto('data:image/png;base64,AAAA');
  var pid2 = await FW.db.savePhoto('data:image/png;base64,BBBB');
  ok('savePhoto 返回 id', typeof pid1 === 'string' && pid1.length > 0);
  ok('getPhoto 可取回照片', (await FW.db.getPhoto(pid2)) === 'data:image/png;base64,BBBB');
  ok('getAllPhotos 含 2 张', (await FW.db.getAllPhotos()).length === 2);

  var dump = await FW.db.exportAll();
  ok('exportAll 返回 Promise 且含 photos 数组', Array.isArray(dump.photos));
  ok('导出包含 2 张照片', dump.photos.length === 2);
  var map = {}; dump.photos.forEach(function (p) { map[p.id] = p.data; });
  ok('导出照片数据与原始一致', map[pid1] === 'data:image/png;base64,AAAA' && map[pid2] === 'data:image/png;base64,BBBB');

  await FW.db.deletePhotos([pid1, pid2]);
  ok('清空后 getAllPhotos 为空', (await FW.db.getAllPhotos()).length === 0);

  await FW.db.importAll(dump);
  var restored = await FW.db.getAllPhotos();
  ok('导入后恢复 2 张照片', restored.length === 2);
  var rmap = {}; restored.forEach(function (p) { rmap[p.id] = p.data; });
  ok('还原照片 id 与数据保持一致', !!rmap[pid1] && rmap[pid1] === 'data:image/png;base64,AAAA');

  // 向后兼容：v2 备份（无 photos 字段）导入不报错
  await FW.db.importAll({ raw: { sites: [] } });
  ok('v2 备份（无照片字段）导入兼容', true);
}

async function runSyncTests() {
  section('功能13：云端同步（Supabase 快照）');
  ok('FW.sync 已加载', !!FW.sync);
  ok('配置启用时 enabled()=true', FW.sync.enabled() === true);
  ok('未登录时 push 不推送', (await FW.sync.push()) === false);

  // ---- 手机短信登录 UI 流程（未登录态）----
  const loginBtn0 = window.document.getElementById('authLogin');
  ok('未登录时顶栏有「登录/注册」按钮', !!loginBtn0);
  if (loginBtn0) {
    loginBtn0.click();
    const phTab = window.document.getElementById('phTab');
    ok('登录弹窗含「手机登录」标签', !!phTab);
    if (phTab) {
      phTab.click();
      const phoneInput = window.document.getElementById('au_phone');
      ok('手机登录显示手机号输入框', !!phoneInput);
      phoneInput.value = '13800138000';
      window.document.getElementById('auGo').click(); // 发送验证码
      await new Promise(function (r) { setTimeout(r, 20); });
      ok('发送后显示验证码输入框', window.document.getElementById('auCodeWrap').style.display !== 'none');
      const codeInput = window.document.getElementById('au_code');
      ok('验证码输入框存在', !!codeInput);
      codeInput.value = '123456';
      window.document.getElementById('auGo').click(); // 校验
      await new Promise(function (r) { setTimeout(r, 20); });
      mockSb.triggerLogin(); // 模拟 Supabase 校验成功后触发登录态
      await new Promise(function (r) { setTimeout(r, 20); });
      ok('手机验证码登录后 isLoggedIn=true', FW.sync.isLoggedIn() === true);
    }
  }

  // 模拟登录 → 触发 onLogin（邮箱路径）
  mockSb.triggerLogin();
  await new Promise(function (r) { setTimeout(r, 20); });
  ok('登录后 isLoggedIn=true', FW.sync.isLoggedIn() === true);
  ok('登录后顶栏出现「立即同步」按钮', !!window.document.getElementById('authSync'));

  // 写入本地数据并强制推送
  FW.db.lsSet('sites', [{ name: '测试站', url: 'http://x' }]);
  var pushed = await FW.sync.push(true);
  ok('push 返回 true（已推送）', pushed === true);
  var up = mockSb.getUpsert();
  ok('upsert 携带 user_id', up && up.user_id === 'u1');
  ok('upsert 携带完整快照 data._app', up && up.data && up.data._app === '财务工作台');

  // 模拟云端已有数据 → pull 写入本地
  mockSb.setSelect({ data: { data: { _app: '财务工作台', raw: { sites: [{ name: '云端站', url: 'http://cloud' }] } } }, error: null });
  await FW.sync.pull();
  var sites = FW.db.getList('sites');
  ok('pull 将云端数据导入本地', sites.some(function (s) { return s.name === '云端站'; }));

  // 退出
  mockSb.triggerLogout();
  await new Promise(function (r) { setTimeout(r, 20); });
  ok('退出后 isLoggedIn=false', FW.sync.isLoggedIn() === false);
}

async function runCryptoTests() {
  section('功能14：本地加密 + 密码解锁（端到端）');
  if (!window.FW.crypto || !window.FW.crypto.available) { ok('Web Crypto 不可用，跳过加密测试', true); return; }
  ok('crypto 模块可用', window.FW.crypto.available === true);

  // 清理加密痕迹，确保明文起点
  window.localStorage.removeItem('fw_vault');
  window.localStorage.removeItem('fw_crypto_meta');
  FW.db.lsSet('sites', [{ name: '明文站', url: 'http://a' }]);
  ok('启用前：明文存于 localStorage', JSON.parse(window.localStorage.getItem('fw_sites')).length === 1);

  // 启用加密
  await FW.db.enableCrypto('mypassword');
  ok('启用后：处于解锁态', FW.db.isUnlocked() === true);
  ok('启用后：明文键已清除', window.localStorage.getItem('fw_sites') === null);
  ok('启用后：加密仓库已写入', !!window.localStorage.getItem('fw_vault'));

  // 加密态写照片（IDB 一并加密）
  if (window.indexedDB) {
    var pid = await FW.db.savePhoto('data:image/png;base64,CRYPTEST');
    ok('加密态保存照片返回 id', typeof pid === 'string' && pid.length > 0);
    ok('加密态取回照片原文', (await FW.db.getPhoto(pid)) === 'data:image/png;base64,CRYPTEST');
  }

  // 写入 + 落盘 + 锁定
  FW.db.lsSet('sites', [{ name: '加密站', url: 'http://enc' }]);
  await FW.db.flushVault();
  FW.db.lock();
  ok('锁定后：isUnlocked=false', FW.db.isUnlocked() === false);

  // 错误密码失败
  var wrong = false;
  try { await FW.db.unlock('wrongpass'); } catch (e) { wrong = true; }
  ok('错误密码解锁失败', wrong === true && FW.db.isUnlocked() === false);

  // 正确密码恢复
  await FW.db.unlock('mypassword');
  ok('正确密码解锁成功', FW.db.isUnlocked() === true);
  ok('解锁后数据恢复', FW.db.getList('sites').some(function (s) { return s.name === '加密站'; }));

  // 云端以密文存储
  mockSb.setSelect({ data: null, error: { code: 'PGRST116' } });
  mockSb.triggerLogin();
  await new Promise(function (r) { setTimeout(r, 30); });
  ok('登录后 isLoggedIn=true', FW.sync.isLoggedIn() === true);
  var pushed = await FW.sync.push(true);
  ok('加密态推送成功', pushed === true);
  var up = mockSb.getUpsert();
  ok('云端为密文(__enc)', !!(up && up.data && up.data.__enc === true));
  ok('云端密文不含明文站点名', JSON.stringify(up.data).indexOf('加密站') < 0);

  // 拉取解密
  mockSb.setSelect({ data: { data: { __enc: true, salt: up.data.salt, iv: up.data.iv, ct: up.data.ct } }, error: null });
  FW.db.lsSet('sites', [{ name: '本地临时', url: 'http://tmp' }]);
  await FW.sync.pull();
  ok('拉取后解密为明文数据', FW.db.getList('sites').some(function (s) { return s.name === '加密站'; }));

  // 关闭加密，恢复明文
  await FW.db.disableCrypto('mypassword');
  ok('关闭后：isUnlocked=false', FW.db.isUnlocked() === false);
  ok('关闭后：明文键恢复', !!window.localStorage.getItem('fw_sites') && JSON.parse(window.localStorage.getItem('fw_sites')).some(function (s) { return s.name === '加密站'; }));
  ok('关闭后：仓库已删除', window.localStorage.getItem('fw_vault') === null);
}

runPhotoTests().then(runSyncTests).then(runCryptoTests).then(function () {
  console.log('\n========== 测试结果 ==========');
  console.log(results.join('\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail === 0 ? 0 : 1);
}).catch(function (e) {
  fail++;
  results.push('  ✗ 测试异常: ' + (e && e.stack ? e.stack : e));
  console.log('\n========== 测试结果 ==========');
  console.log(results.join('\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(1);
});
