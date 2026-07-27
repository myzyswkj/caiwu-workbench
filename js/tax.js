/* ============================================================
 * 报税记账模块（柠檬云风格：凭证 / 账簿 / 固定资产 / 报表）
 * 账簿与报表均由记账凭证自动汇总生成
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var VK = 'tax_vouchers';
  var JK = 'tax_journals';
  var SK = 'tax_statements';
  var TK = 'tax_templates';
  var OK = 'tax_openings';   // 期初余额（按账套隔离）
  var AK = 'tax_assets';     // 固定资产（按账套隔离）

  // 预置常用凭证模板（标准会计分录，金额留空由用户填报）
  var PRESET = [
    { name: '计提工资', entries: [{ summary: '计提本月工资', account: '管理费用-工资', debit: '', credit: '' }, { summary: '计提工资', account: '应付职工薪酬', debit: '', credit: '' }] },
    { name: '发放工资', entries: [{ summary: '发放工资', account: '应付职工薪酬', debit: '', credit: '' }, { summary: '发放工资', account: '银行存款', debit: '', credit: '' }] },
    { name: '计提折旧', entries: [{ summary: '计提折旧', account: '管理费用-折旧费', debit: '', credit: '' }, { summary: '计提折旧', account: '累计折旧', debit: '', credit: '' }] },
    { name: '摊销费用', entries: [{ summary: '摊销待摊费用', account: '管理费用', debit: '', credit: '' }, { summary: '摊销', account: '长期待摊费用', debit: '', credit: '' }] },
    { name: '交房租', entries: [{ summary: '支付房租', account: '管理费用-房租', debit: '', credit: '' }, { summary: '支付房租', account: '银行存款', debit: '', credit: '' }] },
    { name: '结转收入', entries: [{ summary: '结转主营业务收入', account: '主营业务收入', debit: '', credit: '' }, { summary: '结转收入', account: '本年利润', debit: '', credit: '' }] },
    { name: '结转成本', entries: [{ summary: '结转成本费用', account: '本年利润', debit: '', credit: '' }, { summary: '结转成本', account: '主营业务成本', debit: '', credit: '' }] },
    { name: '缴纳增值税', entries: [{ summary: '缴纳增值税', account: '应交税费-应交增值税', debit: '', credit: '' }, { summary: '交税', account: '银行存款', debit: '', credit: '' }] },
    { name: '计提附加税', entries: [{ summary: '计提附加税费', account: '税金及附加', debit: '', credit: '' }, { summary: '计提附加税', account: '应交税费-附加税', debit: '', credit: '' }] },
    { name: '计提所得税', entries: [{ summary: '计提企业所得税', account: '所得税费用', debit: '', credit: '' }, { summary: '计提所得税', account: '应交税费-应交所得税', debit: '', credit: '' }] }
  ];

  // 会计科目表（含常用别名关键词，用于自动识别）
  var CHART = [
    { name: '库存现金', kw: ['现金', '现钞'] },
    { name: '银行存款', kw: ['银行', '存款', '工行', '中行', '农行', '建行', '招行', '网银', '对公', '基本户', '账户'] },
    { name: '其他货币资金', kw: ['汇票', '本票', '外埠存款'] },
    { name: '应收账款', kw: ['应收', '欠款', '客户欠', '客户', '回款'] },
    { name: '预付账款', kw: ['预付', '订金', '定金', '预付款'] },
    { name: '应收票据', kw: ['票据', '承兑汇票', '商票'] },
    { name: '原材料', kw: ['材料', '原料', '钢材', '辅料'] },
    { name: '库存商品', kw: ['库存', '商品', '成品', '货物'] },
    { name: '固定资产', kw: ['固定资产', '设备', '机器', '车辆'] },
    { name: '累计折旧', kw: ['折旧', '摊销费'] },
    { name: '无形资产', kw: ['无形资产', '专利', '软件著作权', '商标'] },
    { name: '长期待摊费用', kw: ['待摊', '摊销', '装修'] },
    { name: '短期借款', kw: ['短期借款', '借款', '贷款', '融资', '拆借'] },
    { name: '应付账款', kw: ['应付', '供应商', '货款', '采购款'] },
    { name: '预收账款', kw: ['预收', '订金'] },
    { name: '应付职工薪酬', kw: ['工资', '薪酬', '社保', '公积金', '职工', '个税代扣', '代发', '奖金', '劳务费'] },
    { name: '应交税费', kw: ['税', '增值税', '所得税', '附加税', '城建税', '社保', '公积金', '个税', '印花税', '缴款'] },
    { name: '应付利息', kw: ['利息'] },
    { name: '其他应付款', kw: ['其他应付', '暂收', '暂借款'] },
    { name: '实收资本', kw: ['实收资本', '股本', '注资', '投资款', '增资', '入资', '资本金'] },
    { name: '资本公积', kw: ['资本公积'] },
    { name: '盈余公积', kw: ['盈余公积'] },
    { name: '本年利润', kw: ['结转', '本年利润'] },
    { name: '利润分配', kw: ['利润', '分红', '股利', '转增'] },
    { name: '主营业务收入', kw: ['收入', '销售', '营业收入', '主营收入', '开票', '货款', '收款', '回款', '营收'] },
    { name: '其他业务收入', kw: ['其他业务', '租金收入', '废料', '租金', '废品', '废品收入'] },
    { name: '投资收益', kw: ['投资收益', '理财', '股息'] },
    { name: '营业外收入', kw: ['营业外', '政府补助', '盘盈', '违约金收入', '补贴'] },
    { name: '主营业务成本', kw: ['成本', '主营业务成本', '结转成本', '采购', '进货', '购进'] },
    { name: '其他业务成本', kw: ['其他业务成本'] },
    { name: '税金及附加', kw: ['税金及附加', '城建税', '教育费附加', '印花税', '城建', '印花'] },
    { name: '销售费用', kw: ['销售', '广告', '业务招待', '差旅', '业务宣传', '推广', '运费', '物流', '招待费', '展览'] },
    { name: '管理费用', kw: ['管理', '办公', '房租', '水电', '折旧费', '工资', '物业', '电费', '水费', '通讯', '电话', '网络', '餐饮', '住宿', '快递', '油费', '办公用品', '咨询'] },
    { name: '财务费用', kw: ['财务', '手续费', '利息支出', '汇兑', '工本费', '转账', '汇款', '跨行', '短信费', '账户管理费', '手续费收入'] },
    { name: '营业外支出', kw: ['营业外支出', '捐赠', '罚款', '盘亏', '滞纳金', '赔款', '违约金'] },
    { name: '所得税费用', kw: ['所得税'] }
  ];

  // 用户可编辑的科目表：内置 + 自定义新增 - 已删除（内置项）
  function getAccStore() { return FW.db.lsGet('tax_accounts', { added: [], deleted: [] }); }
  function setAccStore(o) { FW.db.lsSet('tax_accounts', o); }
  function getAccounts() {
    var st = getAccStore();
    var del = {}; (st.deleted || []).forEach(function (n) { del[n] = 1; });
    var builtin = CHART.filter(function (c) { return !del[c.name]; }).map(function (c) { return { name: c.name, kw: c.kw.slice() }; });
    var added = (st.added || []).map(function (c) { return { name: c.name, kw: (c.kw || []).slice() }; });
    return builtin.concat(added);
  }

  function matchAccounts(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return [];
    var list = getAccounts();
    return list.filter(function (c) {
      if (c.name.toLowerCase().indexOf(q) >= 0) return true;
      return c.kw.some(function (k) { return k.toLowerCase().indexOf(q) >= 0 || q.indexOf(k.toLowerCase()) >= 0; });
    }).map(function (c) { return c.name; });
  }
  // 科目性质：rev=收入/资本类，exp=成本/费用类，any=中性
  function accNature(name) {
    if (/收入|收益|利润|资本|公积|盈余|应收|预收|借款|存款|现金/.test(name)) return 'rev';
    if (/成本|费用|支出|应付|税费|工资|折旧|摊销/.test(name)) return 'exp';
    return 'any';
  }
  // 依据摘要文字推荐一个最可能科目（kind: 'rev' 收入 / 'exp' 支出，可选）
  function suggestAccount(summary, kind) {
    summary = (summary || '').toLowerCase();
    if (!summary) return null;
    var list = getAccounts();
    function find(filterFn) {
      var best = null, bestLen = 0;
      list.forEach(function (c) {
        if (filterFn && !filterFn(c)) return;
        c.kw.forEach(function (k) {
          var kl = k.toLowerCase();
          if (summary.indexOf(kl) >= 0 && kl.length > bestLen) { best = c.name; bestLen = kl.length; }
        });
      });
      return best;
    }
    if (kind) {
      var r = find(function (c) { var n = accNature(c.name); return n === 'any' || n === kind; });
      if (r) return r;
    }
    return find(null);
  }
  function rebuildAccChart() {
    var d = document.getElementById('accChart');
    if (!d) { d = document.createElement('datalist'); d.id = 'accChart'; document.body.appendChild(d); }
    d.innerHTML = getAccounts().map(function (c) { return '<option value="' + FW.esc(c.name) + '"></option>'; }).join('');
  }

  var state = { tab: 'voucher', book: 'balance', report: 'bs' };

  function vouchers() { return FW.db.getList(VK).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.no < b.no ? 1 : -1)); }); }
  function nextNo() {
    var max = 0;
    FW.db.getList(VK).forEach(function (v) { var n = parseInt(v.no, 10); if (!isNaN(n) && n > max) max = n; });
    return String(max + 1);
  }

  /* ========== 期初余额 ========== */
  function openings() { return FW.db.lsGet(OK, {}); }
  function setOpenings(o) { FW.db.lsSet(OK, o); }
  function getOpening(name) { return openings()[name] || { side: accDir(name), amount: 0 }; }

  /* ========== 账簿汇总（含期初） ========== */
  function accDir(name) {
    var n = name || '';
    if (n === '累计折旧' || n === '坏账准备') return '贷';
    if (/收入|利润|资本|公积|应付|预收|借款|应交|其他应付|应付利息|未交/.test(n)) return '贷';
    return '借';
  }
  function accountPostings() {
    var map = {};
    vouchers().forEach(function (v) {
      (v.entries || []).forEach(function (e) {
        var a = e.account; if (!a) return;
        map[a] = map[a] || { debit: 0, credit: 0 };
        map[a].debit += (parseFloat(e.debit) || 0);
        map[a].credit += (parseFloat(e.credit) || 0);
      });
    });
    return map;
  }
  function accOrder() {
    var builtin = CHART.map(function (c) { return c.name; });
    var post = accountPostings(), op = openings();
    var extra = Object.keys(post).concat(Object.keys(op)).filter(function (a) { return builtin.indexOf(a) < 0; });
    var seen = {}, res = [];
    builtin.concat(extra).forEach(function (a) { if (!seen[a]) { seen[a] = 1; res.push(a); } });
    return res;
  }
  // 返回按序科目余额数组（含期初/本期/期末）
  function buildLedger() {
    var post = accountPostings(), op = openings();
    var names = {}; Object.keys(post).forEach(function (a) { names[a] = 1; }); Object.keys(op).forEach(function (a) { names[a] = 1; });
    return accOrder().filter(function (a) { return names[a]; }).map(function (a) {
      var d = post[a] ? post[a].debit : 0, c = post[a] ? post[a].credit : 0;
      var dir = accDir(a);
      var o = op[a] || { side: dir, amount: 0 };
      var bd = 0, bc = 0;
      if (o.amount) { if (o.side === '借') bd = o.amount; else bc = o.amount; }
      var net = d - c, endDebit = 0, endCredit = 0;
      if (dir === '借') { var e = bd - bc + net; if (e >= 0) endDebit = e; else endCredit = -e; }
      else { var e2 = bc - bd - net; if (e2 >= 0) endCredit = e2; else endDebit = -e2; }
      return { name: a, dir: dir, beginDebit: bd, beginCredit: bc, debit: d, credit: c, endDebit: endDebit, endCredit: endCredit };
    });
  }
  function ledgerMap() { var m = {}; buildLedger().forEach(function (l) { m[l.name] = l; }); return m; }
  // 取某科目的"正常方向余额"（借方向取期末借方，贷方向取期末贷方）
  function normBal(name) { var l = ledgerMap()[name]; if (!l) return 0; return l.dir === '借' ? l.endDebit : l.endCredit; }

  function buildCashFlow() {
    var cf = { opIn: 0, opOut: 0, invIn: 0, invOut: 0, finIn: 0, finOut: 0 };
    function catOf(accounts) {
      var inv = /固定资产|无形资产|长期待摊费用|投资|股权/;
      var fin = /借款|实收资本|资本公积|盈余公积|利润分配|股利|股息/;
      var res = 'op';
      accounts.forEach(function (a) { if (inv.test(a)) res = 'inv'; else if (fin.test(a)) res = 'fin'; });
      return res;
    }
    vouchers().forEach(function (v) {
      var cash = [], other = [];
      (v.entries || []).forEach(function (e) {
        if (/库存现金|银行存款|其他货币资金/.test(e.account || '')) cash.push(e);
        else other.push(e);
      });
      var others = other.map(function (x) { return x.account; });
      cash.forEach(function (e) {
        var cat = catOf(others);
        var d = parseFloat(e.debit) || 0, c = parseFloat(e.credit) || 0;
        if (d > 0) { if (cat === 'inv') cf.invIn += d; else if (cat === 'fin') cf.finIn += d; else cf.opIn += d; }
        else if (c > 0) { if (cat === 'inv') cf.invOut += c; else if (cat === 'fin') cf.finOut += c; else cf.opOut += c; }
      });
    });
    return cf;
  }

  /* ========== 渲染骨架 ========== */
  function render() {
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="lm-nav" id="lmNav">' +
        '<button class="lm-tab active" data-t="voucher">凭证</button>' +
        '<button class="lm-tab" data-t="book">账簿</button>' +
        '<button class="lm-tab" data-t="asset">固定资产</button>' +
        '<button class="lm-tab" data-t="report">报表</button>' +
      '</div><div id="lmSub"></div><div id="taxBody"></div>';
    FW.qa('#lmNav .lm-tab').forEach(function (b) {
      b.onclick = function () {
        state.tab = b.dataset.t;
        FW.qa('#lmNav .lm-tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        draw();
      };
    });
    rebuildAccChart();
    draw();
  }

  function subTabs(items, active) {
    return '<div class="lm-sub">' + items.map(function (it) {
      return '<button class="lm-sub-tab ' + (it[0] === active ? 'active' : '') + '" data-t="' + it[0] + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }

  function setTopActions() {
    var ta = document.getElementById('topActions');
    if (state.tab === 'voucher') {
      ta.innerHTML = '<button class="btn ghost" id="tplBtn">📐 凭证模板</button><button class="btn ghost" id="accBtn">📖 科目表</button><button class="btn ghost" id="bankBtn">📥 导入银行流水</button><button class="btn" id="taxAddBtn">＋ 新增凭证</button>';
      document.getElementById('tplBtn').onclick = openTemplateLibrary;
      document.getElementById('accBtn').onclick = openAccountManager;
      document.getElementById('bankBtn').onclick = openBankImport;
      document.getElementById('taxAddBtn').onclick = function () { openVoucher(); };
    } else if (state.tab === 'book' && state.book === 'journal') {
      ta.innerHTML = '<button class="btn" id="jAddBtn">＋ 新增日记账</button>';
      document.getElementById('jAddBtn').onclick = function () { openJournal(); };
    } else if (state.tab === 'asset') {
      ta.innerHTML = '<button class="btn" id="assetAddBtn">＋ 新增资产</button>';
      document.getElementById('assetAddBtn').onclick = function () { openAsset(); };
    } else if (state.tab === 'report') {
      ta.innerHTML = '<button class="btn ghost" id="openBtn">⚙ 期初余额</button><button class="btn" id="carryBtn">🔄 结转损益</button>';
      document.getElementById('openBtn').onclick = openOpeningEditor;
      document.getElementById('carryBtn').onclick = carryForward;
    } else {
      ta.innerHTML = '';
    }
  }

  function draw() {
    var sub = document.getElementById('lmSub');
    setTopActions();
    if (state.tab === 'voucher') {
      sub.innerHTML = ''; drawVouchers();
    } else if (state.tab === 'book') {
      sub.innerHTML = subTabs([['balance', '科目余额表'], ['detail', '明细账'], ['general', '总账'], ['journal', '日记账']], state.book);
      drawBook();
    } else if (state.tab === 'asset') {
      sub.innerHTML = ''; drawAssets();
    } else {
      sub.innerHTML = subTabs([['bs', '资产负债表'], ['pl', '利润表'], ['cf', '现金流量表']], state.report);
      drawReport();
    }
    FW.qa('#lmSub .lm-sub-tab').forEach(function (b) {
      b.onclick = function () {
        if (state.tab === 'book') state.book = b.dataset.t; else state.report = b.dataset.t;
        draw();
      };
    });
  }

  /* ========== 凭证字号断号 / 重号检测 ========== */
  function voucherGaps() {
    var byWord = {};
    vouchers().forEach(function (v) { (byWord[v.word || '记'] = byWord[v.word || '记'] || []).push(v); });
    var issues = [];
    Object.keys(byWord).forEach(function (w) {
      var nos = byWord[w].map(function (v) { return parseInt(v.no, 10); }).filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
      var seen = {}, dups = [];
      nos.forEach(function (n) { if (seen[n]) dups.push(n); seen[n] = 1; });
      if (dups.length) issues.push('凭证字「' + w + '」存在重复号：' + dups.join('、'));
      if (nos.length) {
        var min = nos[0], max = nos[nos.length - 1], miss = [];
        for (var i = min; i <= max; i++) if (!seen[i]) miss.push(i);
        if (miss.length) issues.push('凭证字「' + w + '」缺号：' + miss.join('、'));
      }
    });
    return issues;
  }

  /* ========== 记账凭证 ========== */
  function drawVouchers() {
    var list = vouchers();
    var totalDebit = list.reduce(function (a, v) { return a + (v.totalDebit || 0); }, 0);
    var gaps = voucherGaps();
    var html =
      '<div class="stat-row"><div class="stat"><div class="label">凭证张数</div><div class="value">' + list.length + '</div></div>' +
      '<div class="stat"><div class="label">借方累计</div><div class="value income">' + FW.fmtMoney(totalDebit) + '</div></div></div>';
    if (gaps.length) {
      html += '<div class="vouch-gap"><b>⚠ 凭证字号检查：</b>' + gaps.map(function (g) { return '<div>' + FW.esc(g) + '</div>'; }).join('') + '</div>';
    }
    if (!list.length) {
      html += '<div class="card"><div class="empty">暂无记账凭证，点右上角「新增」录入。</div></div>';
    } else {
      var trs = list.map(function (v) {
        var audited = v.status === 'audited';
        return '<tr><td class="nowrap">' + FW.esc((v.word ? v.word + '-' : '') + v.no) + '</td><td class="nowrap">' + FW.esc(v.date) + '</td><td>' + FW.esc(v.summary || (v.entries[0] && v.entries[0].summary) || '') + '</td>' +
          '<td class="num">' + FW.fmtMoney(v.totalDebit) + '</td><td class="num">' + FW.fmtMoney(v.totalCredit) + '</td>' +
          '<td class="num">' + (v.attach || 0) + '</td>' +
          '<td class="muted">' + FW.esc(v.maker || '—') + '</td>' +
          '<td>' + (audited ? '<span class="tag expense">已审核</span>' : '<span class="tag">草稿</span>') + '</td>' +
          '<td class="row-actions nowrap"><button class="btn ghost sm v-view" data-id="' + v.id + '">查看</button><button class="btn ghost sm v-edit" data-id="' + v.id + '">编辑</button><button class="btn ghost sm v-audit" data-id="' + v.id + '">' + (audited ? '反审' : '审核') + '</button><button class="btn danger sm v-del" data-id="' + v.id + '">删</button></td></tr>';
      }).join('');
      html += '<div class="card"><table><thead><tr><th>凭证号</th><th>日期</th><th>摘要</th><th class="num">借方合计</th><th class="num">贷方合计</th><th class="num">附件</th><th>制单</th><th>状态</th><th>操作</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
    }
    document.getElementById('taxBody').innerHTML = html;
    FW.qa('#taxBody .v-view').forEach(function (b) { b.onclick = function () { viewVoucher(b.dataset.id); }; });
    FW.qa('#taxBody .v-edit').forEach(function (b) { b.onclick = function () { openVoucher(b.dataset.id); }; });
    FW.qa('#taxBody .v-del').forEach(function (b) { b.onclick = function () { delVoucher(b.dataset.id); }; });
    FW.qa('#taxBody .v-audit').forEach(function (b) { b.onclick = function () { toggleAudit(b.dataset.id); }; });
  }

  function toggleAudit(id) {
    var v = FW.db.getById(VK, id); if (!v) return;
    v.status = v.status === 'audited' ? 'draft' : 'audited';
    FW.db.upsert(VK, v); render(); FW.toast(v.status === 'audited' ? '已审核' : '已取消审核');
  }

  function viewVoucher(id) {
    var v = FW.db.getById(VK, id); if (!v) return;
    var trs = v.entries.map(function (e) {
      return '<tr><td>' + FW.esc(e.summary) + '</td><td>' + FW.esc(e.account) + '</td><td class="num">' + (e.debit ? FW.fmtMoney(e.debit) : '') + '</td><td class="num">' + (e.credit ? FW.fmtMoney(e.credit) : '') + '</td></tr>';
    }).join('');
    var body =
      '<div class="voucher-paper print-area">' +
        '<div class="vp-head"><div class="vp-title">记账凭证</div>' +
        '<div class="vp-meta"><span class="vp-field"><label>凭证字</label><b>' + FW.esc(v.word || '记') + '</b></span>' +
        '<span class="vp-field"><label>凭证号</label><b>' + FW.esc(v.no) + '</b></span>' +
        '<span class="vp-field"><label>日期</label><b>' + FW.esc(v.date) + '</b></span>' +
        '<span class="vp-field"><label>附件张数</label><b>' + (v.attach || 0) + '</b></span>' +
        '<span class="vp-field"><label>制单人</label><b>' + FW.esc(v.maker || '—') + '</b></span></div></div>' +
        '<table class="vp-table"><thead><tr><th class="vp-c-sum">摘　　要</th><th class="vp-c-acc">会计科目</th><th class="vp-c-money num">借方金额</th><th class="vp-c-money num">贷方金额</th></tr></thead><tbody>' + trs + '</tbody>' +
        '<tfoot><tr><td class="vp-total-label">合　计</td><td></td><td class="num">' + FW.fmtMoney(v.totalDebit) + '</td><td class="num">' + FW.fmtMoney(v.totalCredit) + '</td></tr></tfoot></table>' +
        '<div class="vp-foot"><span>会计主管：<i></i></span><span>记账：<i></i></span><span>复核：<i></i></span><span>制单：<i>' + FW.esc(v.maker || '') + '</i></span>' +
        '<span class="vp-bal ' + (v.status === 'audited' ? 'ok' : '') + '">' + (v.status === 'audited' ? '已审核' : '草稿') + '</span></div>' +
      '</div>' +
      '<div class="form-actions no-print"><button class="btn ghost" id="vpPrint">🖨 打印凭证</button><button class="btn ghost" id="vpClose">关闭</button></div>';
    FW.openModal('记账凭证 ' + (v.word ? v.word + '-' : '') + v.no + '（' + v.date + '）', body, function () {
      document.getElementById('vpClose').onclick = FW.closeModal;
      document.getElementById('vpPrint').onclick = function () { window.print(); };
    });
  }

  function openVoucher(id, preset) {
    var edit = id ? FW.db.getById(VK, id) : null;
    var v = edit ? edit
      : (preset ? { no: nextNo(), date: FW.today(), attach: 0, word: '记', status: 'draft', entries: preset.map(function (e) { return { summary: e.summary || '', account: e.account || '', debit: '', credit: '' }; }) }
        : { no: nextNo(), date: FW.today(), attach: 0, word: '记', status: 'draft', entries: [{ summary: '', account: '', debit: '', credit: '' }, { summary: '', account: '', debit: '', credit: '' }] });
    var body =
      '<div class="voucher-paper">' +
        '<div class="vp-head">' +
          '<div class="vp-title">记账凭证</div>' +
          '<div class="vp-meta">' +
            '<span class="vp-field"><label>凭证字</label><select id="v_word">' +
              ['记', '收', '付', '转'].map(function (w) { return '<option ' + ((v.word || '记') === w ? 'selected' : '') + '>' + w + '</option>'; }).join('') +
            '</select></span>' +
            '<span class="vp-field"><label>凭证号</label><input id="v_no" value="' + FW.esc(v.no) + '"></span>' +
            '<span class="vp-field"><label>日期</label><input id="v_date" type="date" value="' + FW.esc(v.date) + '"></span>' +
            '<span class="vp-field"><label>附件张数</label><input id="v_attach" type="number" min="0" value="' + FW.esc(v.attach) + '"></span>' +
            '<span class="vp-field"><label>制单人</label><input id="v_maker" value="' + FW.esc(v.maker || '') + '" placeholder="（选填）"></span>' +
            '<span class="vp-field"><label>状态</label><select id="v_status">' +
              '<option value="draft" ' + (v.status !== 'audited' ? 'selected' : '') + '>草稿</option>' +
              '<option value="audited" ' + (v.status === 'audited' ? 'selected' : '') + '>已审核</option>' +
            '</select></span>' +
          '</div>' +
        '</div>' +
        '<table class="vp-table">' +
          '<thead><tr><th class="vp-c-sum">摘　　要</th><th class="vp-c-acc">会计科目</th><th class="vp-c-money num">借方金额</th><th class="vp-c-money num">贷方金额</th><th class="vp-c-op"></th></tr></thead>' +
          '<tbody></tbody>' +
          '<tfoot><tr><td class="vp-total-label">合　计</td><td></td><td class="num" id="vp_deb">¥0.00</td><td class="num" id="vp_cre">¥0.00</td><td></td></tr></tfoot>' +
        '</table>' +
        '<div class="vp-foot">' +
          '<span>会计主管：<i></i></span><span>记账：<i></i></span><span>复核：<i></i></span><span>制单：<i></i></span>' +
          '<span class="vp-bal ok" id="v_bal">借贷平衡 ✓</span>' +
        '</div>' +
      '</div>' +
      '<div class="voucher-actions"><button class="btn ghost sm" id="vAddRow">＋ 增加一行分录</button></div>' +
      '<div class="form-actions"><button class="btn ghost" id="vTpl">存为模板</button><button class="btn ghost" id="vCancel">取消</button><button class="btn" id="vSave">保存凭证</button></div>';
    FW.openModal(edit ? '编辑记账凭证' : (preset ? '生成凭证（来自模板）' : '新增记账凭证'), body, function () {
      var modalEl = document.querySelector('.modal'); if (modalEl) modalEl.classList.add('modal-wide');
      document.getElementById('vCancel').onclick = FW.closeModal;
      document.getElementById('vTpl').onclick = function () { saveAsTemplate(v.entries); };
      var tbody = document.querySelector('.vp-table tbody');
      function rowHtml(e) {
        return '<tr>' +
          '<td><input class="e_sum" placeholder="摘要" value="' + FW.esc(e.summary) + '"></td>' +
          '<td><input class="e_acc" list="accChart" placeholder="输入科目可联想" value="' + FW.esc(e.account) + '"><span class="acc-tip"></span></td>' +
          '<td class="num"><input class="e_deb num" type="number" step="0.01" min="0" value="' + FW.esc(e.debit) + '"></td>' +
          '<td class="num"><input class="e_cre num" type="number" step="0.01" min="0" value="' + FW.esc(e.credit) + '"></td>' +
          '<td class="vp-op"><button class="btn danger sm e_del">✕</button></td></tr>';
      }
      function maybeSuggest(tr, summary) {
        var tip = tr.querySelector('.acc-tip');
        if (!tip) return;
        var acc = tr.querySelector('.e_acc');
        var m = suggestAccount(summary);
        if (m && !acc.value) {
          tip.innerHTML = '<button type="button" class="btn ghost sm acc-fill">💡 ' + FW.esc(m) + '</button>';
          tip.querySelector('.acc-fill').onclick = function () { acc.value = m; };
        } else { tip.innerHTML = ''; }
      }
      function calcBal() {
        var d = v.entries.reduce(function (a, e) { return a + (parseFloat(e.debit) || 0); }, 0);
        var c = v.entries.reduce(function (a, e) { return a + (parseFloat(e.credit) || 0); }, 0);
        document.getElementById('vp_deb').textContent = FW.fmtMoney(d);
        document.getElementById('vp_cre').textContent = FW.fmtMoney(c);
        var bal = document.getElementById('v_bal');
        if (Math.abs(d - c) < 0.005) { bal.textContent = '借贷平衡 ✓'; bal.className = 'vp-bal ok'; }
        else { bal.textContent = '借贷不平衡（差 ' + FW.fmtMoney(Math.abs(d - c)) + '）'; bal.className = 'vp-bal bad'; }
        return { d: d, c: c };
      }
      function refresh() {
        tbody.innerHTML = v.entries.map(rowHtml).join('');
        FW.qa('.vp-table tbody tr').forEach(function (tr, i) {
          tr.querySelector('.e_sum').oninput = function () { v.entries[i].summary = this.value; maybeSuggest(tr, this.value); };
          tr.querySelector('.e_acc').oninput = function () { v.entries[i].account = this.value; };
          tr.querySelector('.e_deb').oninput = function () { v.entries[i].debit = this.value; calcBal(); };
          tr.querySelector('.e_cre').oninput = function () { v.entries[i].credit = this.value; calcBal(); };
          tr.querySelector('.e_del').onclick = function () { v.entries.splice(i, 1); refresh(); calcBal(); };
          maybeSuggest(tr, v.entries[i].summary);
        });
      }
      refresh(); calcBal();
      document.getElementById('vAddRow').onclick = function () { v.entries.push({ summary: '', account: '', debit: '', credit: '' }); refresh(); };
      document.getElementById('vSave').onclick = function () {
        var bc = calcBal();
        if (Math.abs(bc.d - bc.c) >= 0.005) { FW.toast('借贷不平衡，无法保存'); return; }
        if (bc.d === 0) { FW.toast('金额不能为 0'); return; }
        var rec = {
          id: edit ? edit.id : FW.db.uid('v_'),
          word: document.getElementById('v_word').value,
          no: document.getElementById('v_no').value.trim() || nextNo(),
          date: document.getElementById('v_date').value || FW.today(),
          attach: parseInt(document.getElementById('v_attach').value, 10) || 0,
          maker: document.getElementById('v_maker').value.trim(),
          status: document.getElementById('v_status').value,
          entries: v.entries.filter(function (e) { return e.account || e.summary || e.debit || e.credit; })
            .map(function (e) { return { summary: e.summary, account: e.account, debit: parseFloat(e.debit) || 0, credit: parseFloat(e.credit) || 0 }; }),
          totalDebit: bc.d, totalCredit: bc.c
        };
        FW.db.upsert(VK, rec);
        FW.closeModal(); render(); FW.toast('凭证已保存');
      };
    });
  }

  function delVoucher(id) {
    if (!confirm('确定删除该记账凭证？')) return;
    FW.db.remove(VK, id); render(); FW.toast('已删除');
  }

  /* ========== 月末结转损益 ========== */
  function carryForward() {
    var revNames = ['主营业务收入', '其他业务收入', '投资收益', '营业外收入'];
    var expNames = ['主营业务成本', '其他业务成本', '税金及附加', '销售费用', '管理费用', '财务费用', '营业外支出', '所得税费用'];
    var revLines = [], expLines = [], sumRev = 0, sumExp = 0;
    revNames.forEach(function (n) { var b = normBal(n); if (b > 0.005) { revLines.push({ summary: '结转' + n, account: n, debit: b, credit: 0 }); sumRev += b; } });
    expNames.forEach(function (n) { var b = normBal(n); if (b > 0.005) { expLines.push({ summary: '结转' + n, account: n, debit: 0, credit: b }); sumExp += b; } });
    if (sumRev === 0 && sumExp === 0) { FW.toast('当前没有可结转的损益（收入/费用科目余额为 0）'); return; }
    var entries = revLines.concat([{ summary: '结转损益', account: '本年利润', debit: 0, credit: sumRev }],
      [{ summary: '结转损益', account: '本年利润', debit: sumExp, credit: 0 }], expLines);
    var rec = {
      id: FW.db.uid('v_'), word: '转', no: nextNo(), date: FW.today(), attach: 0, maker: '系统结转',
      status: 'audited', entries: entries, totalDebit: sumRev + sumExp, totalCredit: sumRev + sumExp
    };
    FW.db.upsert(VK, rec); render();
    FW.toast('已生成结转凭证（转-' + rec.no + '），净利润 ' + FW.fmtMoney(sumRev - sumExp) + ' 转入「本年利润」');
  }

  /* ========== 期初余额编辑 ========== */
  function openOpeningEditor() {
    var accs = getAccounts();
    var op = openings();
    var rows = accs.map(function (c) {
      var o = op[c.name] || { side: accDir(c.name), amount: 0 };
      return '<div class="open-row"><span class="open-name">' + FW.esc(c.name) + '</span>' +
        '<select class="open-side" data-name="' + FW.esc(c.name) + '">' +
        '<option value="借" ' + (o.side === '借' ? 'selected' : '') + '>借</option>' +
        '<option value="贷" ' + (o.side === '贷' ? 'selected' : '') + '>贷</option></select>' +
        '<input class="open-amt" type="number" step="0.01" min="0" data-name="' + FW.esc(c.name) + '" value="' + (o.amount || 0) + '" placeholder="0"></div>';
    }).join('');
    var body = '<div class="acc-hint muted">设置各科目期初余额（通常在年初或建账时录入一次），账簿与资产负债表将据此连续计算。无期初填 0。</div>' +
      '<div class="open-list">' + rows + '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="openClose">关闭</button><button class="btn" id="openSave">保存期初</button></div>';
    FW.openModal('期初余额', body, function () {
      document.getElementById('openClose').onclick = FW.closeModal;
      document.getElementById('openSave').onclick = function () {
        var sides = FW.qa('#modalBody .open-side'), amts = FW.qa('#modalBody .open-amt');
        var m = {};
        sides.forEach(function (s) { m[s.dataset.name] = m[s.dataset.name] || {}; m[s.dataset.name].side = s.value; });
        amts.forEach(function (a) { m[a.dataset.name] = m[a.dataset.name] || {}; m[a.dataset.name].amount = parseFloat(a.value) || 0; });
        setOpenings(m); FW.closeModal(); render(); FW.toast('期初余额已保存');
      };
    });
  }

  /* ========== 凭证模板库 ========== */
  function findTpl(name) {
    var p = PRESET.filter(function (t) { return t.name === name; })[0];
    if (p) return p;
    return FW.db.getList(TK).filter(function (t) { return t.name === name; })[0] || null;
  }

  function openTemplateLibrary() {
    var customs = FW.db.getList(TK);
    function rowHtml(t, isCustom) {
      var desc = t.entries.map(function (e) { return FW.esc(e.summary || e.account || ''); }).filter(Boolean).join('；');
      return '<div class="tpl-item"><div class="tpl-info"><div class="tpl-name">' + FW.esc(t.name) + '</div>' +
        '<div class="tpl-entries">' + (desc || '（空模板）') + '</div></div>' +
        '<div class="tpl-ops"><button class="btn ghost sm tpl-use" data-name="' + FW.esc(t.name) + '">生成凭证</button>' +
        (isCustom ? '<button class="btn danger sm tpl-del" data-id="' + t.id + '">删</button>' : '') + '</div></div>';
    }
    var html = '<div class="tpl-list">' +
      '<div class="tpl-sec">常用模板</div>' + PRESET.map(function (t) { return rowHtml(t, false); }).join('') +
      '<div class="tpl-sec">我的模板</div>' + (customs.length ? customs.map(function (t) { return rowHtml(t, true); }).join('') : '<div class="empty">还没有自定义模板。可在「新增/编辑凭证」时点「存为模板」保存周期固定业务的分录。</div>') +
      '</div>';
    FW.openModal('凭证模板库', html, function () {
      FW.qa('#modalBody .tpl-use').forEach(function (b) {
        b.onclick = function () { var t = findTpl(b.dataset.name); if (t) { FW.closeModal(); openVoucher(null, t.entries); } };
      });
      FW.qa('#modalBody .tpl-del').forEach(function (b) {
        b.onclick = function () {
          if (confirm('删除该模板？')) {
            FW.db.saveList(TK, FW.db.getList(TK).filter(function (x) { return x.id !== b.dataset.id; }));
            openTemplateLibrary(); FW.toast('已删除模板');
          }
        };
      });
    });
  }

  /* ========== 会计科目表（用户可增删） ========== */
  function openAccountManager() {
    function render() {
      var accs = getAccounts();
      var rows = accs.map(function (c) {
        var isBuiltin = CHART.some(function (x) { return x.name === c.name; });
        var kw = (c.kw || []).join('、');
        return '<div class="acc-item">' +
          '<div class="acc-info"><div class="acc-name">' + FW.esc(c.name) + (isBuiltin ? '' : ' <span class="tag">自定义</span>') + '</div>' +
          '<div class="muted" style="font-size:12px">别名关键词：' + (kw ? FW.esc(kw) : '（无）') + '</div></div>' +
          '<button class="btn danger sm acc-del" data-name="' + FW.esc(c.name) + '">删</button></div>';
      }).join('');
      var body =
        '<div class="acc-hint muted">内置常用会计科目，可删除内置项或新增科目；科目参与记账凭证的「摘要联想」与「科目自动识别」。</div>' +
        '<div class="acc-list">' + (rows || '<div class="empty">暂无科目</div>') + '</div>' +
        '<div class="card" style="margin-top:14px"><h4 style="margin:0 0 10px">新增会计科目</h4>' +
          '<div class="form-grid">' +
            '<div class="field"><label>科目名称</label><input id="accNewName" placeholder="如：研发支出"></div>' +
            '<div class="field"><label>别名关键词（逗号分隔，用于自动识别）</label><input id="accNewKw" placeholder="如：研发,课题经费"></div>' +
          '</div>' +
          '<div class="form-actions"><button class="btn" id="accAdd">添加科目</button></div>' +
        '</div>' +
        '<div class="form-actions"><button class="btn ghost" id="accClose">关闭</button></div>';
      FW.openModal('会计科目表（可增删）', body, function () {
        FW.qa('#modalBody .acc-del').forEach(function (b) {
          b.onclick = function () {
            var name = b.dataset.name;
            var isBuiltin = CHART.some(function (x) { return x.name === name; });
            if (!confirm('删除科目「' + name + '」？' + (isBuiltin ? '（将从内置科目表中隐藏，可重新添加恢复）' : ''))) return;
            var st = getAccStore();
            if (isBuiltin) st.deleted = (st.deleted || []).concat([name]);
            else st.added = (st.added || []).filter(function (a) { return a.name !== name; });
            setAccStore(st); rebuildAccChart(); render(); FW.toast('已删除科目「' + name + '」');
          };
        });
        document.getElementById('accAdd').onclick = function () {
          var name = document.getElementById('accNewName').value.trim();
          if (!name) { FW.toast('请输入科目名称'); return; }
          var accs2 = getAccounts();
          if (accs2.some(function (a) { return a.name === name; })) { FW.toast('已存在该科目'); return; }
          var kw = document.getElementById('accNewKw').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
          var st = getAccStore();
          var isBuiltin = CHART.some(function (x) { return x.name === name; });
          if (isBuiltin) st.deleted = (st.deleted || []).filter(function (n) { return n !== name; });
          else { st.added = st.added || []; st.added.push({ name: name, kw: kw }); }
          setAccStore(st); rebuildAccChart(); render(); FW.toast('已新增科目「' + name + '」');
        };
        document.getElementById('accClose').onclick = FW.closeModal;
      });
    }
    render();
  }

  function saveAsTemplate(entries) {
    var usable = entries.filter(function (e) { return e.account || e.summary; });
    if (!usable.length) { FW.toast('当前凭证没有可保存的分录'); return; }
    FW.openModal('保存为模板', '<div class="field"><label>模板名称</label><input id="tp_name" placeholder="如：每月计提折旧"></div><div class="form-actions"><button class="btn ghost" id="tpCancel">取消</button><button class="btn" id="tpSave">保存</button></div>', function () {
      document.getElementById('tpCancel').onclick = FW.closeModal;
      document.getElementById('tpSave').onclick = function () {
        var name = document.getElementById('tp_name').value.trim();
        if (!name) { FW.toast('请输入模板名称'); return; }
        var list = FW.db.getList(TK);
        list.push({ id: FW.db.uid('tpl_'), name: name, entries: usable.map(function (e) { return { summary: e.summary || '', account: e.account || '', debit: '', credit: '' }; }) });
        FW.db.saveList(TK, list);
        FW.closeModal(); FW.toast('已保存模板「' + name + '」');
      };
    });
  }

  /* ========== 银行流水 CSV 导入 ========== */
  function num(v) {
    if (v === undefined || v === null) return 0;
    var s = String(v).replace(/[, ¥￥元\s]/g, '');
    if (!s) return 0;
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  function pad2(s) { s = String(s); return s.length < 2 ? '0' + s : s; }
  function normDate(s) {
    s = (s || '').trim();
    if (!s) return '';
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    var m2 = s.match(/^(\d{4})(\d{2})(\d{2})/); // 20260701
    if (m2) return m2[1] + '-' + m2[2] + '-' + m2[3];
    return s;
  }
  // 智能解码：工商银行等国内银行多为 GBK。用本地 iconv-lite 解码（所有浏览器一致，含 iPhone Safari）
  function readFileSmart(file, enc, cb) {
    var rd = new FileReader();
    rd.onload = function () {
      var buf = new Uint8Array(rd.result); // 原始字节，交给 iconv 按指定编码解码
      var text = '';
      try {
        if (enc === 'utf8') {
          text = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
        } else if (enc === 'gbk') {
          text = decodeGBK(buf);
        } else {
          // auto：先判断是否合法 UTF-8（UTF-8 字节序列几乎不与 GBK 冲突）；合法则 UTF-8，否则 GBK
          var utf = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
          var utfBad = (utf.match(/[\uFFFD]/g) || []).length;
          text = (utfBad === 0) ? utf : decodeGBK(buf);
        }
      } catch (e) {
        try { text = new TextDecoder('utf-8').decode(buf); } catch (e2) { text = ''; }
      }
      cb(text.replace(/^﻿/, ''));
    };
    rd.readAsArrayBuffer(file);
  }

  // 优先用本地 iconv-lite 解码 GBK（最可靠、全平台一致）；浏览器原生 TextDecoder 兜底
  function decodeGBK(buf) {
    if (window.iconv) return window.iconv.decode(buf, 'gbk');
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { return ''; }
  }

  function parseCSV(text) {
    text = (text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return [];
    var lines = text.split('\n').filter(function (l) { return l.trim(); });
    function splitLine(line) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
      }
      out.push(cur); return out;
    }
    var rows = lines.map(splitLine);
    // 判断首行是否表头
    var header = rows[0].map(function (h) { return (h || '').trim().toLowerCase(); });
    function idx(names) { for (var i = 0; i < names.length; i++) { for (var j = 0; j < header.length; j++) { if (header[j].indexOf(names[i]) >= 0) return j; } } return -1; }
    // 适配工商银行等常见表头（含 借方发生额 / 贷方发生额 / 对方户名 / 借贷标志）
    var iDate = idx(['日期', '交易日期', '记账日期', '记账日', '时间']);
    var iSum = idx(['摘要', '备注', '说明', '交易摘要', '业务摘要', '用途', '附言']);
    var iOther = idx(['对方户名', '对方账号', '对方名称', '交易对手', '户名', '对方']);
    var iIn = idx(['收入', '贷方', '进账', '贷方金额', '贷方发生额', '贷']);
    var iOut = idx(['支出', '借方', '出账', '借方金额', '借方发生额', '借']);
    var iAmt = idx(['发生额', '金额', '交易金额', '交易额']);
    var iFlag = idx(['借贷标志', '借贷方向', '收/付', '收付标志', '标志', '方向']);
    var hasHeader = (iDate >= 0 || iSum >= 0 || iIn >= 0 || iOut >= 0 || iAmt >= 0 || iOther >= 0);
    var data = hasHeader ? rows.slice(1) : rows;
    if (!hasHeader) { iDate = 0; iSum = (rows[0].length > 3 ? 2 : 1); iIn = -1; iOut = -1; }
    return data.map(function (r) {
      var date = normDate(iDate >= 0 ? r[iDate] : '');
      var parts = [];
      if (iSum >= 0 && r[iSum]) parts.push(r[iSum].trim());
      if (iOther >= 0 && r[iOther]) parts.push(r[iOther].trim());
      var sum = parts.join(' ').trim();
      var inc = 0, out = 0;
      if (iIn >= 0) inc = num(r[iIn]);
      if (iOut >= 0) out = num(r[iOut]);
      if (iAmt >= 0) {
        var amt = num(r[iAmt]);
        var flag = (iFlag >= 0 ? (r[iFlag] || '').trim() : '');
        if (flag) {
          if (/借|付|支|出|d/i.test(flag)) out = amt;
          else if (/贷|收|进|入|c/i.test(flag)) inc = amt;
          else if (amt < 0) out = -amt; else inc = amt;
        } else {
          if (amt > 0) inc = amt; else if (amt < 0) out = -amt;
        }
      }
      if (iIn < 0 && iOut < 0 && iAmt < 0) {
        var a = num(r[1] || r[2] || '0');
        if (a >= 0) inc = a; else out = -a;
      }
      return { date: date, summary: sum, income: inc, expense: out };
    }).filter(function (r) { return r.income > 0 || r.expense > 0; });
  }

  function openBankImport() {
    var body =
      '<div class="acc-hint muted">支持<b>工商银行</b>等国内银行导出的 CSV（自动识别 GBK / UTF-8 编码）。系统按「摘要 + 对方户名」自动识别记账凭证科目，逐笔生成「收 / 付」凭证（对方科目：银行存款）。请选择「导出 / 下载 → CSV（逗号分隔）」。</div>' +
      '<div class="form-grid">' +
        '<div class="field"><label>文件编码</label><select id="bankEnc"><option value="gbk">GBK（工商银行等）</option><option value="auto">自动检测</option><option value="utf8">UTF-8</option></select></div>' +
        '<div class="field"><label>上传 CSV 文件</label><input type="file" id="bankFile" accept=".csv,text/csv"></div>' +
      '</div>' +
      '<div class="field"><label>或粘贴 CSV 文本</label><textarea id="bankText" rows="5" placeholder="交易日期,摘要,贷方发生额,借方发生额,余额,对方户名\n2026-07-01,代发工资,,,5000.00,工资代发\n2026-07-02,网银转账手续费12.00,,工本费"></textarea></div>' +
      '<div class="form-grid">' +
        '<div class="field"><label>收款默认对方科目</label><input id="bankIncAcc" list="accChart" placeholder="如：主营业务收入" value="主营业务收入"></div>' +
        '<div class="field"><label>付款默认对方科目</label><input id="bankExpAcc" list="accChart" placeholder="如：管理费用" value="管理费用"></div>' +
      '</div>' +
      '<div id="bankPreview" class="bank-preview"></div>' +
      '<div class="form-actions"><button class="btn ghost" id="bankClose">关闭</button><button class="btn" id="bankGen" disabled>生成凭证</button></div>';
    FW.openModal('导入银行流水 → 生成凭证', body, function () {
      document.getElementById('bankClose').onclick = FW.closeModal;
      var parsed = [];
      function doParse(text) {
        parsed = parseCSV(text);
        var prev = document.getElementById('bankPreview');
        if (!parsed.length) { prev.innerHTML = '<div class="muted">未解析到有效流水（需含 收入/支出/借贷 金额）。若中文仍是乱码，请确认导出的是 CSV，并在上方把「文件编码」改为 GBK。</div>'; document.getElementById('bankGen').disabled = true; return; }
        var rows = parsed.map(function (r, i) {
          var acc = suggestAccount(r.summary, r.income > 0 ? 'rev' : 'exp') || (r.income > 0 ? document.getElementById('bankIncAcc').value : document.getElementById('bankExpAcc').value);
          return '<tr><td>' + FW.esc(r.date) + '</td><td>' + FW.esc(r.summary) + '</td><td class="num income">' + (r.income ? FW.fmtMoney(r.income) : '') + '</td><td class="num expense">' + (r.expense ? FW.fmtMoney(r.expense) : '') + '</td>' +
            '<td><input class="bank-acc" data-i="' + i + '" list="accChart" value="' + FW.esc(acc) + '"></td></tr>';
        }).join('');
        prev.innerHTML = '<div class="muted" style="margin:8px 0">共解析 ' + parsed.length + ' 笔，将生成对应凭证（对方科目可逐行修改）：</div>' +
          '<table><thead><tr><th>日期</th><th>摘要（含对方户名）</th><th class="num">收入</th><th class="num">支出</th><th>识别的对方科目（可改）</th></tr></thead><tbody>' + rows + '</tbody></table>';
        document.getElementById('bankGen').disabled = false;
      }
      document.getElementById('bankText').oninput = function () { doParse(this.value); };
      document.getElementById('bankFile').onchange = function (e) {
        var f = e.target.files[0]; if (!f) return;
        var enc = document.getElementById('bankEnc').value;
        readFileSmart(f, enc, function (txt) { document.getElementById('bankText').value = txt; doParse(txt); });
      };
      document.getElementById('bankGen').onclick = function () {
        if (!parsed.length) { FW.toast('⚠️ 没有可生成的流水数据。请确认：①CSV 已正确上传/粘贴 ②中文不是乱码（编码选 GBK）③包含金额列'); return; }
        var incAcc = document.getElementById('bankIncAcc').value.trim() || '主营业务收入';
        var expAcc = document.getElementById('bankExpAcc').value.trim() || '管理费用';
        var inputs = document.querySelectorAll('#bankPreview .bank-acc');
        var n = 0;
        parsed.forEach(function (r, i) {
          var acc = (inputs[i] && inputs[i].value.trim()) || suggestAccount(r.summary, r.income > 0 ? 'rev' : 'exp') || (r.income > 0 ? incAcc : expAcc);
          if (r.income > 0) {
            FW.db.upsert(VK, { id: FW.db.uid('v_'), word: '收', no: nextNo(), date: r.date || FW.today(), attach: 0, maker: '银行导入', status: 'draft',
              entries: [{ summary: r.summary, account: '银行存款', debit: r.income, credit: 0 }, { summary: r.summary, account: acc, debit: 0, credit: r.income }], totalDebit: r.income, totalCredit: r.income });
            n++;
          } else if (r.expense > 0) {
            FW.db.upsert(VK, { id: FW.db.uid('v_'), word: '付', no: nextNo(), date: r.date || FW.today(), attach: 0, maker: '银行导入', status: 'draft',
              entries: [{ summary: r.summary, account: acc, debit: r.expense, credit: 0 }, { summary: r.summary, account: '银行存款', debit: 0, credit: r.expense }], totalDebit: r.expense, totalCredit: r.expense });
            n++;
          }
        });
        FW.closeModal(); render(); FW.toast('已生成 ' + n + ' 张银行凭证（收/付）');
      };
    });
  }

  /* ========== 日记账 ========== */
  var jBook = '现金';
  function journals() { return FW.db.getList(JK).filter(function (j) { return j.book === jBook; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }

  function drawJournal() {
    var books = ['现金', '银行存款', '其他'];
    var html = '<div class="toolbar"><div class="field"><select id="jBook">' + books.map(function (b) { return '<option ' + (b === jBook ? 'selected' : '') + '>' + b + '日记账</option>'; }).join('') + '</select></div><button class="btn ghost no-print" id="jPrint" style="align-self:flex-end">🖨 打印</button></div>';
    var list = journals();
    var bal = 0;
    if (!list.length) {
      html += '<div class="card"><div class="empty">「' + jBook + '日记账」暂无记录，点右上角「新增」登记。</div></div>';
    } else {
      var trs = list.map(function (j) {
        bal += (Number(j.income) || 0) - (Number(j.expense) || 0);
        return '<tr><td class="nowrap">' + FW.esc(j.date) + '</td><td class="nowrap">' + FW.esc(j.vno || '') + '</td><td>' + FW.esc(j.summary) + '</td>' +
          '<td class="num income">' + (j.income ? FW.fmtMoney(j.income) : '') + '</td>' +
          '<td class="num expense">' + (j.expense ? FW.fmtMoney(j.expense) : '') + '</td>' +
          '<td class="num"><b>' + FW.fmtMoney(bal) + '</b></td>' +
          '<td class="row-actions nowrap"><button class="btn ghost sm j-edit" data-id="' + j.id + '">编辑</button><button class="btn danger sm j-del" data-id="' + j.id + '">删</button></td></tr>';
      }).join('');
      html += '<div class="card print-area"><div class="muted" style="margin-bottom:8px">期初余额：¥0.00　|　当前余额：<b>' + FW.fmtMoney(bal) + '</b></div>' +
        '<table><thead><tr><th>日期</th><th>凭证号</th><th>摘要</th><th class="num">收入</th><th class="num">支出</th><th class="num">余额</th><th>操作</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
    }
    document.getElementById('taxBody').innerHTML = html;
    var jb = document.getElementById('jBook'); if (jb) jb.onchange = function () { jBook = this.value.replace('日记账', ''); drawJournal(); };
    var jp = document.getElementById('jPrint'); if (jp) jp.onclick = function () { window.print(); };
    FW.qa('#taxBody .j-edit').forEach(function (b) { b.onclick = function () { openJournal(b.dataset.id); }; });
    FW.qa('#taxBody .j-del').forEach(function (b) { b.onclick = function () { if (confirm('删除该日记账分录？')) { FW.db.remove(JK, b.dataset.id); drawJournal(); } }; });
  }

  function openJournal(id) {
    var edit = id ? FW.db.getById(JK, id) : null;
    var v = edit || { date: FW.today(), vno: '', summary: '', income: '', expense: '' };
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>账簿</label><select id="j_book">' + ['现金', '银行存款', '其他'].map(function (b) { return '<option ' + ((edit ? edit.book : jBook) === b ? 'selected' : '') + '>' + b + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>日期</label><input id="j_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>凭证号</label><input id="j_vno" value="' + FW.esc(v.vno) + '" placeholder="对应记账凭证号"></div>' +
        '<div class="field"><label>摘要</label><input id="j_sum" value="' + FW.esc(v.summary) + '"></div>' +
        '<div class="field"><label>收入（借/收）</label><input id="j_inc" type="number" step="0.01" min="0" value="' + FW.esc(v.income) + '"></div>' +
        '<div class="field"><label>支出（贷/付）</label><input id="j_exp" type="number" step="0.01" min="0" value="' + FW.esc(v.expense) + '"></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="jCancel">取消</button><button class="btn" id="jSave">保存</button></div>';
    FW.openModal(edit ? '编辑日记账' : '新增日记账', body, function () {
      document.getElementById('jCancel').onclick = FW.closeModal;
      document.getElementById('jSave').onclick = function () {
        var rec = {
          id: edit ? edit.id : FW.db.uid('j_'),
          book: document.getElementById('j_book').value,
          date: document.getElementById('j_date').value || FW.today(),
          vno: document.getElementById('j_vno').value.trim(),
          summary: document.getElementById('j_sum').value.trim(),
          income: parseFloat(document.getElementById('j_inc').value) || 0,
          expense: parseFloat(document.getElementById('j_exp').value) || 0
        };
        if (!rec.summary) { FW.toast('请填写摘要'); return; }
        FW.db.upsert(JK, rec); FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  /* ========== 账簿（柠檬云风格：由记账凭证自动汇总） ========== */
  function drawBook() {
    var body = document.getElementById('taxBody');
    if (state.book === 'journal') { drawJournal(); return; }
    if (!Object.keys(accountPostings()).length && !Object.keys(openings()).length) {
      body.innerHTML = '<div class="card"><div class="empty">还没有记账凭证，先去「凭证」录入，账簿会自动生成。</div></div>';
      return;
    }
    if (state.book === 'balance') drawBalance(body);
    else if (state.book === 'detail') drawDetail(body);
    else if (state.book === 'general') drawGeneral(body);
  }
  function drawBalance(body) {
    var map = buildLedger();
    var rows = '', totD = 0, totC = 0, totED = 0, totEC = 0, totBD = 0, totBC = 0;
    map.forEach(function (a) {
      rows += '<tr><td>' + FW.esc(a.name) + '</td>' +
        '<td class="num">' + FW.fmtMoney(a.beginDebit) + '</td><td class="num">' + FW.fmtMoney(a.beginCredit) + '</td>' +
        '<td class="num">' + FW.fmtMoney(a.debit) + '</td><td class="num">' + FW.fmtMoney(a.credit) + '</td>' +
        '<td class="num">' + FW.fmtMoney(a.endDebit) + '</td><td class="num">' + FW.fmtMoney(a.endCredit) + '</td></tr>';
      totBD += a.beginDebit; totBC += a.beginCredit; totD += a.debit; totC += a.credit; totED += a.endDebit; totEC += a.endCredit;
    });
    var totalRow = '<tr class="lm-total"><td><b>合计</b></td><td class="num">' + FW.fmtMoney(totBD) + '</td><td class="num">' + FW.fmtMoney(totBC) + '</td><td class="num">' + FW.fmtMoney(totD) + '</td><td class="num">' + FW.fmtMoney(totC) + '</td><td class="num">' + FW.fmtMoney(totED) + '</td><td class="num">' + FW.fmtMoney(totEC) + '</td></tr>';
    body.innerHTML = '<div class="card print-area"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">科目余额表 <span class="sub">单位：元（由凭证自动汇总，含期初）</span></h3><button class="btn ghost sm no-print" style="margin-left:auto" onclick="window.print()">🖨 打印</button></div>' +
      '<table><thead><tr><th>科目名称</th><th class="num">期初借方</th><th class="num">期初贷方</th><th class="num">本期借方</th><th class="num">本期贷方</th><th class="num">期末借方</th><th class="num">期末贷方</th></tr></thead><tbody>' + rows + totalRow + '</tbody></table></div>';
  }
  function drawGeneral(body) {
    var map = buildLedger();
    var blocks = map.map(function (a) {
      return '<div class="lm-gl-block"><div class="lm-gl-head">科目：' + FW.esc(a.name) + '　<span class="muted">（' + a.dir + '方余额）</span></div>' +
        '<table><tbody>' +
        '<tr><td>期初余额</td><td class="num">' + FW.fmtMoney(a.beginDebit) + '</td><td class="num">' + FW.fmtMoney(a.beginCredit) + '</td><td class="num">' + FW.fmtMoney(a.beginDebit - a.beginCredit) + '</td></tr>' +
        '<tr><td>本期借方</td><td class="num">' + FW.fmtMoney(a.debit) + '</td><td class="num">—</td><td class="num">' + FW.fmtMoney(a.debit) + '</td></tr>' +
        '<tr><td>本期贷方</td><td class="num">—</td><td class="num">' + FW.fmtMoney(a.credit) + '</td><td class="num">' + FW.fmtMoney(a.credit - a.debit) + '</td></tr>' +
        '<tr class="lm-total"><td>期末余额</td><td class="num">' + FW.fmtMoney(a.endDebit) + '</td><td class="num">' + FW.fmtMoney(a.endCredit) + '</td><td class="num">' + FW.fmtMoney(a.endDebit - a.endCredit) + '</td></tr>' +
        '</tbody></table></div>';
    }).join('');
    body.innerHTML = '<div class="card print-area"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">总账 <span class="sub">按科目汇总借贷与余额</span></h3><button class="btn ghost sm no-print" style="margin-left:auto" onclick="window.print()">🖨 打印</button></div>' + (blocks || '<div class="empty">暂无分录</div>') + '</div>';
  }
  function drawDetail(body) {
    var list = vouchers();
    var order = accOrder();
    var used = {};
    list.forEach(function (v) { (v.entries || []).forEach(function (e) { if (e.account) used[e.account] = 1; }); });
    var lm = ledgerMap();
    var blocks = order.filter(function (a) { return used[a]; }).map(function (a) {
      var l = lm[a] || { dir: '借', beginDebit: 0, beginCredit: 0 };
      var bal = l.dir === '借' ? (l.beginDebit - l.beginCredit) : (l.beginCredit - l.beginDebit);
      var lines = '';
      list.forEach(function (v) {
        (v.entries || []).forEach(function (e) {
          if (e.account !== a) return;
          var d = parseFloat(e.debit) || 0, c = parseFloat(e.credit) || 0;
          if (l.dir === '借') bal += (d - c); else bal += (c - d);
          lines += '<tr><td class="nowrap">' + FW.esc((v.word ? v.word + '-' : '') + v.no) + '</td><td class="nowrap">' + FW.esc(v.date) + '</td><td>' + FW.esc(e.summary || '') + '</td>' +
            '<td class="num">' + FW.fmtMoney(d) + '</td><td class="num">' + FW.fmtMoney(c) + '</td><td class="num">' + FW.fmtMoney(bal) + '</td></tr>';
        });
      });
      if (!lines) return '';
      return '<div class="lm-gl-block"><div class="lm-gl-head">科目：' + FW.esc(a) + '　<span class="muted">（' + l.dir + '方余额）</span></div>' +
        '<table><thead><tr><th>凭证号</th><th>日期</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th class="num">余额</th></tr></thead><tbody>' + lines + '</tbody></table></div>';
    }).join('');
    body.innerHTML = '<div class="card print-area"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">明细账 <span class="sub">逐笔登记，自动结转余额</span></h3><button class="btn ghost sm no-print" style="margin-left:auto" onclick="window.print()">🖨 打印</button></div>' + (blocks || '<div class="empty">暂无分录</div>') + '</div>';
  }

  /* ========== 固定资产 & 折旧 ========== */
  function assets() { return FW.db.getList(AK); }
  function saveAssets(a) { FW.db.saveList(AK, a); }
  function monthlyDep(a) { var life = (parseFloat(a.lifeYears) || 0) * 12; if (life <= 0) return 0; var salvage = (parseFloat(a.origin) || 0) * (parseFloat(a.salvageRate) || 0) / 100; return ((parseFloat(a.origin) || 0) - salvage) / life; }

  function drawAssets() {
    var list = assets();
    var totalMonth = list.reduce(function (s, a) { return s + monthlyDep(a); }, 0);
    var html = '<div class="stat-row"><div class="stat"><div class="label">资产原值合计</div><div class="value">' + FW.fmtMoney(list.reduce(function (s, a) { return s + (parseFloat(a.origin) || 0); }, 0)) + '</div></div>' +
      '<div class="stat"><div class="label">本月折旧额</div><div class="value expense">' + FW.fmtMoney(totalMonth) + '</div></div></div>';
    if (!list.length) {
      html += '<div class="card"><div class="empty">暂无固定资产，点右上角「新增资产」登记（如电脑、车辆、设备）。</div></div>';
    } else {
      var trs = list.map(function (a) {
        return '<tr><td>' + FW.esc(a.name) + '</td><td class="num">' + FW.fmtMoney(a.origin) + '</td><td class="num">' + (a.salvageRate || 0) + '%</td><td class="num">' + (a.lifeYears || 0) + ' 年</td><td class="num">' + (a.depMonths || 0) + ' 月</td><td class="num expense">' + FW.fmtMoney(monthlyDep(a)) + '</td>' +
          '<td class="row-actions nowrap"><button class="btn ghost sm a-edit" data-id="' + a.id + '">编辑</button><button class="btn danger sm a-del" data-id="' + a.id + '">删</button></td></tr>';
      }).join('');
      html += '<div class="card"><table><thead><tr><th>资产名称</th><th class="num">原值</th><th class="num">残值率</th><th class="num">折旧年限</th><th class="num">已提月数</th><th class="num">月折旧额</th><th>操作</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
    }
    html += '<div class="form-actions"><button class="btn" id="depBtn">🔧 计提本月折旧（生成凭证）</button></div>';
    document.getElementById('taxBody').innerHTML = html;
    var dep = document.getElementById('depBtn');
    if (dep) dep.onclick = function () { depreciate(); };
    FW.qa('#taxBody .a-edit').forEach(function (b) { b.onclick = function () { openAsset(b.dataset.id); }; });
    FW.qa('#taxBody .a-del').forEach(function (b) { b.onclick = function () { if (confirm('删除该资产？')) { saveAssets(assets().filter(function (x) { return x.id !== b.dataset.id; })); render(); FW.toast('已删除'); } }; });
  }

  function openAsset(id) {
    var edit = id ? assets().filter(function (x) { return x.id === id; })[0] : null;
    var v = edit || { name: '', origin: '', salvageRate: 5, lifeYears: 5, depMonths: 0 };
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>资产名称</label><input id="a_name" value="' + FW.esc(v.name) + '" placeholder="如：办公电脑"></div>' +
        '<div class="field"><label>原值（元）</label><input id="a_origin" type="number" step="0.01" min="0" value="' + FW.esc(v.origin) + '"></div>' +
        '<div class="field"><label>残值率（%）</label><input id="a_salvage" type="number" step="0.1" min="0" value="' + FW.esc(v.salvageRate) + '"></div>' +
        '<div class="field"><label>折旧年限（年）</label><input id="a_life" type="number" step="1" min="1" value="' + FW.esc(v.lifeYears) + '"></div>' +
        '<div class="field"><label>已计提月数</label><input id="a_depm" type="number" step="1" min="0" value="' + FW.esc(v.depMonths || 0) + '"></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="aCancel">取消</button><button class="btn" id="aSave">保存</button></div>';
    FW.openModal(edit ? '编辑资产' : '新增资产', body, function () {
      document.getElementById('aCancel').onclick = FW.closeModal;
      document.getElementById('aSave').onclick = function () {
        var rec = {
          id: edit ? edit.id : FW.db.uid('a_'),
          name: document.getElementById('a_name').value.trim(),
          origin: parseFloat(document.getElementById('a_origin').value) || 0,
          salvageRate: parseFloat(document.getElementById('a_salvage').value) || 0,
          lifeYears: parseFloat(document.getElementById('a_life').value) || 0,
          depMonths: parseInt(document.getElementById('a_depm').value, 10) || 0
        };
        if (!rec.name) { FW.toast('请输入资产名称'); return; }
        if (rec.origin <= 0 || rec.lifeYears <= 0) { FW.toast('原值与折旧年限需大于 0'); return; }
        var list = assets();
        if (edit) list = list.map(function (x) { return x.id === rec.id ? rec : x; }); else list.push(rec);
        saveAssets(list); FW.closeModal(); render(); FW.toast('已保存资产');
      };
    });
  }

  function depreciate() {
    var list = assets();
    if (!list.length) { FW.toast('请先登记固定资产'); return; }
    var total = 0;
    list.forEach(function (a) { total += monthlyDep(a); });
    if (total <= 0) { FW.toast('折旧额为 0，请检查原值/年限'); return; }
    var rec = {
      id: FW.db.uid('v_'), word: '转', no: nextNo(), date: FW.today(), attach: 0, maker: '折旧计提', status: 'audited',
      entries: [{ summary: '计提本月折旧', account: '管理费用-折旧费', debit: total, credit: 0 }, { summary: '计提本月折旧', account: '累计折旧', debit: 0, credit: total }],
      totalDebit: total, totalCredit: total
    };
    FW.db.upsert(VK, rec);
    // 已计提月数 +1
    saveAssets(list.map(function (a) { return Object.assign({}, a, { depMonths: (a.depMonths || 0) + 1 }); }));
    render(); FW.toast('已生成折旧凭证（转-' + rec.no + '），折旧 ' + FW.fmtMoney(total));
  }

  /* ========== 申报财务报表（自动取数） ========== */
  function drawReport() {
    var body = document.getElementById('taxBody');
    if (state.report === 'bs') drawBS(body);
    else if (state.report === 'pl') drawPL(body);
    else drawCF(body);
  }

  function bsValue() {
    var cash = normBal('库存现金') + normBal('银行存款') + normBal('其他货币资金');
    var ar = normBal('应收账款') + normBal('应收票据');
    var apay = normBal('预付账款');
    var inv = normBal('库存商品') + normBal('原材料');
    var fa = normBal('固定资产') - normBal('累计折旧');
    var ia = normBal('无形资产');
    var ca = cash + ar + apay + inv;
    var nca = fa + ia;
    var ta = ca + nca;
    var cl = normBal('短期借款') + normBal('应付账款') + normBal('预收账款') + normBal('应付职工薪酬') + normBal('应交税费') + normBal('其他应付款');
    var ncl = normBal('长期借款');
    var tl = cl + ncl;
    var undist = normBal('本年利润') + normBal('利润分配');
    var eq = normBal('实收资本') + normBal('资本公积') + normBal('盈余公积') + undist;
    var tle = tl + eq;
    return { cash: cash, ar: ar, apay: apay, inv: inv, fa: fa, ia: ia, ca: ca, nca: nca, ta: ta, cl: cl, ncl: ncl, tl: tl, undist: undist, eq: eq, tle: tle };
  }

  function drawBS(body) {
    var b = bsValue();
    var diff = b.ta - b.tle;
    var rows = [
      ['流动资产', '流动负债'],
      ['货币资金', b.cash, '短期借款', b.cl],
      ['应收账款', b.ar, '应付账款', normBal('应付账款')],
      ['预付账款', b.apay, '预收账款', normBal('预收账款')],
      ['存货', b.inv, '应付职工薪酬', normBal('应付职工薪酬')],
      ['', 0, '应交税费', normBal('应交税费')],
      ['', 0, '其他应付款', normBal('其他应付款')],
      ['流动资产合计', b.ca, '流动负债合计', b.cl],
      ['非流动资产', '非流动负债'],
      ['固定资产（净值）', b.fa, '长期借款', b.ncl],
      ['无形资产', b.ia, '非流动负债合计', b.ncl],
      ['非流动资产合计', b.nca, '负债合计', b.tl],
      ['资产总计', b.ta, '所有者权益', ''],
      ['', 0, '实收资本', normBal('实收资本')],
      ['', 0, '资本公积', normBal('资本公积')],
      ['', 0, '盈余公积', normBal('盈余公积')],
      ['', 0, '未分配利润', b.undist],
      ['', 0, '所有者权益合计', b.eq],
      ['', 0, '负债和所有者权益总计', b.tle]
    ];
    function cell(v) { return v === '' ? '' : '<td class="num">' + FW.fmtMoney(v) + '</td>'; }
    function hd(v) { return v === '' ? '<td></td>' : '<td colspan="2" class="bs-head">' + v + '</td>'; }
    var html = rows.map(function (r) {
      if (r[0] === '流动资产' || r[0] === '非流动资产' || r[0] === '资产总计' || r[0] === '所有者权益') {
        if (r[0] === '资产总计') return '<tr class="lm-total"><td><b>资产总计</b></td>' + cell(r[1]) + hd(r[2]) + '</tr>';
        return '<tr>' + hd(r[0]) + (r[2] !== '' ? hd(r[2]) : '<td colspan="2"></td>') + '</tr>';
      }
      if (r[0] === '' && r[2] === '') return '';
      var left = r[0] === '' ? '<td></td><td></td>' : '<td>' + r[0] + '</td>' + cell(r[1]);
      var right = r[2] === '' ? '<td></td><td></td>' : '<td>' + r[2] + '</td>' + cell(r[3]);
      var strong = (r[0].indexOf('合计') >= 0 || r[2].indexOf('合计') >= 0 || r[0] === '资产总计' || r[2] === '负债和所有者权益总计');
      return '<tr' + (strong ? ' class="lm-total"' : '') + '>' + left + right + '</tr>';
    }).join('');
    var tag = Math.abs(diff) < 0.005
      ? '<span class="tag expense">✓ 平衡（资产 = 负债 + 权益）</span>'
      : '<span class="tag income">✗ 不平衡，差额 ' + FW.fmtMoney(diff) + '（检查凭证/期初）</span>';
    body.innerHTML = '<div class="card print-area"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">资产负债表 <span class="sub">单位：元（由科目余额表自动生成）</span></h3><button class="btn ghost sm no-print" style="margin-left:auto" onclick="window.print()">🖨 打印</button></div>' +
      '<table><thead><tr><th>资产</th><th class="num">金额</th><th>负债及所有者权益</th><th class="num">金额</th></tr></thead><tbody>' + html + '</tbody></table>' +
      '<div style="margin-top:10px">' + tag + '</div></div>';
  }

  function drawPL(body) {
    var rev = normBal('主营业务收入') + normBal('其他业务收入') + normBal('投资收益');
    var opInc = normBal('营业外收入');
    var cost = normBal('主营业务成本') + normBal('其他业务成本');
    var taxAttach = normBal('税金及附加');
    var sell = normBal('销售费用');
    var mgmt = normBal('管理费用');
    var fin = normBal('财务费用');
    var opEx = normBal('营业外支出');
    var incTax = normBal('所得税费用');
    var closed = (rev === 0 && cost === 0 && taxAttach === 0 && sell === 0 && mgmt === 0 && fin === 0 && opInc === 0 && opEx === 0 && incTax === 0);
    function row(label, val, strong) { return '<tr' + (strong ? ' class="lm-total"' : '') + '><td>' + label + '</td><td class="num">' + (strong ? '<b>' : '') + FW.fmtMoney(val) + (strong ? '</b>' : '') + '</td></tr>'; }
    var html;
    if (closed) {
      var np = normBal('本年利润');
      html = row('营业收入', 0) + row('减：营业成本', 0) + row('税金及附加', 0) + row('销售费用', 0) + row('管理费用', 0) + row('财务费用', 0) +
        row('营业利润', 0) + row('加：营业外收入', 0) + row('减：营业外支出', 0) + row('利润总额', 0) +
        row('减：所得税费用', 0) + row('净利润（已结转至本年利润）', np, true) +
        '<tr><td colspan="2" class="muted" style="font-size:12px">损益已结转，净利润 ' + FW.fmtMoney(np) + ' 已并入资产负债表「未分配利润」，详见报表。</td></tr>';
    } else {
      var op = rev - cost - taxAttach - sell - mgmt - fin;
      var tp = op + opInc - opEx;
      var np2 = tp - incTax;
      html = row('营业收入', rev) + row('减：营业成本', cost) + row('税金及附加', taxAttach) + row('销售费用', sell) + row('管理费用', mgmt) + row('财务费用', fin) +
        row('营业利润', op, true) + row('加：营业外收入', opInc) + row('减：营业外支出', opEx) +
        row('利润总额', tp, true) + row('减：所得税费用', incTax) + row('净利润', np2, true);
    }
    body.innerHTML = '<div class="card print-area"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">利润表 <span class="sub">单位：元（由损益科目余额自动计算）</span></h3><button class="btn ghost sm no-print" style="margin-left:auto" onclick="window.print()">🖨 打印</button></div><table><tbody>' + html + '</tbody></table></div>';
  }

  function drawCF(body) {
    var cf = buildCashFlow();
    function row(label, val, strong) { return '<tr' + (strong ? ' class="lm-total"' : '') + '><td>' + label + '</td><td class="num">' + (strong ? '<b>' : '') + FW.fmtMoney(val) + (strong ? '</b>' : '') + '</td></tr>'; }
    var opNet = cf.opIn - cf.opOut, invNet = cf.invIn - cf.invOut, finNet = cf.finIn - cf.finOut, net = opNet + invNet + finNet;
    body.innerHTML = '<div class="card print-area"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">现金流量表 <span class="sub">单位：元（按凭证中现金/银行存款收支自动分类）</span></h3><button class="btn ghost sm no-print" style="margin-left:auto" onclick="window.print()">🖨 打印</button></div><table><tbody>' +
      '<tr><td colspan="2" class="bs-head">一、经营活动产生的现金流量</td></tr>' +
      row('销售商品、提供劳务收到的现金', cf.opIn) +
      row('收到的税费返还', 0) +
      row('收到其他与经营活动有关的现金', 0) +
      row('购买商品、接受劳务支付的现金', cf.opOut) +
      row('支付给职工以及为职工支付的现金', 0) +
      row('支付的各项税费', 0) +
      row('支付其他与经营活动有关的现金', 0) +
      row('经营活动产生的现金流量净额', opNet, true) +
      '<tr><td colspan="2" class="bs-head">二、投资活动产生的现金流量</td></tr>' +
      row('收回投资及处置资产收到的现金', cf.invIn) +
      row('投资支付的现金', cf.invOut) +
      row('投资活动产生的现金流量净额', invNet, true) +
      '<tr><td colspan="2" class="bs-head">三、筹资活动产生的现金流量</td></tr>' +
      row('吸收投资、取得借款收到的现金', cf.finIn) +
      row('偿还债务、分配利润支付的现金', cf.finOut) +
      row('筹资活动产生的现金流量净额', finNet, true) +
      row('四、现金及现金等价物净增加额', net, true) +
      '</tbody></table></div>';
  }

  FW.modules = FW.modules || {};
  FW.modules.tax = {
    title: '报税记账', render: render,
    // 供测试 / 编程调用
    getAccounts: getAccounts,
    matchAccounts: matchAccounts,
    suggestAccount: suggestAccount,
    addAccount: function (name, kw) {
      name = (name || '').trim(); if (!name) return false;
      if (getAccounts().some(function (a) { return a.name === name; })) return false;
      var st = getAccStore();
      var isBuiltin = CHART.some(function (x) { return x.name === name; });
      if (isBuiltin) st.deleted = (st.deleted || []).filter(function (n) { return n !== name; });
      else { st.added = st.added || []; st.added.push({ name: name, kw: (kw || []).slice() }); }
      setAccStore(st); rebuildAccChart(); return true;
    },
    delAccount: function (name) {
      var st = getAccStore();
      var isBuiltin = CHART.some(function (x) { return x.name === name; });
      if (isBuiltin) st.deleted = (st.deleted || []).concat([name]);
      else st.added = st.added || []; st.added = st.added.filter(function (a) { return a.name !== name; });
      setAccStore(st); rebuildAccChart(); return true;
    },
    buildLedger: buildLedger,
    normBal: normBal,
    carryForward: carryForward,
    openings: openings,
    setOpenings: setOpenings,
    parseCSV: parseCSV,
    assets: assets,
    monthlyDep: monthlyDep
  };
})(window);
