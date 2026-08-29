/* ============================================================
 * 发票台账模块
 *   - 进项发票（采购）：记录销售方、税额、抵扣状态（未勾选/已勾选/已认证/不抵扣）
 *   - 销项发票（销售）：记录购买方、销项税额（应纳）
 *   - 自动汇总：进项可抵扣税额、待勾选税额、销项税额、增值税测算（含留抵）
 *   - 支持期间筛选、关键词搜索、CSV 导出、打印
 * 数据键：invoices（按账本隔离，见 db.js）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  if (global.pdfjsLib) { try { global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js'; } catch (e) {} }
  var KEY = 'invoices';
  var CONTRACT_KEY = 'contracts';
  var STOCK_KEY = 'stock';
  var DEDUCT_OPTS = ['未勾选', '已勾选', '已认证', '不抵扣'];
  var KIND_OPTS = ['专票', '普票', '数电票', '机动车', '其他'];
  var STATUS_OPTS = ['待签订', '履行中', '已完成', '已终止'];
  var CTYPE_OPTS = ['采购合同', '销售合同', '服务合同', '工程合同', '其他'];
  var PAY_OPTS = ['一次性付款', '分期付款', '月结', '货到付款', '其他'];
  // 库存台账：出入库 / 退货类型（dir: in 入库方向 / out 出库方向）
  var STOCK_TYPES = [
    { label: '采购入库', dir: 'in' },
    { label: '其他入库', dir: 'in' },
    { label: '销售退货', dir: 'in' },
    { label: '销售出库', dir: 'out' },
    { label: '其他出库', dir: 'out' },
    { label: '采购退货', dir: 'out' }
  ];
  function stockDir(label) { var t = STOCK_TYPES.filter(function (x) { return x.label === label; })[0]; return t ? t.dir : 'in'; }

  /* ---------- 产品名归一（别名 → 标准名） ---------- */
  // 同一件货在不同单据里写法可能不同（「能量套」/「赫娇七彩时光焕颜能量套」），
  // 归一只影响「汇总 / 均价 / 结存 / 项目核算下钻」的分组，不改原始单据文字（可一键批量改写）。
  var ALIAS_KEY = 'cw_item_alias';
  function loadAlias() { try { return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveAlias(m) { try { localStorage.setItem(ALIAS_KEY, JSON.stringify(m || {})); } catch (e) {} }
  // 支持链式归一（A→B→C），带环检测
  function normItem(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return s;
    var m = loadAlias(), cur = s, seen = {};
    for (var i = 0; i < 20; i++) {
      var nx = String(m[cur] == null ? '' : m[cur]).trim();
      if (!nx || nx === cur || seen[nx]) break;
      seen[nx] = 1; cur = nx;
    }
    return cur;
  }
  // 相似度：去空白/括号后比较；子串直接判高相似，否则用二元组 Jaccard
  function itemSim(a, b) {
    var x = String(a || '').replace(/[\s（）()【】\[\]·、,，/]/g, '');
    var y = String(b || '').replace(/[\s（）()【】\[\]·、,，/]/g, '');
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return 0.9;
    var sa = {}, n = 0, i;
    for (i = 0; i < x.length - 1; i++) { sa[x.substr(i, 2)] = 1; n++; }
    var m = 0, hit = 0;
    for (i = 0; i < y.length - 1; i++) { m++; if (sa[y.substr(i, 2)]) hit++; }
    if (!n || !m) return 0;
    return (hit * 2) / (n + m);
  }
  // 库存里出现过的所有产品名（按单据数降序）
  function stockItemNames() {
    var cnt = {};
    (FW.db.getList(STOCK_KEY) || []).forEach(function (t) {
      var n = String(t.item || '').trim();
      if (!n) return;
      cnt[n] = (cnt[n] || 0) + 1;
    });
    return Object.keys(cnt).map(function (n) { return { name: n, count: cnt[n] }; })
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name, 'zh'); });
  }
  // 自动建议：相似的名字归到「更长更完整」的那个名下
  function suggestAlias() {
    var names = stockItemNames().map(function (x) { return x.name; });
    var sorted = names.slice().sort(function (a, b) { return b.length - a.length; });
    var sug = {};
    sorted.forEach(function (a) {
      if (sug[a]) return;                       // a 已被归给别人，不再当标准名
      sorted.forEach(function (b) {
        if (b === a || sug[b]) return;
        if (itemSim(a, b) >= 0.7) sug[b] = a;
      });
    });
    return sug;
  }
  // 疑似但未自动归并的配对（0.4 ≤ sim < 0.7），供人工确认
  function suspectPairs() {
    var names = stockItemNames().map(function (x) { return x.name; });
    var out = [], i, j;
    for (i = 0; i < names.length; i++) {
      for (j = i + 1; j < names.length; j++) {
        var s = itemSim(names[i], names[j]);
        if (s >= 0.4 && s < 0.7) out.push({ a: names[i], b: names[j], sim: s });
      }
    }
    return out.sort(function (x, y) { return y.sim - x.sim; }).slice(0, 20);
  }
  // 把历史单据的 item 直接改写成标准名（不可自动撤销，需确认）
  function rewriteItemNames() {
    var m = loadAlias(), n = 0, list = FW.db.getList(STOCK_KEY) || [];
    list.forEach(function (t) {
      var raw = String(t.item || '').trim();
      var std = normItem(raw);
      if (std !== raw) { t.item = std; FW.db.upsert(STOCK_KEY, t); n++; }
    });
    return n;
  }
  // 单据明细里提示「该名称已被归并到标准名」
  function aliasTip(item) {
    var raw = String(item || '').trim(), std = normItem(raw);
    if (!std || !raw || std === raw) return '';
    return '<div class="al-tip-inline" title="已按产品名归一设置合并计算">汇总按：' + FW.esc(std) + '</div>';
  }
  // 暴露给其他模块（项目核算下钻按标准名聚合）
  FW.itemAlias = { norm: normItem, load: loadAlias, save: saveAlias };

  /* ---------- 调货单粘贴解析（进多少出多少） ---------- */
  // 默认单价规则（关键词包含匹配）与排除项；用户可在弹窗内改动并存本地
  var TRANSFER_CONF_KEY = 'cw_transfer_conf';
  var DEFAULT_TRANSFER_CONF = {
    prices: [
      { kw: '能量套', price: 35 },
      { kw: '面膜', price: 40 },
      { kw: '按摩', price: 10 }
    ],
    exclude: ['售后卡'],
    unit: '盒',
    lastPeriod: ''
  };
  function loadTransferConf() {
    try {
      var raw = localStorage.getItem(TRANSFER_CONF_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_TRANSFER_CONF));
      var c = JSON.parse(raw) || {};
      return {
        prices: (c.prices && c.prices.length) ? c.prices : DEFAULT_TRANSFER_CONF.prices.slice(),
        exclude: (c.exclude && c.exclude.length) ? c.exclude : DEFAULT_TRANSFER_CONF.exclude.slice(),
        unit: c.unit || DEFAULT_TRANSFER_CONF.unit,
        lastPeriod: c.lastPeriod || ''
      };
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_TRANSFER_CONF)); }
  }
  function saveTransferConf(c) { try { localStorage.setItem(TRANSFER_CONF_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------- 调货单「防重复 + 一键撤销」 ---------- */
  var LASTGEN_KEY = 'cw_stock_last_gen';
  function loadLastGen() {
    try {
      var raw = localStorage.getItem(LASTGEN_KEY);
      if (!raw) return null;
      var g = JSON.parse(raw);
      if (!g || !g.ids || !g.ids.length) return null;
      // 只保留仍然存在的记录，避免手工删过之后撤销时报错
      var alive = g.ids.filter(function (id) { return !!FW.db.getById(STOCK_KEY, id); });
      if (!alive.length) { localStorage.removeItem(LASTGEN_KEY); return null; }
      g.ids = alive; g.count = alive.length;
      return g;
    } catch (e) { return null; }
  }
  function saveLastGen(g) { try { localStorage.setItem(LASTGEN_KEY, JSON.stringify(g)); } catch (e) {} }
  function clearLastGen() { try { localStorage.removeItem(LASTGEN_KEY); } catch (e) {} }
  // 检测同一「调货日期 + 营期」是否已有调货单解析生成的记录
  function findTransferDup(date, period) {
    return (FW.db.getList(STOCK_KEY) || []).filter(function (t) {
      if (t.date !== date) return false;
      if (String(t.period || '').trim() !== String(period || '').trim()) return false;
      return String(t.remark || '').indexOf('调货单粘贴解析') >= 0;
    });
  }
  function undoStockLastGen() {
    var g = loadLastGen();
    if (!g) { FW.toast('没有可撤销的生成记录'); return; }
    var msg = '确定撤销上次生成的 ' + g.count + ' 条调货记录？\n' +
      '日期：' + (g.date || '—') + '　营期：' + (g.period || '未填') + '\n' +
      '（只删这次生成的，不影响其他单据）';
    if (!confirm(msg)) return;
    g.ids.forEach(function (id) {
      var rec = FW.db.getById(STOCK_KEY, id);
      if (rec && rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
      FW.db.remove(STOCK_KEY, id);
    });
    clearLastGen();
    renderStockView();
    FW.toast('已撤销 ' + g.count + ' 条记录');
  }
  // 按关键词匹配单价（先按标准名归一，短名写法也能命中规则）
  function matchPrice(item, conf) {
    var name = normItem(item);
    var ps = (conf && conf.prices) || [];
    for (var i = 0; i < ps.length; i++) {
      var k = String(ps[i].kw || '').trim();
      if (k && name.indexOf(k) >= 0) return Number(ps[i].price) || 0;
    }
    return 0;
  }
  // 解析调货文本：全局扫描「产品名 + x/X/×/* + 数量」，不依赖分隔符（条目间只有空格也能识别）
  // 命中排除词（如售后卡）直接跳过；同名产品数量累加
  function parseTransferText(text, conf) {
    var c = conf || loadTransferConf();
    var ex = c.exclude || [];
    var s = String(text || '');
    var map = {}, order = [];
    var re = /([^\s，,、；;]+)\s*[xX×*＊]\s*(\d+(?:\.\d+)?)/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var name = normItem(String(m[1] || '').trim());
      var qty = Number(m[2]);
      if (!name || !(qty > 0)) continue;
      var skip = ex.some(function (k) { return k && name.indexOf(String(k)) >= 0; });
      if (skip) continue;
      if (!map[name]) { map[name] = { item: name, qty: 0, price: matchPrice(name, c) }; order.push(name); }
      map[name].qty += qty;
    }
    return order.map(function (k) { return map[k]; });
  }

  var state = {
    tab: 'all',          // all / in / out / contract / stock
    deduction: '',       // 进项抵扣筛选
    kw: '',
    from: '', to: '',
    photos: [],
    // 合同台账筛选
    ctKw: '', ctFrom: '', ctTo: '', ctStatus: '',
    ctPhotos: [], ctDocFiles: [], ctAttachments: [],
    // 库存台账筛选
    stKw: '', stFrom: '', stTo: '', stType: '',
    stView: 'detail',   // detail 单据明细 / period 按营期汇总 / settle 结算对账
    stPeriodOpen: {},   // 汇总视图中「产品按发货日期展开」的展开状态：key = period|item
    stSettleMode: 'next', // 退货抵扣方式：next 月末归集次月初抵扣 / cur 当期直接抵扣
    stSettleOpen: {},   // 结算视图中「期段展开」的展开状态：key = 期段标签
    stPhotos: []
  };

  /* ---------- 数据读写 ---------- */
  function all() { return FW.db.getList(KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function inRange(t, from, to) { return (!from || t.date >= from) && (!to || t.date <= to); }
  function hasKw(t) {
    if (!state.kw) return true;
    var k = state.kw.toLowerCase();
    return [t.number, t.code, t.party, t.remark, t.category].some(function (f) { return (f || '').toLowerCase().indexOf(k) >= 0; });
  }
  function filtered() {
    return all().filter(function (t) {
      if (state.tab === 'in' && t.direction !== 'in') return false;
      if (state.tab === 'out' && t.direction !== 'out') return false;
      if (state.deduction && t.direction === 'in' && t.deduction !== state.deduction) return false;
      if (!inRange(t, state.from, state.to)) return false;
      return hasKw(t);
    });
  }

  /* ---------- 汇总计算（供验证 / 复用） ---------- */
  function computeSummary(rows, from, to) {
    var list = rows.filter(function (t) { return inRange(t, from, to); });
    var ins = list.filter(function (t) { return t.direction === 'in'; });
    var outs = list.filter(function (t) { return t.direction === 'out'; });
    function sum(arr, f) { return arr.reduce(function (a, t) { return a + num(t[f]); }, 0); }
    var inTotal = sum(ins, 'total'), inAmt = sum(ins, 'amount'), inTax = sum(ins, 'tax');
    var outTotal = sum(outs, 'total'), outAmt = sum(outs, 'amount'), outTax = sum(outs, 'tax');
    var deductible = ins.filter(function (t) { return t.deduction === '已勾选' || t.deduction === '已认证'; }).reduce(function (a, t) { return a + num(t.tax); }, 0);
    var pending = ins.filter(function (t) { return t.deduction === '未勾选'; }).reduce(function (a, t) { return a + num(t.tax); }, 0);
    var nonDeduct = ins.filter(function (t) { return t.deduction === '不抵扣'; }).reduce(function (a, t) { return a + num(t.tax); }, 0);
    var vat = outTax - deductible; // 负数=留抵
    return {
      inCount: ins.length, inTotal: inTotal, inAmt: inAmt, inTax: inTax,
      outCount: outs.length, outTotal: outTotal, outAmt: outAmt, outTax: outTax,
      deductible: deductible, pending: pending, nonDeduct: nonDeduct,
      vat: vat, carryForward: vat < 0 ? -vat : 0
    };
  }

  /* ---------- 渲染辅助 ---------- */
  function money(x) { return FW.fmtMoney(x); }
  function dirMeta(t) {
    if (t.direction === 'in') return { tag: '进项', cls: 'expense' };
    return { tag: '销项', cls: 'income' };
  }
  function dedMeta(d) {
    if (d === '已勾选' || d === '已认证') return 'ok';
    if (d === '不抵扣') return 'neutral';
    return 'warn';
  }

  /* ---------- 主渲染（按 tab 分发） ---------- */
  function render() {
    if (state.tab === 'contract') return renderContractView();
    if (state.tab === 'stock') return renderStockView();
    return renderInvoiceView();
  }

  function renderInvoiceView() {
    var c = document.getElementById('content');
    var list = filtered();
    var s = computeSummary(all(), state.from, state.to);

    var dedOpts = '<option value="">全部抵扣状态</option>' + DEDUCT_OPTS.map(function (d) { return '<option' + (state.deduction === d ? ' selected' : '') + '>' + d + '</option>'; }).join('');

    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">统计期间：</span>' +
        '<button class="btn ghost sm" data-r="month">本月</button>' +
        '<button class="btn ghost sm" data-r="quarter">本季</button>' +
        '<button class="btn ghost sm" data-r="year">本年</button>' +
        '<button class="btn ghost sm" data-r="all">全部</button>' +
        '<div class="field"><input id="invFrom" type="date" value="' + FW.esc(state.from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="invTo" type="date" value="' + FW.esc(state.to) + '" title="结束日期"></div>' +
      '</div></div>' +
      '<div class="stat-row" id="invSummary"></div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="field"><input id="invKw" placeholder="搜索发票号码/单位/备注" value="' + FW.esc(state.kw) + '"></div>' +
          (state.tab === 'in' ? '<div class="field"><select id="invDed">' + dedOpts + '</select></div>' : '') +
          '<button class="btn ghost sm" id="invReset">重置</button>' +
        '</div>' +
        '<div id="invWrap"></div>' +
      '</div>';

    // 顶部操作区
    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="invPrint">🖨 打印</button><button class="btn ghost" id="invCsv">⬇ 导出CSV</button><button class="btn" id="addInvBtn">＋ 新增发票</button>';
    document.getElementById('invPrint').onclick = function () { window.print(); };
    document.getElementById('invCsv').onclick = exportCsv;
    document.getElementById('addInvBtn').onclick = function () { openForm(null, state.tab === 'in' ? 'in' : (state.tab === 'out' ? 'out' : 'in')); };

    drawSummary(s);
    drawTable(list);

    // 事件
    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setRange(b.dataset.r); }; });
    var gf = document.getElementById('invFrom'), gt = document.getElementById('invTo');
    if (gf) gf.onchange = function () { state.from = this.value; render(); };
    if (gt) gt.onchange = function () { state.to = this.value; render(); };
    var gk = document.getElementById('invKw'); if (gk) gk.oninput = function () { state.kw = this.value.trim(); drawTable(filtered()); };
    var gd = document.getElementById('invDed'); if (gd) gd.onchange = function () { state.deduction = this.value; drawTable(filtered()); };
    var gr = document.getElementById('invReset'); if (gr) gr.onclick = function () { state.kw = ''; state.deduction = ''; state.from = ''; state.to = ''; render(); };
  }

  function drawSummary(s) {
    var el = document.getElementById('invSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="label">进项（' + s.inCount + '份）</div><div class="value">' + money(s.inTotal) + '</div><div class="sub">税额 ' + money(s.inTax) + '</div></div>' +
      '<div class="stat"><div class="label">进项·可抵扣</div><div class="value income">' + money(s.deductible) + '</div><div class="sub">已勾选+已认证</div></div>' +
      '<div class="stat"><div class="label">进项·待勾选</div><div class="value ' + (s.pending > 0 ? 'expense' : '') + '">' + money(s.pending) + '</div><div class="sub">待认证</div></div>' +
      '<div class="stat"><div class="label">销项（' + s.outCount + '份）</div><div class="value">' + money(s.outTotal) + '</div><div class="sub">销项税额 ' + money(s.outTax) + '</div></div>' +
      '<div class="stat"><div class="label">增值税测算</div><div class="value ' + (s.vat >= 0 ? 'expense' : 'income') + '">' + money(s.vat) + '</div><div class="sub">' + (s.vat < 0 ? ('留抵 ' + money(s.carryForward)) : '应纳') + '</div></div>';
  }

  function drawTable(rows) {
    var el = document.getElementById('invWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的发票。点右上角「＋ 新增发票」登记第一张，或切到「全部」查看。</div>';
      return;
    }
    var trs = rows.map(function (t) {
      var dm = dirMeta(t);
      var ded = t.direction === 'in'
        ? '<span class="tag ' + dedMeta(t.deduction) + '">' + FW.esc(t.deduction || '未勾选') + '</span>'
        : '<span class="muted">—</span>';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date) + '</td>' +
        '<td><span class="tag ' + dm.cls + '">' + dm.tag + '</span></td>' +
        '<td>' + FW.esc(t.kind || '—') + '</td>' +
        '<td>' + FW.esc(t.number || '') + (t.code ? '<div class="muted" style="font-size:11px">代码 ' + FW.esc(t.code) + '</div>' : '') + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td>' + (t.category ? FW.esc(t.category) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + money(t.total) + '</td>' +
        '<td class="num">' + (t.direction === 'in' ? '<span class="expense">' + money(t.tax) + '</span>' : '<span class="income">' + money(t.tax) + '</span>') + '</td>' +
        '<td>' + ded + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>日期</th><th>方向</th><th>类型</th><th>发票号码</th><th>对方单位</th><th>用途分类</th><th class="num">价税合计</th><th class="num">税额</th><th>抵扣状态</th><th>备注</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
    FW.qa('#invWrap .row-edit').forEach(function (b) { b.onclick = function () { openForm(b.dataset.id); }; });
    FW.qa('#invWrap .row-del').forEach(function (b) { b.onclick = function () { delInv(b.dataset.id); }; });
  }

  /* ---------- 新增 / 编辑 表单 ---------- */
  function openForm(id, presetDir) {
    var edit = id ? FW.db.getById(KEY, id) : null;
    var v = {
      date: FW.today(), direction: presetDir || 'in', kind: '专票',
      code: '', number: '', party: '', amount: '', tax: '', total: '',
      deduction: '未勾选', category: '', remark: '', photos: []
    };
    if (edit) {
      v = {
        date: edit.date || FW.today(), direction: edit.direction || 'in', kind: edit.kind || '专票',
        code: edit.code || '', number: edit.number || '', party: edit.party || '',
        amount: edit.amount, tax: edit.tax, total: edit.total,
        deduction: edit.deduction || '未勾选', category: edit.category || '', remark: edit.remark || '', photos: edit.photos || []
      };
    }
    state.photos = v.photos.slice();

    var cats = (FW.modules.internal && FW.modules.internal.cats) ? FW.modules.internal.cats() : [];
    var catOpts = '<option value="">（不归类）</option>' + cats.map(function (c) { return '<option ' + (c.name === v.category ? 'selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('');

    function dirHtml() {
      var sel = (v.direction === 'in')
        ? '<option value="in" selected>进项（采购·可抵扣）</option><option value="out">销项（销售·应纳）</option>'
        : '<option value="in">进项（采购·可抵扣）</option><option value="out" selected>销项（销售·应纳）</option>';
      return '<select id="f_dir">' + sel + '</select>';
    }

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>方向</label>' + dirHtml() + '</div>' +
        '<div class="field"><label>发票类型</label><select id="f_kind">' + KIND_OPTS.map(function (k) { return '<option ' + (k === v.kind ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>开票日期</label><input id="f_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>发票号码</label><input id="f_no" value="' + FW.esc(v.number) + '" placeholder="发票号码（必填）"></div>' +
        '<div class="field"><label>发票代码</label><input id="f_code" value="' + FW.esc(v.code) + '" placeholder="选填"></div>' +
        '<div class="field full"><label>对方单位名称</label><input id="f_party" value="' + FW.esc(v.party) + '" placeholder="进项填销售方 / 销项填购买方"></div>' +
        '<div class="field"><label>不含税金额（元）</label><input id="f_amt" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
        '<div class="field"><label>税额（元）</label><input id="f_tax" type="number" step="0.01" min="0" value="' + FW.esc(v.tax) + '"></div>' +
        '<div class="field"><label>价税合计（元）</label><input id="f_total" type="number" step="0.01" min="0" value="' + FW.esc(v.total) + '" placeholder="留空自动算"></div>' +
        '<div class="field"><label>用途分类</label><select id="f_cat">' + catOpts + '</select></div>' +
        '<div class="field" id="dedField"><label>抵扣状态</label><select id="f_ded">' + DEDUCT_OPTS.map(function (d) { return '<option ' + (d === v.deduction ? 'selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>' +
        '<div class="field full"><label>备注</label><textarea id="f_remark" rows="2" placeholder="用途说明 / 关联单据">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>发票 / 凭证照片</label><div class="photo-grid" id="photoGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="invCancel">取消</button><button class="btn" id="invSave">保存</button></div>';

    FW.openModal(edit ? '编辑发票' : '新增发票', body, function () {
      var dirSel = document.getElementById('f_dir');
      function syncDir() {
        var isIn = dirSel.value === 'in';
        document.getElementById('dedField').style.display = isIn ? '' : 'none';
      }
      dirSel.onchange = syncDir; syncDir();
      renderPhotoGrid(state.photos);

      // 自动计算价税合计
      function autoTotal() {
        var a = num(document.getElementById('f_amt').value);
        var tx = num(document.getElementById('f_tax').value);
        var tt = document.getElementById('f_total');
        if (a > 0 && tx > 0 && !tt.value) tt.value = (a + tx).toFixed(2);
      }
      document.getElementById('f_amt').oninput = autoTotal;
      document.getElementById('f_tax').oninput = autoTotal;

      document.getElementById('invCancel').onclick = FW.closeModal;
      document.getElementById('invSave').onclick = function () {
        var number = document.getElementById('f_no').value.trim();
        if (!number) { FW.toast('请填写发票号码'); return; }
        var amount = num(document.getElementById('f_amt').value);
        var tax = num(document.getElementById('f_tax').value);
        var totalRaw = document.getElementById('f_total').value;
        var total = totalRaw ? num(totalRaw) : (amount + tax);
        if (!(total > 0)) { FW.toast('价税合计必须大于 0'); return; }
        var direction = dirSel.value;
        var rec = {
          id: edit ? edit.id : FW.db.uid('inv_'),
          direction: direction,
          kind: document.getElementById('f_kind').value,
          code: document.getElementById('f_code').value.trim(),
          number: number,
          date: document.getElementById('f_date').value || FW.today(),
          party: document.getElementById('f_party').value.trim(),
          amount: amount, tax: tax, total: total,
          deduction: direction === 'in' ? document.getElementById('f_ded').value : '',
          category: document.getElementById('f_cat').value,
          remark: document.getElementById('f_remark').value.trim(),
          photos: state.photos
        };
        FW.db.upsert(KEY, rec);
        FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  function delInv(id) {
    var rec = FW.db.getById(KEY, id);
    if (!rec) return;
    if (!confirm('确定删除该张发票？' + (rec.photos && rec.photos.length ? '（将同时删除 ' + rec.photos.length + ' 张凭证照片）' : ''))) return;
    FW.db.remove(KEY, id);
    if (rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
    render(); FW.toast('已删除');
  }

  /* ---------- 照片网格（复刻 internal 的精简版） ---------- */
  function renderPhotoGrid(photos) {
    var grid = document.getElementById('photoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    (photos || []).forEach(function (pid) {
      var wrap = document.createElement('div'); wrap.style.position = 'relative';
      var img = document.createElement('img'); img.className = 'photo-thumb';
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderPhotoGrid(photos); };
      img.style.cursor = 'pointer';
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div'); add.className = 'photo-add'; add.textContent = '＋'; add.title = '上传凭证照片';
    add.onclick = function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files);
        var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderPhotoGrid(photos); });
      };
      inp.click();
    };
    grid.appendChild(add);
  }

  /* ---------- 期间 ---------- */
  function setRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'month') { state.from = y + '-' + p(m + 1) + '-01'; state.to = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'quarter') { var q = Math.floor(m / 3) * 3; state.from = y + '-' + p(q + 1) + '-01'; state.to = y + '-' + p(q + 3) + '-' + new Date(y, q + 3, 0).getDate(); }
    else if (kind === 'year') { state.from = y + '-01-01'; state.to = y + '-12-31'; }
    else { state.from = ''; state.to = ''; }
    render();
  }

  /* ---------- 导出 CSV ---------- */
  function exportCsv() {
    var rows = filtered();
    if (!rows.length) { FW.toast('没有可导出的发票'); return; }
    var head = ['日期', '方向', '类型', '发票代码', '发票号码', '对方单位', '用途分类', '不含税金额', '税额', '价税合计', '抵扣状态', '备注'];
    var data = rows.map(function (t) {
      return [t.date, t.direction === 'in' ? '进项' : '销项', t.kind || '', t.code || '', t.number, t.party || '', t.category || '', t.amount, t.tax, t.total, t.direction === 'in' ? (t.deduction || '未勾选') : '', t.remark || ''];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '发票台账_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 张发票（CSV）');
  }

  // 暴露核心计算（便于自动化验证与未来复用）
  FW.invoiceCalc = { computeSummary: computeSummary };

  /* ============================================================
   * 合同台账（与发票台账共用模块，作为第 4 个 tab）
   *   - 记录合同编号 / 名称 / 对方单位 / 类型 / 签订·到期日 / 金额 / 付款方式 / 履行状态
   *   - 自动汇总：合同总数、合同总金额、各状态金额（履行中/已完成/已终止）
   *   - 到期提醒（履行中且到期日早于今天标红）
   *   - 支持期间筛选、状态筛选、关键词搜索、CSV 导出、合同照片附件
   * 数据键：contracts（按账本隔离，见 db.js）
   * ============================================================ */
  function contractsAll() { return FW.db.getList(CONTRACT_KEY).sort(function (a, b) { return (a.signDate < b.signDate ? 1 : a.signDate > b.signDate ? -1 : 0); }); }
  function isOverdue(t) {
    if (!t.dueDate) return false;
    if (t.status === '已完成' || t.status === '已终止') return false;
    return t.dueDate < FW.today();
  }
  function contractsFiltered(kw, from, to, status) {
    var rows = contractsAll();
    if (status) rows = rows.filter(function (t) { return (t.status || '待签订') === status; });
    if (from) rows = rows.filter(function (t) { return t.signDate >= from; });
    if (to) rows = rows.filter(function (t) { return t.signDate <= to; });
    if (kw) {
      var k = kw.toLowerCase();
      rows = rows.filter(function (t) {
        return [t.no, t.name, t.party, t.type, t.owner, t.remark].some(function (f) { return (f || '').toLowerCase().indexOf(k) >= 0; });
      });
    }
    return rows;
  }
  function contractSummary(rows) {
    var byStatus = {};
    STATUS_OPTS.forEach(function (st) { byStatus[st] = 0; });
    rows.forEach(function (t) { byStatus[t.status || '待签订'] = (byStatus[t.status || '待签订'] || 0) + num(t.amount); });
    var total = rows.reduce(function (a, t) { return a + num(t.amount); }, 0);
    return { count: rows.length, total: total, byStatus: byStatus };
  }

  function renderContractView() {
    var c = document.getElementById('content');
    var kw = state.ctKw || '', from = state.ctFrom || '', to = state.ctTo || '', status = state.ctStatus || '';
    var rows = contractsFiltered(kw, from, to, status);
    var s = contractSummary(contractsAll());
    var statusOpts = '<option value="">全部状态</option>' + STATUS_OPTS.map(function (d) { return '<option' + (status === d ? ' selected' : '') + '>' + d + '</option>'; }).join('');

    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">签订期间：</span>' +
        '<button class="btn ghost sm" data-r="cmonth">本月</button>' +
        '<button class="btn ghost sm" data-r="cyear">本年</button>' +
        '<button class="btn ghost sm" data-r="call">全部</button>' +
        '<div class="field"><input id="ctFrom" type="date" value="' + FW.esc(from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="ctTo" type="date" value="' + FW.esc(to) + '" title="结束日期"></div>' +
      '</div></div>' +
      '<div class="stat-row" id="ctSummary"></div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="field"><input id="ctKw" placeholder="搜索合同编号/名称/对方单位" value="' + FW.esc(kw) + '"></div>' +
          '<div class="field"><select id="ctStatus">' + statusOpts + '</select></div>' +
          '<button class="btn ghost sm" id="ctReset">重置</button>' +
        '</div>' +
        '<div id="ctWrap"></div>' +
      '</div>';

    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="ctPrint">🖨 打印</button><button class="btn ghost" id="ctCsv">⬇ 导出CSV</button><button class="btn" id="addCtBtn">＋ 新增合同</button>';
    document.getElementById('ctPrint').onclick = function () { window.print(); };
    document.getElementById('ctCsv').onclick = exportContractCsv;
    document.getElementById('addCtBtn').onclick = function () { openContractForm(null); };

    drawContractSummary(s);
    drawContractTable(rows);

    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setContractRange(b.dataset.r); }; });
    var cf = document.getElementById('ctFrom'), ct = document.getElementById('ctTo');
    if (cf) cf.onchange = function () { state.ctFrom = this.value; renderContractView(); };
    if (ct) ct.onchange = function () { state.ctTo = this.value; renderContractView(); };
    var ck = document.getElementById('ctKw'); if (ck) ck.oninput = function () { state.ctKw = this.value.trim(); drawContractTable(contractsFiltered(state.ctKw, state.ctFrom, state.ctTo, state.ctStatus)); };
    var cs = document.getElementById('ctStatus'); if (cs) cs.onchange = function () { state.ctStatus = this.value; drawContractTable(contractsFiltered(state.ctKw, state.ctFrom, state.ctTo, state.ctStatus)); };
    var cr = document.getElementById('ctReset'); if (cr) cr.onclick = function () { state.ctKw = ''; state.ctStatus = ''; state.ctFrom = ''; state.ctTo = ''; renderContractView(); };
  }

  function drawContractSummary(s) {
    var el = document.getElementById('ctSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="label">合同总数</div><div class="value">' + s.count + '</div><div class="sub">份</div></div>' +
      '<div class="stat"><div class="label">合同总金额</div><div class="value income">' + money(s.total) + '</div><div class="sub">所有状态合计</div></div>' +
      '<div class="stat"><div class="label">履行中金额</div><div class="value">' + money(s.byStatus['履行中'] || 0) + '</div><div class="sub">进行中</div></div>' +
      '<div class="stat"><div class="label">已完成金额</div><div class="value">' + money(s.byStatus['已完成'] || 0) + '</div><div class="sub">已结</div></div>' +
      '<div class="stat"><div class="label">已终止金额</div><div class="value expense">' + money(s.byStatus['已终止'] || 0) + '</div><div class="sub">中止/取消</div></div>';
  }

  function drawContractTable(rows) {
    var el = document.getElementById('ctWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的合同。点右上角「＋ 新增合同」登记第一份，或调整筛选条件。</div>';
      return;
    }
    var trs = rows.map(function (t) {
      var st = t.status || '待签订';
      var stCls = st === '已完成' ? 'ok' : (st === '已终止' ? 'neutral' : 'warn');
      var due = t.dueDate ? '<span class="' + (isOverdue(t) ? 'expense' : 'muted') + '">' + FW.esc(t.dueDate) + '</span>' : '<span class="muted">—</span>';
      var amt = '<span class="' + (num(t.amount) < 0 ? 'expense' : '') + '">' + money(t.amount) + '</span>';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.no || '') + '</td>' +
        '<td>' + FW.esc(t.name || '—') + (t.type ? '<div class="muted" style="font-size:11px">' + FW.esc(t.type) + '</div>' : '') + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td class="nowrap">' + FW.esc(t.signDate || '—') + '</td>' +
        '<td class="num">' + amt + '</td>' +
        '<td>' + (t.payMethod ? FW.esc(t.payMethod) : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="tag ' + stCls + '">' + FW.esc(st) + '</span></td>' +
        '<td class="nowrap">' + due + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        (function () { var c = (t.docFiles ? t.docFiles.length : 0) + (t.attachments ? t.attachments.length : 0) + (t.photos ? t.photos.length : 0); return '<td class="nowrap">' + (c ? '<button class="btn ghost sm" data-att="' + t.id + '">📎 ' + c + '</button>' : '<span class="muted">—</span>') + '</td>'; })() +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>合同编号</th><th>合同名称</th><th>对方单位</th><th>签订日期</th><th class="num">合同金额</th><th>付款方式</th><th>履行状态</th><th>到期日</th><th>备注</th><th>附件</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
    FW.qa('#ctWrap .row-edit').forEach(function (b) { b.onclick = function () { openContractForm(b.dataset.id); }; });
    FW.qa('#ctWrap .row-del').forEach(function (b) { b.onclick = function () { delContract(b.dataset.id); }; });
    FW.qa('#ctWrap [data-att]').forEach(function (b) { b.onclick = function () { openContractAttachments(b.dataset.att); }; });
  }

  /* ===== 合同文档解析与附件 ===== */
  function fileExt(name) { var i = (name || '').lastIndexOf('.'); return i >= 0 ? (name.slice(i + 1).toLowerCase()) : ''; }
  function fileToUint8(dataUrl) {
    var b64 = (dataUrl || '').split(',')[1] || '';
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function readAsArrayBuffer(file) {
    return new Promise(function (res) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { res(null); };
      r.readAsArrayBuffer(file);
    });
  }
  // 从上传文件提取纯文本；图片/不支持格式返回 ''
  function extractTextFromFile(file, dataUrl) {
    var ext = fileExt(file.name);
    if (ext === 'txt' || ext === 'text' || file.type === 'text/plain') {
      return new Promise(function (res) {
        var r = new FileReader();
        r.onload = function () { res(r.result); };
        r.onerror = function () { res(''); };
        r.readAsText(file, 'utf-8');
      });
    }
    if (ext === 'pdf') {
      if (!global.pdfjsLib) return Promise.resolve('');
      try {
        // 中文 PDF 多用 CID 嵌入字体，必须给 PDF.js 配上 CMap 才能正确取字
        // （无 CMap 时 getTextContent() 会返回空串/乱码，导致合同字段识别失败）
        var loadingTask = global.pdfjsLib.getDocument({
          data: fileToUint8(dataUrl),
          cMapUrl: 'js/vendor/cmaps/',
          cMapPacked: true,
          // 标准字体（Helvetica/Times 等）也走 CMap，统一指向同一目录
          standardFontDataUrl: 'js/vendor/standard_fonts/',
          isEvalSupported: false
        });
        return loadingTask.promise.then(function (pdf) {
          var tasks = [];
          for (var p = 1; p <= pdf.numPages; p++) {
            tasks.push(pdf.getPage(p).then(function (pg) {
              return pg.getTextContent().then(function (tc) {
                return tc.items.map(function (it) { return it.str || ''; }).join(' ');
              });
            }));
          }
          return Promise.all(tasks).then(function (arr) { return arr.join('\n'); });
        }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    if (ext === 'docx') {
      if (!global.mammoth) return Promise.resolve('');
      try {
        return readAsArrayBuffer(file).then(function (ab) {
          if (!ab) return '';
          return global.mammoth.extractRawText({ arrayBuffer: ab }).then(function (r) { return r.value || ''; }).catch(function () { return ''; });
        }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    if (ext === 'xlsx' || ext === 'xls') {
      if (!global.XLSX) return Promise.resolve('');
      try {
        return readAsArrayBuffer(file).then(function (ab) {
          if (!ab) return '';
          var wb = global.XLSX.read(ab, { type: 'array' });
          return wb.SheetNames.map(function (sn) { return global.XLSX.utils.sheet_to_csv(wb.Sheets[sn]); }).join('\n');
        }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    return Promise.resolve('');
  }
  function ymd(y, m, d) {
    return y + '-' + (+m < 10 ? '0' + (+m) : '' + (+m)) + '-' + (+d < 10 ? '0' + (+d) : '' + (+d));
  }
  function firstDateNear(text, kwRe) {
    var m = text.match(kwRe);
    if (m) {
      var near = text.slice(m.index, m.index + 80);
      var d = near.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
      if (d) return ymd(d[1], d[2], d[3]);
    }
    return '';
  }
  function firstDateInText(text) {
    var d = text.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    return d ? ymd(d[1], d[2], d[3]) : '';
  }
  function parseAmount(str) {
    if (!str) return 0;
    var m = ('' + str).match(/([\d][\d,]*\.?\d*)\s*(万|亿)?/);
    if (!m) return 0;
    var n = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(n)) return 0;
    if (m[2] === '万') n *= 10000;
    else if (m[2] === '亿') n *= 100000000;
    return n;
  }
  // 从合同文本提取关键字段（仅返回能识别到的项），fileName 用于兜底合同名称
  function extractContractFields(text, fileName) {
    text = text || '';
    var out = {};
    var noM = text.match(/(?:合同编号|合同号|编号|NO\.?|No\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_／/\u4e00-\u9fa5]{2,30})/i)
          || text.match(/(?:HT|合同)\s*[-_]\s*([A-Za-z0-9\-_／/]{3,30})/i);
    if (noM) out.no = noM[1].trim();
    var name = fileName ? fileName.replace(/\.[^.]+$/, '') : '';
    var nameM = text.match(/(?:项目名称|工程名称|协议名称|关于)\s*[:：]?\s*([^\n，,。；;]{2,40}?)(?:的|合同|协议)/);
    if (!name && nameM) name = nameM[1].trim();
    if (name) out.name = name;
    var partyM = text.match(/(?:甲方|乙方|供方|需方|卖方|买方|出租方|承租方|发包方|承包方|定作方|承揽方|委托方|受托方|采购方|销售方)\s*[:：]?\s*[（(]?\s*([^\n，,。；;）)]{2,40})/);
    if (partyM) out.party = partyM[1].trim();
    else { var compM = text.match(/([^\n，,。；;（）()]{2,30}?(?:有限公司|股份公司|公司|集团))/); if (compM) out.party = compM[1].trim(); }
    out.signDate = firstDateNear(text, /(?:签订|签署|订立|签约|日期)/) || firstDateInText(text);
    out.dueDate = firstDateNear(text, /(?:到期|终止|届满|完毕)/);
    var amtM = text.match(/(?:合同总价|合同总价款|总价|合同价款|合同金额|总金额|价款|金额)\s*[:：]?\s*(?:人民币|RMB|￥|¥)?\s*([\d][\d,]*\.?\d*)\s*(万|亿元|万元|元|万)?/i);
    if (amtM) out.amount = parseAmount(amtM[1] + (amtM[2] || ''));
    var payMap = ['一次性付款', '分期付款', '月结', '货到付款', '按进度付款', '先款后货', '年付', '季付', '月付'];
    for (var i = 0; i < payMap.length; i++) { if (text.indexOf(payMap[i]) >= 0) { out.payMethod = payMap[i]; break; } }
    var ownerM = text.match(/(?:负责人|经办人|联系人)\s*[:：]?\s*([^\n，,。；;]{2,10}?)(?:[，,。；;]|$)/);
    if (ownerM) out.owner = ownerM[1].trim();
    return out;
  }
  // 把识别到的字段回填到表单（不覆盖用户已填内容）
  function fillContractFields(ext) {
    var map = { no: 'c_no', name: 'c_name', party: 'c_party', signDate: 'c_sign', dueDate: 'c_due', amount: 'c_amt', payMethod: 'c_pay', owner: 'c_owner' };
    var filled = 0;
    Object.keys(ext).forEach(function (k) {
      var id = map[k]; if (!id) return;
      var el = document.getElementById(id); if (!el) return;
      if (k === 'payMethod') {
        if (!el.value) { el.value = ext.payMethod; filled++; }
        return;
      }
      if (!el.value) { el.value = ext[k]; filled++; }
    });
    return filled;
  }
  function fileIcon(type, ext) {
    if (ext === 'pdf') return '📕';
    if (ext === 'doc' || ext === 'docx') return '📘';
    if (ext === 'xls' || ext === 'xlsx') return '📗';
    if (ext === 'txt' || ext === 'text') return '📄';
    if ((type || '').indexOf('image/') === 0) return '🖼';
    return '📎';
  }
  function downloadFile(id, name) {
    FW.db.getPhoto(id).then(function (d) {
      if (!d) { FW.toast('文件已丢失'); return; }
      var a = document.createElement('a');
      a.href = d; a.download = name || 'file';
      document.body.appendChild(a); a.click();
      try { document.body.removeChild(a); } catch (e) {}
    }).catch(function () { FW.toast('文件读取失败'); });
  }
  function openFile(id, name) {
    FW.db.getPhoto(id).then(function (d) {
      if (!d) { FW.toast('文件已丢失'); return; }
      window.open(d, '_blank');
    }).catch(function () { FW.toast('文件读取失败'); });
  }
  // 渲染文件网格（合同正文文档 docFiles / 相关附件 attachments）；doExtract=true 时上传后自动解析提取字段
  function renderContractFileGrid(gridId, files, doExtract) {
    var grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    (files || []).forEach(function (f) {
      var ext = fileExt(f.name);
      var row = document.createElement('div'); row.className = 'ct-file';
      var sz = f.size ? (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(f.size / 1024)) + 'KB') : '';
      row.innerHTML = '<span class="ct-file-ic">' + fileIcon(f.type, ext) + '</span>' +
        '<span class="ct-file-name" title="' + FW.esc(f.name) + '">' + FW.esc(f.name) + '</span>' +
        '<span class="ct-file-sz muted">' + sz + '</span>' +
        '<span class="ct-file-act"><a href="#" data-act="open">预览</a><a href="#" data-act="dl">下载</a><a href="#" data-act="del">删除</a></span>';
      row.querySelector('[data-act="dl"]').onclick = function (e) { e.preventDefault(); downloadFile(f.id, f.name); };
      row.querySelector('[data-act="open"]').onclick = function (e) { e.preventDefault(); openFile(f.id, f.name); };
      row.querySelector('[data-act="del"]').onclick = function (e) {
        e.preventDefault();
        files.splice(files.indexOf(f), 1); FW.db.deletePhoto(f.id); renderContractFileGrid(gridId, files, doExtract);
      };
      grid.appendChild(row);
    });
    var add = document.createElement('div'); add.className = 'ct-file-add'; add.textContent = '＋ 上传';
    add.onclick = function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = doExtract ? '.pdf,.doc,.docx,.txt,.xlsx,.xls,image/*' : '*';
      inp.multiple = true;
      inp.onchange = function () {
        Array.prototype.slice.call(inp.files).forEach(function (file) {
          var reader = new FileReader();
          reader.onload = function () {
            FW.db.savePhoto(reader.result).then(function (fid) {
              var rec = { id: fid, name: file.name, type: file.type || '', size: file.size || 0 };
              files.push(rec);
              renderContractFileGrid(gridId, files, doExtract);
              if (doExtract) {
                extractTextFromFile(file, reader.result).then(function (txt) {
                  if (txt && txt.trim()) {
                    var ext = extractContractFields(txt, file.name);
                    var n = fillContractFields(ext);
                    if (n > 0) FW.toast('已从「' + file.name + '」识别并填入 ' + n + ' 项信息，请核对');
                  } else {
                    showOcrHint(file.name, gridId);
                  }
                });
              }
            });
          };
          reader.readAsDataURL(file);
        });
      };
      inp.click();
    };
      grid.appendChild(add);
  }

  // C方案：上传扫描件/图片 PDF 未取到文字层时的友好自救引导（不启用 OCR 引擎，纯静态零依赖）
  // 提示条插到附件网格下方（父容器兄弟节点），不会被 grid 重渲染冲掉，也不覆盖正在填的表单
  function showOcrHint(name, gridId) {
    var grid = document.getElementById(gridId);
    if (!grid || !grid.parentNode) return;
    var prev = grid.parentNode.querySelector('.ocr-hint');
    if (prev) prev.parentNode.removeChild(prev);
    var safeName = FW.esc(name || '该文件');
    var hint = document.createElement('div');
    hint.className = 'ocr-hint';
    hint.innerHTML =
      '<div class="ocr-hint-ic">⚠️</div>' +
      '<div class="ocr-hint-body">' +
        '<div class="ocr-hint-title">未识别到文字层：' + safeName + '</div>' +
        '<div class="ocr-hint-text">通常是 <b>图片版 / 扫描件 PDF</b> 或图片文件，系统无法直接读取合同内容。' +
        '可先用 <b>Edge / Chrome / Adobe / WPS</b> 打开 → 点「<b>识别文字 / 扫描和 OCR</b>」→ 另存为带文字层的 PDF → 重新上传即可自动提取；也可直接手动填写表单。</div>' +
      '</div>' +
      '<button class="ocr-hint-close" title="关闭">×</button>';
    hint.querySelector('.ocr-hint-close').onclick = function () { if (hint.parentNode) hint.parentNode.removeChild(hint); };
    grid.parentNode.insertBefore(hint, grid.nextSibling);
  }

  // 列表/详情查看某合同全部附件
  function openContractAttachments(id) {
    var rec = FW.db.getById(CONTRACT_KEY, id);
    if (!rec) return;
    var docs = rec.docFiles || [], atts = rec.attachments || [], photos = rec.photos || [];
    var all = docs.map(function (f) { return { f: f, tag: '正文文档' }; })
      .concat(atts.map(function (f) { return { f: f, tag: '相关附件' }; }))
      .concat(photos.map(function (fid) { return { f: { id: fid, name: '合同照片', type: 'image', size: 0 }, tag: '照片' }; }));
    if (!all.length) { FW.toast('该合同暂无附件'); return; }
    var rows = all.map(function (item) {
      var ext = fileExt(item.f.name);
      return '<div class="ct-file"><span class="ct-file-ic">' + fileIcon(item.f.type, ext) + '</span>' +
        '<span class="ct-file-tag">' + item.tag + '</span>' +
        '<span class="ct-file-name" title="' + FW.esc(item.f.name) + '">' + FW.esc(item.f.name) + '</span>' +
        '<span class="ct-file-act"><a href="#" data-act="open" data-id="' + item.f.id + '" data-name="' + FW.esc(item.f.name) + '">预览</a>' +
        '<a href="#" data-act="dl" data-id="' + item.f.id + '" data-name="' + FW.esc(item.f.name) + '">下载</a></span></div>';
    }).join('');
    var body = '<div id="ct-attach-list" class="ct-attach-list">' + rows + '</div>';
    FW.openModal('合同附件（' + all.length + '）', body, function () {
      FW.qa('#ct-attach-list .ct-file [data-act]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          if (a.dataset.act === 'dl') downloadFile(a.dataset.id, a.dataset.name);
          else openFile(a.dataset.id, a.dataset.name);
        };
      });
    });
  }

  function openContractForm(id) {
    var edit = id ? FW.db.getById(CONTRACT_KEY, id) : null;
    var v = {
      no: '', name: '', party: '', type: '采购合同',
      signDate: FW.today(), dueDate: '', amount: '',
      payMethod: '一次性付款', status: '履行中',
      owner: '', remark: '', photos: [], docFiles: [], attachments: []
    };
    if (edit) {
      v = {
        no: edit.no || '', name: edit.name || '', party: edit.party || '', type: edit.type || '采购合同',
        signDate: edit.signDate || FW.today(), dueDate: edit.dueDate || '', amount: edit.amount,
        payMethod: edit.payMethod || '一次性付款', status: edit.status || '履行中',
        owner: edit.owner || '', remark: edit.remark || '', photos: edit.photos || [],
        docFiles: edit.docFiles || [], attachments: edit.attachments || []
      };
    }
    state.ctPhotos = v.photos.slice();
    state.ctDocFiles = (v.docFiles || []).slice();
    state.ctAttachments = (v.attachments || []).slice();

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>合同编号</label><input id="c_no" value="' + FW.esc(v.no) + '" placeholder="合同编号（必填）"></div>' +
        '<div class="field"><label>合同名称</label><input id="c_name" value="' + FW.esc(v.name) + '" placeholder="如：XX采购合同"></div>' +
        '<div class="field full"><label>对方单位名称</label><input id="c_party" value="' + FW.esc(v.party) + '" placeholder="甲方 / 乙方单位"></div>' +
        '<div class="field"><label>合同类型</label><select id="c_type">' + CTYPE_OPTS.map(function (k) { return '<option ' + (k === v.type ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>签订日期</label><input id="c_sign" type="date" value="' + FW.esc(v.signDate) + '"></div>' +
        '<div class="field"><label>到期日</label><input id="c_due" type="date" value="' + FW.esc(v.dueDate) + '"></div>' +
        '<div class="field"><label>合同金额（元）</label><input id="c_amt" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
        '<div class="field"><label>付款方式</label><select id="c_pay">' + PAY_OPTS.map(function (k) { return '<option ' + (k === v.payMethod ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>履行状态</label><select id="c_status">' + STATUS_OPTS.map(function (k) { return '<option ' + (k === v.status ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>负责人</label><input id="c_owner" value="' + FW.esc(v.owner) + '" placeholder="选填"></div>' +
        '<div class="field full"><label>备注</label><textarea id="c_remark" rows="2" placeholder="主要条款 / 关联单据">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>合同 / 附件照片</label><div class="photo-grid" id="ctPhotoGrid"></div></div>' +
        '<div class="field full"><label>合同正文文档（自动识别提取关键信息）</label><div class="ct-file-grid" id="ctDocGrid"></div><div class="muted" style="font-size:12px;margin-top:4px">支持 PDF / Word / Excel / 文本，上传后立即提取合同编号、对方单位、金额、签订/到期日期等并填入下方表单，请核对。</div></div>' +
        '<div class="field full"><label>相关附件（发票 / 图纸 / 其他）</label><div class="ct-file-grid" id="ctAttGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="ctCancel">取消</button><button class="btn" id="ctSave">保存</button></div>';

    FW.openModal(edit ? '编辑合同' : '新增合同', body, function () {
      renderContractPhotoGrid(state.ctPhotos);
      renderContractFileGrid('ctDocGrid', state.ctDocFiles, true);
      renderContractFileGrid('ctAttGrid', state.ctAttachments, false);
      document.getElementById('ctCancel').onclick = FW.closeModal;
      document.getElementById('ctSave').onclick = function () {
        var no = document.getElementById('c_no').value.trim();
        if (!no) { FW.toast('请填写合同编号'); return; }
        var amount = num(document.getElementById('c_amt').value);
        if (!(amount >= 0)) { FW.toast('合同金额不能为负'); return; }
        var rec = {
          id: edit ? edit.id : FW.db.uid('ct_'),
          no: no,
          name: document.getElementById('c_name').value.trim(),
          party: document.getElementById('c_party').value.trim(),
          type: document.getElementById('c_type').value,
          signDate: document.getElementById('c_sign').value || FW.today(),
          dueDate: document.getElementById('c_due').value || '',
          amount: amount,
          payMethod: document.getElementById('c_pay').value,
          status: document.getElementById('c_status').value,
          owner: document.getElementById('c_owner').value.trim(),
          remark: document.getElementById('c_remark').value.trim(),
          photos: state.ctPhotos,
          docFiles: state.ctDocFiles,
          attachments: state.ctAttachments
        };
        FW.db.upsert(CONTRACT_KEY, rec);
        FW.closeModal(); renderContractView(); FW.toast('已保存');
      };
    });
  }

  function delContract(id) {
    var rec = FW.db.getById(CONTRACT_KEY, id);
    if (!rec) return;
    var cnt = (rec.photos ? rec.photos.length : 0) + (rec.docFiles ? rec.docFiles.length : 0) + (rec.attachments ? rec.attachments.length : 0);
    if (!confirm('确定删除该合同？' + (cnt ? '（将同时删除 ' + cnt + ' 个附件）' : ''))) return;
    FW.db.remove(CONTRACT_KEY, id);
    var ids = (rec.photos || []).concat((rec.docFiles || []).map(function (f) { return f.id; })).concat((rec.attachments || []).map(function (f) { return f.id; }));
    if (ids.length) FW.db.deletePhotos(ids);
    renderContractView(); FW.toast('已删除');
  }

  function renderContractPhotoGrid(photos) {
    var grid = document.getElementById('ctPhotoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    (photos || []).forEach(function (pid) {
      var wrap = document.createElement('div'); wrap.style.position = 'relative';
      var img = document.createElement('img'); img.className = 'photo-thumb';
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderContractPhotoGrid(photos); };
      img.style.cursor = 'pointer';
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div'); add.className = 'photo-add'; add.textContent = '＋'; add.title = '上传合同照片/附件';
    add.onclick = function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files);
        var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderContractPhotoGrid(photos); });
      };
      inp.click();
    };
    grid.appendChild(add);
  }

  function setContractRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'cmonth') { state.ctFrom = y + '-' + p(m + 1) + '-01'; state.ctTo = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'cyear') { state.ctFrom = y + '-01-01'; state.ctTo = y + '-12-31'; }
    else { state.ctFrom = ''; state.ctTo = ''; }
    renderContractView();
  }

  function exportContractCsv() {
    var rows = contractsFiltered(state.ctKw, state.ctFrom, state.ctTo, state.ctStatus);
    if (!rows.length) { FW.toast('没有可导出的合同'); return; }
    var head = ['合同编号', '合同名称', '对方单位', '合同类型', '签订日期', '到期日', '合同金额', '付款方式', '履行状态', '负责人', '备注', '附件数'];
    var data = rows.map(function (t) {
      var attCnt = (t.docFiles ? t.docFiles.length : 0) + (t.attachments ? t.attachments.length : 0) + (t.photos ? t.photos.length : 0);
      return [t.no, t.name || '', t.party || '', t.type || '', t.signDate || '', t.dueDate || '', t.amount, t.payMethod || '', t.status || '待签订', t.owner || '', t.remark || '', attCnt];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '合同台账_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 份合同（CSV）');
  }

  FW.contractCalc = { contractSummary: contractSummary, extractContractFields: extractContractFields };

  /* ============================================================
   * 库存台账（采购 / 入库 / 出库 / 退货）
   *   - 记录商品/物料的出入库与退货流水：日期/单号/名称/规格/单位/类型/数量/单价/金额/往来单位/仓库
   *   - 类型含方向：入库方向(in) 采购入库·其他入库·销售退货；出库方向(out) 销售出库·其他出库·采购退货
   *   - 自动汇总：入库合计(数量/金额)、出库合计、退货合计(采购+销售退货)、库存结存(数量=入-出)
   *   - 支持期间筛选、类型筛选、关键词搜索、CSV 导出、单据照片
   * 数据键：stock（按账本隔离，见 db.js）
   * ============================================================ */
  function stockAll() { return FW.db.getList(STOCK_KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }); }
  function stockFiltered(kw, from, to, type) {
    var rows = stockAll();
    if (type) rows = rows.filter(function (t) { return t.type === type; });
    if (from) rows = rows.filter(function (t) { return t.date >= from; });
    if (to) rows = rows.filter(function (t) { return t.date <= to; });
    if (kw) {
      var k = kw.toLowerCase();
      rows = rows.filter(function (t) {
        return [t.no, t.item, normItem(t.item), t.spec, t.unit, t.type, t.party, t.warehouse, t.remark, t.period].some(function (f) { return (f || '').toLowerCase().indexOf(k) >= 0; });
      });
    }
    return rows;
  }
  // 口径：调货入库不含退货；退货单独按净额统计（销售退货 +，采购退货 −）；结存 = 调货 − 出库 + 退货
  function stockSummary(rows) {
    var inQ = 0, inA = 0, outQ = 0, outA = 0, retQ = 0, retA = 0;
    rows.forEach(function (t) {
      var q = num(t.qty), a = num(t.amount);
      if (isReturnType(t.type)) {
        var sg = retSign(t.type);
        retQ += q * sg; retA += a * sg;
      } else if (stockDir(t.type) === 'in') { inQ += q; inA += a; } else { outQ += q; outA += a; }
    });
    return { inQ: inQ, inA: inA, outQ: outQ, outA: outA, retQ: retQ, retA: retA, balance: inQ - outQ + retQ };
  }

  /* ---------- 按营期汇总：营期 → 产品（调货/退货/结存）+ 按发货日期下钻 ---------- */
  // 退货方向：销售退货（客户退回，dir in）记正数；采购退货（退给上游，dir out）记负数
  function isReturnType(type) { return type === '销售退货' || type === '采购退货'; }
  function retSign(type) { return type === '采购退货' ? -1 : 1; }

  // 返回 [{period, items:[{item,unit,inQ,inA,outQ,outA,retQ,retA,balQ,byDate:[...]}], tot:{...}}]
  function periodAgg(rows) {
    var NO_PERIOD = '未填营期';
    var map = {}, order = [];
    rows.forEach(function (t) {
      var p = String(t.period || '').trim() || NO_PERIOD;
      if (!map[p]) { map[p] = { period: p, items: {}, iorder: [], dates: {} }; order.push(p); }
      var g = map[p];
      var item = normItem(String(t.item || '—').trim()) || '—';
      var unit = String(t.unit || '').trim();
      var key = item + '||' + unit;
      var q = num(t.qty), a = num(t.amount);
      var d = t.date || '';
      var isRet = isReturnType(t.type);
      if (!g.items[key]) {
        g.items[key] = { item: item, unit: unit, inQ: 0, inA: 0, outQ: 0, outA: 0, retQ: 0, retA: 0, retOff: 0, balQ: 0, byDate: {}, dorder: [] };
        g.iorder.push(key);
      }
      var it = g.items[key];
      if (!it.byDate[d]) { it.byDate[d] = { date: d, inQ: 0, outQ: 0, retQ: 0, balQ: 0 }; it.dorder.push(d); }
      var bd = it.byDate[d];
      if (isRet) {
        // 退货独立统计，不再混入「调货数量」
        var sg = retSign(t.type);
        it.retQ += q * sg; it.retA += a * sg; bd.retQ += q * sg;
        // 成本冲减额：不论方向都按金额绝对值累加（客户退回 / 退给上游，同样冲减进货成本）
        it.retOff += Math.abs(a);
      } else if (stockDir(t.type) === 'in') {
        it.inQ += q; it.inA += a; bd.inQ += q;
      } else {
        it.outQ += q; it.outA += a; bd.outQ += q;
      }
      it.balQ = it.inQ - it.outQ + it.retQ;
      bd.balQ = bd.inQ - bd.outQ + bd.retQ;
      g.dates[d] = 1;
    });
    return order.map(function (p) {
      var g = map[p];
      var items = g.iorder.map(function (k) {
        var it = g.items[k];
        it.byDateList = it.dorder.slice().sort().map(function (d) { return it.byDate[d]; });
        return it;
      });
      var tot = items.reduce(function (s, it) {
        s.inQ += it.inQ; s.inA += it.inA; s.outQ += it.outQ; s.outA += it.outA;
        s.retQ += it.retQ; s.retA += it.retA; s.retOff += (it.retOff || 0); s.balQ += it.balQ; return s;
      }, { inQ: 0, inA: 0, outQ: 0, outA: 0, retQ: 0, retA: 0, retOff: 0, balQ: 0 });
      var dates = Object.keys(g.dates).sort();
      return { period: p, items: items, tot: tot, dateFrom: dates[0] || '', dateTo: dates[dates.length - 1] || '' };
    });
  }

  /* ---------- 产品名归一设置弹窗 ---------- */
  function openAliasManager() {
    var items = stockItemNames();
    if (!items.length) { FW.toast('还没有库存单据，先登记或粘贴调货单'); return; }
    var opts = items.map(function (x) { return x.name; });
    Object.keys(loadAlias()).forEach(function (k) { var v = loadAlias()[k]; if (opts.indexOf(v) < 0) opts.push(v); });

    function selHtml(name, mapped) {
      return '<select class="al-sel" data-alias="' + FW.esc(name) + '">' +
        '<option value="">（不归并）</option>' +
        opts.filter(function (o) { return o !== name; }).map(function (o) {
          return '<option value="' + FW.esc(o) + '"' + (mapped === o ? ' selected' : '') + '>' + FW.esc(o) + '</option>';
        }).join('') + '</select>';
    }
    function tableHtml() {
      var a = loadAlias();
      return items.map(function (x) {
        var mapped = a[x.name] || '';
        return '<tr' + (mapped ? ' class="al-mapped"' : '') + '>' +
          '<td>' + FW.esc(x.name) + (mapped ? '<span class="al-arrow">→ ' + FW.esc(mapped) + '</span>' : ' <span class="al-std">标准名</span>') + '</td>' +
          '<td class="num muted">' + x.count + '</td>' +
          '<td>' + selHtml(x.name, mapped) + '</td></tr>';
      }).join('');
    }

    var body =
      '<div class="al-tip">同一件货写法不同（如「能量套」与「赫娇七彩时光焕颜能量套」）会在汇总里分成两行、均价算歪。' +
      '把短名<b>归并为</b>标准名后，汇总 / 均价 / 结存 / 项目核算下钻立即合并计算，<b>原始单据文字不会被改动</b>。</div>' +
      '<div class="toolbar" style="margin:10px 0">' +
        '<button class="btn ghost sm" id="alAuto">🔍 自动检测相似名</button>' +
        '<button class="btn ghost sm" id="alRewrite">✏ 批量改写历史单据</button>' +
        '<button class="btn danger sm" id="alClear">清空全部</button>' +
      '</div>' +
      '<div id="alSuspect"></div>' +
      '<div style="max-height:44vh;overflow:auto"><table class="al-table"><thead><tr>' +
        '<th>产品名（库存中出现过）</th><th class="num">单据数</th><th>归并为</th>' +
      '</tr></thead><tbody id="alBody">' + tableHtml() + '</tbody></table></div>' +
      '<div class="al-foot muted">改完点「保存」，所有汇总立即按新口径重算。「批量改写」会把历史单据里的别名直接改成标准名，不可自动撤销。</div>' +
      '<div class="form-actions"><button class="btn ghost" id="al_cancel">取消</button><button class="btn" id="al_save">保存</button></div>';

    FW.openModal('产品名归一（' + items.length + ' 个产品名）', body, function () {
      var m = document.querySelector('.modal'); if (m) m.classList.add('modal-wide');
      function refresh() { var el = document.getElementById('alBody'); if (el) el.innerHTML = tableHtml(); bindSel(); }
      function bindSel() {
        FW.qa('#alBody .al-sel').forEach(function (s) {
          s.onchange = function () {
            var from = s.getAttribute('data-alias'), to = s.value;
            var a = loadAlias();
            if (to) a[from] = to; else delete a[from];
            // 别人若指向 from，一并改指到 to，避免断链
            if (to) Object.keys(a).forEach(function (k) { if (a[k] === from) a[k] = to; });
            saveAlias(a); refresh();
          };
        });
      }
      function drawSuspect() {
        var ps = suspectPairs(), el = document.getElementById('alSuspect');
        if (!el) return;
        if (!ps.length) { el.innerHTML = ''; return; }
        el.innerHTML = '<div class="al-susp"><div class="al-susp-h">疑似同名（自动检测没敢合并，请你判断）</div>' +
          ps.map(function (p, i) {
            return '<div class="al-susp-row"><span>' + FW.esc(p.a) + '</span><span class="muted">≈</span>' +
              '<span>' + FW.esc(p.b) + '</span>' +
              '<button class="btn ghost sm" data-merge="' + i + '">合并</button></div>';
          }).join('') + '</div>';
        FW.qa('#alSuspect [data-merge]').forEach(function (b) {
          b.onclick = function () {
            var p = ps[+b.getAttribute('data-merge')];
            if (!p) return;
            var std = p.a.length >= p.b.length ? p.a : p.b;
            var other = (std === p.a) ? p.b : p.a;
            var a = loadAlias();
            a[other] = std;
            Object.keys(a).forEach(function (k) { if (a[k] === other) a[k] = std; });
            saveAlias(a);
            FW.toast('「' + other + '」→「' + std + '」，记得点保存');
            drawSuspect(); refresh();
          };
        });
      }
      bindSel(); drawSuspect();

      var au = document.getElementById('alAuto');
      if (au) au.onclick = function () {
        var sug = suggestAlias(), ks = Object.keys(sug);
        if (!ks.length) { FW.toast('没检测到相似的写法'); return; }
        var a = loadAlias();
        ks.forEach(function (k) { a[k] = sug[k]; });
        saveAlias(a); refresh(); drawSuspect();
        FW.toast('检测到 ' + ks.length + ' 组相似写法，已填入，确认后点保存');
      };
      var cl = document.getElementById('alClear');
      if (cl) cl.onclick = function () {
        if (!Object.keys(loadAlias()).length) { FW.toast('当前没有别名设置'); return; }
        if (!confirm('确定清空全部产品名归一设置？\n（只清规则，历史单据文字不受影响）')) return;
        saveAlias({}); refresh(); drawSuspect();
        FW.toast('已清空');
      };
      var rw = document.getElementById('alRewrite');
      if (rw) rw.onclick = function () {
        var a = loadAlias();
        if (!Object.keys(a).length) { FW.toast('当前没有别名设置，无需改写'); return; }
        if (!confirm('将把历史单据里的别名直接改成标准名（' + Object.keys(a).length + ' 条规则）。\n' +
          '此操作会修改原始记录文字，不能自动撤销。确定继续？')) return;
        var n = rewriteItemNames();
        FW.toast(n ? ('已改写 ' + n + ' 条单据的产品名') : '没有需要改写的单据');
        if (n) { FW.closeModal(); renderStockView(); }
      };
      var ac = document.getElementById('al_cancel');
      if (ac) ac.onclick = function () { FW.closeModal(); };
      var as = document.getElementById('al_save');
      if (as) as.onclick = function () {
        var a = loadAlias();
        Object.keys(a).forEach(function (k) {
          var v = String(a[k] == null ? '' : a[k]).trim();
          if (!v || v === k) delete a[k];
        });
        saveAlias(a);
        FW.closeModal();
        renderStockView();
        FW.toast('产品名归一已保存，汇总已按新口径重算');
      };
    });
  }

  function renderStockView() {
    var c = document.getElementById('content');
    var kw = state.stKw || '', from = state.stFrom || '', to = state.stTo || '', type = state.stType || '';
    var rows = stockFiltered(kw, from, to, type);
    var s = stockSummary(stockAll());
    var typeOpts = '<option value="">全部类型</option>' + STOCK_TYPES.map(function (t) { return '<option' + (type === t.label ? ' selected' : '') + '>' + t.label + '</option>'; }).join('');

    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">业务期间：</span>' +
        '<button class="btn ghost sm" data-r="smonth">本月</button>' +
        '<button class="btn ghost sm" data-r="syear">本年</button>' +
        '<button class="btn ghost sm" data-r="sall">全部</button>' +
        '<div class="field"><input id="stFrom" type="date" value="' + FW.esc(from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="stTo" type="date" value="' + FW.esc(to) + '" title="结束日期"></div>' +
      '</div></div>' +
      '<div class="stat-row" id="stSummary"></div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<button class="btn ' + (state.stView === 'detail' ? '' : 'ghost ') + 'sm" data-v="detail">单据明细</button>' +
          '<button class="btn ' + (state.stView === 'period' ? '' : 'ghost ') + 'sm" data-v="period">按营期汇总</button>' +
          '<button class="btn ' + (state.stView === 'settle' ? '' : 'ghost ') + 'sm" data-v="settle">结算对账（半月）</button>' +
          '<span style="width:10px"></span>' +
          '<div class="field"><input id="stKw" placeholder="搜索名称/单号/往来单位" value="' + FW.esc(kw) + '"></div>' +
          '<div class="field"><select id="stType">' + typeOpts + '</select></div>' +
          '<button class="btn ghost sm" id="stReset">重置</button>' +
        '</div>' +
        '<div id="stWrap"></div>' +
      '</div>';

    var ta = document.getElementById('topActions');
    var lg = loadLastGen();
    ta.innerHTML = '<button class="btn ghost" id="stPrint">🖨 打印</button><button class="btn ghost" id="stCsv">⬇ 导出CSV</button><button class="btn ghost" id="stImg">🖼 导出图片</button><button class="btn ghost" id="stPaste">📋 粘贴调货单</button>' +
      '<button class="btn ghost" id="stReturn" title="快捷登记客户退回的货">↩ 登记退货</button>' +
      '<button class="btn ghost" id="stAlias" title="把「能量套」这类简写归到全名，避免汇总里拆成两行">🏷 产品名</button>' +
      (lg ? '<button class="btn ghost" id="stUndo" title="撤销最近一次「粘贴调货单」生成的记录">↩ 撤销上次生成（' + lg.count + ' 条）</button>' : '') +
      '<button class="btn" id="addStBtn">＋ 新增单据</button>';
    document.getElementById('stPrint').onclick = function () { window.print(); };
    document.getElementById('stCsv').onclick = function () {
      if (state.stView === 'period') exportStockPeriodCsv();
      else if (state.stView === 'settle') exportStockSettleCsv();
      else exportStockCsv();
    };
    var si = document.getElementById('stImg');
    if (si) si.onclick = function () {
      if (state.stView === 'period') exportStockPeriodImg();
      else FW.toast('请先切到「按营期汇总」再导出图片');
    };
    document.getElementById('stPaste').onclick = function () { openTransferPaste(); };
    var sr2 = document.getElementById('stReturn');
    if (sr2) sr2.onclick = openReturnForm;
    var sa2 = document.getElementById('stAlias');
    if (sa2) sa2.onclick = openAliasManager;
    document.getElementById('addStBtn').onclick = function () { openStockForm(null); };
    var su = document.getElementById('stUndo');
    if (su) su.onclick = undoStockLastGen;

    if (state.stView === 'period') {
      drawStockSummary(stockSummary(rows));
      drawStockPeriodView(rows);
    } else if (state.stView === 'settle') {
      drawStockSummary(stockSummary(rows));
      drawStockSettleView(rows);
    } else {
      drawStockSummary(s);
      drawStockTable(rows);
    }

    FW.qa('#content [data-v]').forEach(function (b) {
      b.onclick = function () { state.stView = b.dataset.v; renderStockView(); };
    });
    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setStockRange(b.dataset.r); }; });
    var sf = document.getElementById('stFrom'), st = document.getElementById('stTo');
    if (sf) sf.onchange = function () { state.stFrom = this.value; renderStockView(); };
    if (st) st.onchange = function () { state.stTo = this.value; renderStockView(); };
    var sk = document.getElementById('stKw'); if (sk) sk.oninput = function () { state.stKw = this.value.trim(); renderStockList(); };
    var sp = document.getElementById('stType'); if (sp) sp.onchange = function () { state.stType = this.value; renderStockList(); };
    var sr = document.getElementById('stReset'); if (sr) sr.onclick = function () { state.stKw = ''; state.stType = ''; state.stFrom = ''; state.stTo = ''; renderStockView(); };
  }

  function drawStockSummary(s) {
    var el = document.getElementById('stSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="label">调货入库</div><div class="value income">' + s.inQ + ' 件</div><div class="sub">金额 ' + money(s.inA) + '</div></div>' +
      '<div class="stat"><div class="label">出库合计</div><div class="value expense">' + s.outQ + ' 件</div><div class="sub">金额 ' + money(s.outA) + '</div></div>' +
      '<div class="stat"><div class="label">退货（净）</div><div class="value ' + (s.retQ > 0 ? 'expense' : '') + '">' + s.retQ + ' 件</div><div class="sub">金额 ' + money(s.retA) + '</div></div>' +
      '<div class="stat"><div class="label">库存结存（数量）</div><div class="value">' + s.balance + ' 件</div><div class="sub">调货 − 出库 + 退货</div></div>';
  }

  function drawStockTable(rows) {
    var el = document.getElementById('stWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的单据。点右上角「＋ 新增单据」登记第一笔，或调整筛选条件。</div>';
      return;
    }
    var trs = rows.map(function (t) {
      var dir = stockDir(t.type);
      var dirTag = dir === 'in' ? '<span class="tag ok">入</span>' : '<span class="tag warn">出</span>';
      var qtyCls = dir === 'in' ? 'income' : 'expense';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date || '') + '</td>' +
        '<td>' + FW.esc(t.no || '') + '</td>' +
        '<td>' + FW.esc(t.item || '—') + aliasTip(t.item) + (t.spec ? '<div class="muted" style="font-size:11px">' + FW.esc(t.spec) + '</div>' : '') + (t.period ? '<div class="muted" style="font-size:11px">营期：' + FW.esc(t.period) + '</div>' : '') + '</td>' +
        '<td>' + (t.unit ? FW.esc(t.unit) : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="tag">' + FW.esc(t.type || '—') + '</span> ' + dirTag + '</td>' +
        '<td class="num ' + qtyCls + '">' + (dir === 'in' ? '' : '−') + num(t.qty) + '</td>' +
        '<td class="num">' + money(t.price) + '</td>' +
        '<td class="num">' + money(t.amount) + '</td>' +
        '<td>' + (t.party ? FW.esc(t.party) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (t.warehouse ? FW.esc(t.warehouse) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>日期</th><th>单号</th><th>商品/物料</th><th>单位</th><th>类型</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th>往来单位</th><th>仓库</th><th>备注</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
    FW.qa('#stWrap .row-edit').forEach(function (b) { b.onclick = function () { openStockForm(b.dataset.id); }; });
    FW.qa('#stWrap .row-del').forEach(function (b) { b.onclick = function () { delStock(b.dataset.id); }; });
  }

  /* 粘贴调货单：解析 → 预览（可改数量/单价）→ 一次性生成入库+出库 */
  // 局部重绘列表（搜索/类型切换/展开折叠时用）
  function renderStockList() {
    var rows = stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType);
    if (state.stView === 'period') {
      drawStockSummary(stockSummary(rows));
      drawStockPeriodView(rows);
    } else if (state.stView === 'settle') {
      drawStockSummary(stockSummary(rows));
      drawStockSettleView(rows);
    } else {
      drawStockTable(rows);
    }
  }

  // 按营期汇总视图：营期 → 产品（调货数量/均价/金额/结存），点产品行可展开按发货日期明细
  function drawStockPeriodView(rows) {
    var el = document.getElementById('stWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的单据。点右上角「📋 粘贴调货单」或「＋ 新增单据」登记，或调整筛选条件。</div>';
      return;
    }
    var groups = periodAgg(rows);
    var html = groups.map(function (g, gi) {
      var trs = g.items.map(function (it, ii) {
        var key = g.period + '|' + it.item;
        var open = !!state.stPeriodOpen[key];
        var canToggle = it.byDateList.length > 1;
        var avg = it.inQ > 0 ? (it.inA / it.inQ) : 0;
        var hasRet = Math.abs(it.retQ) > 0.000001;
        var main = '<tr class="per-item' + (canToggle ? ' toggleable' : '') + '" data-g="' + gi + '" data-i="' + ii + '">' +
          '<td>' + (canToggle ? '<span class="per-toggle">' + (open ? '▾' : '▸') + '</span> ' : '') + FW.esc(it.item) + '</td>' +
          '<td>' + (it.unit ? FW.esc(it.unit) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num income"><b>' + num(it.inQ) + '</b></td>' +
          '<td class="num">' + (it.inQ > 0 ? money(avg) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num">' + money(it.inA) + '</td>' +
          '<td class="num ' + (hasRet ? 'ret-val clickable-amt' : 'muted') + '"' + (hasRet ? ' data-ret="' + FW.esc(g.period) + '||' + FW.esc(it.item) + '" title="点击查看退货明细"' : '') + '>' + (hasRet ? num(it.retQ) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num ' + (hasRet ? 'expense' : 'muted') + '">' + (hasRet ? money(it.retA) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num ' + (it.balQ === 0 ? 'muted' : (it.balQ > 0 ? 'income' : 'expense')) + '">' + num(it.balQ) + '</td>' +
          '</tr>';
        if (open && canToggle) {
          main += it.byDateList.map(function (bd) {
            var bRet = Math.abs(bd.retQ) > 0.000001;
            return '<tr class="per-date">' +
              '<td style="padding-left:26px">' + FW.esc(bd.date || '未填日期') + '</td>' +
              '<td></td>' +
              '<td class="num income">' + num(bd.inQ) + '</td>' +
              '<td class="num muted">—</td>' +
              '<td class="num muted">—</td>' +
              '<td class="num ' + (bRet ? 'expense' : 'muted') + '">' + (bRet ? num(bd.retQ) : '—') + '</td>' +
              '<td class="num muted">—</td>' +
              '<td class="num">' + num(bd.balQ) + '</td>' +
              '</tr>';
          }).join('');
        }
        return main;
      }).join('');
      var tq = g.tot.inQ, ta = g.tot.inA, tb = g.tot.balQ, tr = g.tot.retQ, tra = g.tot.retA;
      var tot = '<tr class="per-total"><td><b>小计</b></td><td></td>' +
        '<td class="num"><b>' + num(tq) + '</b></td><td class="num"></td>' +
        '<td class="num"><b>' + money(ta) + '</b></td>' +
        '<td class="num ' + (Math.abs(tr) > 0.000001 ? 'expense' : 'muted') + '"><b>' + num(tr) + '</b></td>' +
        '<td class="num expense"><b>' + money(tra) + '</b></td>' +
        '<td class="num"><b>' + num(tb) + '</b></td></tr>';
      var span = g.dateFrom ? (g.dateFrom === g.dateTo ? FW.esc(g.dateFrom) : FW.esc(g.dateFrom) + ' ~ ' + FW.esc(g.dateTo)) : '';
      var retTip = Math.abs(tr) > 0.000001 ? '<span class="per-ret-badge">退货 ' + num(tr) + ' · ' + money(tra) + '</span>' : '';
      var netAmt = periodNet(g);
      var pushHtml =
        '<span class="per-net-badge" title="调货金额 − 退货金额，自动计入项目核算（分类：采购成本）">净额 ' + money(netAmt) + '</span>' +
        (g.period === '未填营期'
          ? '<span class="per-push-badge warn" title="未填营期的单据不会计入项目核算">未填营期 · 不计入</span>'
          : '<span class="per-push-badge" title="营期名即项目名，已自动计入项目核算的流水成本（分类：采购成本），内账流水不重复写入">✓ 自动计入项目核算</span>');
      return '<div class="per-card">' +
        '<div class="per-head"><b>' + FW.esc(g.period) + '</b>' +
        '<span class="muted" style="font-size:12px">' + span + (span ? ' · ' : '') + g.items.length + ' 种产品</span>' + retTip + pushHtml + '</div>' +
        '<table><thead><tr><th>产品</th><th>单位</th><th class="num">调货数量</th><th class="num">均价</th><th class="num">金额</th><th class="num">退货数量</th><th class="num">退货金额</th><th class="num">结存</th></tr></thead><tbody>' +
        trs + tot + '</tbody></table>' +
        '<div class="per-foot muted">调货数量 = 采购入库（不含退货） ；结存 = 调货 − 出库 + 退货 ；净额 = 调货金额 − 退货金额，已自动计入项目核算「<b>' + FW.esc(g.period) + '</b>」的流水成本（分类：采购成本）</div>' +
        '</div>';
    }).join('');
    el.innerHTML = html;
    FW.qa('#stWrap .per-item.toggleable').forEach(function (tr) {
      tr.onclick = function () {
        var g = groups[+this.dataset.g]; if (!g) return;
        var it = g.items[+this.dataset.i]; if (!it) return;
        var key = g.period + '|' + it.item;
        state.stPeriodOpen[key] = !state.stPeriodOpen[key];
        renderStockList();
      };
    });
    FW.qa('#stWrap [data-ret]').forEach(function (td) {
      td.onclick = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var v = this.getAttribute('data-ret') || '';
        var idx = v.indexOf('||');
        if (idx < 0) return;
        openReturnDetail(v.slice(0, idx), v.slice(idx + 2));
      };
    });
  }

  // 某营期某产品的退货明细（点汇总表的退货数字打开）
  function openReturnDetail(period, item) {
    var rows = (FW.db.getList(STOCK_KEY) || []).filter(function (t) {
      return isReturnType(t.type) &&
        normItem(String(t.item || '').trim()) === String(item || '').trim() &&
        String(t.period || '').trim() === String(period || '').trim();
    }).sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
    if (!rows.length) { FW.toast('没有找到该产品的退货记录'); return; }
    var tq = 0, ta = 0;
    var trs = rows.map(function (t) {
      var q = num(t.qty), a = num(t.amount), sg = retSign(t.type);
      tq += q * sg; ta += a * sg;
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date || '') + '</td>' +
        '<td><span class="tag ' + (t.type === '销售退货' ? 'ok' : 'warn') + '">' + FW.esc(t.type) + '</span></td>' +
        '<td class="num">' + (sg > 0 ? '+' : '−') + num(q) + '</td>' +
        '<td>' + (t.unit ? FW.esc(t.unit) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + money(t.price) + '</td>' +
        '<td class="num ' + (sg > 0 ? 'expense' : 'income') + '">' + (sg > 0 ? '−' : '+') + money(a) + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td>' + FW.esc(t.remark || '—') + '</td>' +
        '</tr>';
    }).join('');
    var body =
      '<div class="pc-pd-kpis">' +
        '<div class="kpi"><div class="l">净退货数量</div><div class="v expense">' + num(tq) + '</div></div>' +
        '<div class="kpi"><div class="l">应抵扣金额</div><div class="v expense">' + money(ta) + '</div></div>' +
        '<div class="kpi"><div class="l">退货笔数</div><div class="v">' + rows.length + '</div></div>' +
      '</div>' +
      '<div style="max-height:52vh;overflow:auto"><table class="pc-unclass-table"><thead><tr>' +
      '<th>日期</th><th>类型</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th><th>往来单位</th><th>摘要</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table></div>' +
      '<div class="form-actions"><button class="btn ghost" id="rd_close">关闭</button></div>';
    FW.openModal('退货明细 · ' + FW.esc(item) + '（' + FW.esc(period) + '）', body, function () {
      var b = document.getElementById('rd_close');
      if (b) b.onclick = function () { FW.closeModal(); };
    });
  }

  /* ---------- 营期净额（调货 − 退货）→ 自动计入项目核算 ---------- */
  // 净额 = 调货金额 − 退货冲减（退货不论方向，都是冲减进货成本，故取绝对值）
  // 营期名 = 项目名，由 js/project_cost.js 直接读取库存台账自动计入「采购成本」，不写内账流水
  function periodRetOff(g) { return (g.tot && g.tot.retOff != null) ? num(g.tot.retOff) : Math.abs(num(g.tot.retA)); }
  function periodNet(g) { return num(g.tot.inA) - periodRetOff(g); }

  // 导出按营期汇总（CSV）
  function exportStockPeriodCsv() {
    var rows = stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType);
    if (!rows.length) { FW.toast('没有可导出的数据'); return; }
    var out = [];
    periodAgg(rows).forEach(function (g) {
      g.items.forEach(function (it) {
        var off = (it.retOff != null) ? num(it.retOff) : Math.abs(num(it.retA));
        out.push([g.period, '', it.item, it.unit, num(it.inQ), (it.inQ > 0 ? (it.inA / it.inQ).toFixed(2) : ''), num(it.inA).toFixed(2),
          num(it.retQ), off.toFixed(2), (num(it.inA) - off).toFixed(2), num(it.balQ)]);
        it.byDateList.forEach(function (bd) {
          out.push([g.period, bd.date, it.item, it.unit, num(bd.inQ), '', '', num(bd.retQ), '', '', num(bd.balQ)]);
        });
      });
    });
    var head = ['营期', '发货日期', '产品', '单位', '调货数量', '均价', '金额', '退货数量', '退货冲减', '净额', '结存'];
    var csv = '\ufeff' + [head].concat(out).map(function (r) {
      return r.map(function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '库存按营期汇总_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出按营期汇总（CSV）');
  }

  // 导出按营期汇总（PNG 图片，一图看清每个营期的调货/退货/净额，适合直接发给老板看）
  function exportStockPeriodImg() {
    if (!window.FWTableImg) { FW.toast('图片导出组件未加载，请刷新页面重试'); return; }
    var rows = stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType);
    if (!rows.length) { FW.toast('没有可导出的数据'); return; }
    var groups = periodAgg(rows);
    if (!groups.length) { FW.toast('没有可导出的数据'); return; }
    var head = ['营期', '产品', '调货数量', '调货金额', '退货冲减', '净额', '结存'];
    var outRows = [], prodSet = {}, tQ = 0, tIn = 0, tOff = 0, tNet = 0;
    groups.forEach(function (g) {
      var gOff = periodRetOff(g), gNet = periodNet(g);
      g.items.forEach(function (it) {
        prodSet[g.period + '|' + it.item] = 1;
        var off = (it.retOff != null) ? num(it.retOff) : Math.abs(num(it.retA));
        outRows.push([g.period, it.item, String(num(it.inQ)), money(it.inA), money(off), money(num(it.inA) - off), String(num(it.balQ))]);
      });
      tQ += num(g.tot.inQ); tIn += num(g.tot.inA); tOff += gOff; tNet += gNet;
      outRows.push([g.period, '— 小计（' + g.items.length + ' 种产品）', String(num(g.tot.inQ)), money(g.tot.inA), money(gOff), money(gNet), String(num(g.tot.balQ))]);
    });
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    var d = new Date();
    var stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var rng = (state.stFrom || state.stTo) ? ((state.stFrom || '不限') + ' ~ ' + (state.stTo || '不限')) : '全部';
    FW.toast('图片生成中…');
    window.FWTableImg.render({
      title: '库存台账 · 按营期汇总',
      eyebrow: '财务工作台 · 库存台账',
      subtitle: '期间：' + rng + '　|　导出日期：' + FW.today(),
      footer: '由 财务工作台 导出 · ' + stamp + ' · 仅供内部参考',
      kpis: [
        { label: '营期数', value: String(groups.length) },
        { label: '产品数', value: String(Object.keys(prodSet).length) },
        { label: '调货金额', value: money(tIn), cls: 'income' },
        { label: '退货冲减', value: money(tOff), cls: 'expense' },
        { label: '净额合计', value: money(tNet) }
      ],
      head: head,
      rows: outRows,
      colWidths: [150, 205, 92, 115, 115, 115, 84],
      amountCol: 3
    }).then(function (canvas) {
      window.FWTableImg.downloadPNG(canvas, '库存按营期汇总_' + FW.today() + '.png');
      FW.toast('已导出按营期汇总（PNG）');
    }).catch(function (err) {
      console.error('[库存导出图片] 失败：', err);
      FW.toast('图片生成失败：' + (err && err.message ? err.message : err));
    });
  }

  /* ---------- 结算对账：按半月分期（1-15 / 16-月末），调货 − 退货抵扣 = 应付 ---------- */
  var NO_DATE_KEY = '未填日期';
  function periodKeyOf(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return '';
    return d.slice(0, 7) + '-' + (Number(d.slice(8, 10)) <= 15 ? '上' : '下');
  }
  function periodLabel(k) {
    if (k === NO_DATE_KEY) return NO_DATE_KEY;
    return k.slice(0, 7) + ' ' + (k.slice(8) === '上' ? '上半月' : '下半月');
  }
  function periodRange(k) {
    if (k === NO_DATE_KEY) return { from: '', to: '' };
    var ym = k.slice(0, 7);
    return k.slice(8) === '上' ? { from: ym + '-01', to: ym + '-15' } : { from: ym + '-16', to: ym + '-31' };
  }

  // mode: 'cur' 当期直接抵扣 / 'next' 月末归集、次月初那次结算抵扣
  // 返回 [{key,label,from,to,isFirstHalf,items:[{item,unit,buyQ,buyA,retQ,retA,carInQ,carInA,dedQ,dedA,carQ,carA,payQ,payA}],tot:{...}}]
  function settleAgg(rows, mode) {
    var map = {}, order = [];
    rows.forEach(function (t) {
      var k = periodKeyOf(t.date) || NO_DATE_KEY;
      if (!map[k]) { map[k] = { key: k, items: {}, iorder: [] }; order.push(k); }
      var g = map[k];
      var item = normItem(String(t.item || '—').trim()) || '—';
      var unit = String(t.unit || '').trim();
      var key = item + '||' + unit;
      var q = num(t.qty), a = num(t.amount);
      if (!g.items[key]) {
        g.items[key] = { item: item, unit: unit, buyQ: 0, buyA: 0, retQ: 0, retA: 0 };
        g.iorder.push(key);
      }
      var it = g.items[key];
      if (isReturnType(t.type)) {
        var sg = retSign(t.type);
        it.retQ += q * sg; it.retA += a * sg;
      } else if (stockDir(t.type) === 'in') {
        it.buyQ += q; it.buyA += a;
      }
    });
    order.sort();
    var carry = {};
    return order.map(function (k) {
      var g = map[k];
      var isFirstHalf = (k !== NO_DATE_KEY && k.slice(8) === '上');
      var items = g.iorder.map(function (key) {
        var it = g.items[key];
        var c = carry[key] || { q: 0, a: 0 };
        it.carInQ = c.q; it.carInA = c.a;
        if (mode === 'cur' || k === NO_DATE_KEY) {
          it.dedQ = it.retQ; it.dedA = it.retA;
          it.carQ = 0; it.carA = 0;
        } else if (isFirstHalf) {
          // 月初这次结算：抵扣上期（上月）结转过来的退货
          it.dedQ = c.q; it.dedA = c.a;
          it.carQ = it.retQ; it.carA = it.retA;
        } else {
          // 月末这次结算：先不抵，本期退货并入结转，等次月初再抵
          it.dedQ = 0; it.dedA = 0;
          it.carQ = c.q + it.retQ; it.carA = c.a + it.retA;
        }
        it.payQ = it.buyQ - it.dedQ;
        it.payA = it.buyA - it.dedA;
        carry[key] = { q: it.carQ, a: it.carA };
        return it;
      });
      var tot = items.reduce(function (s, it) {
        s.buyQ += it.buyQ; s.buyA += it.buyA; s.retQ += it.retQ; s.retA += it.retA;
        s.carInQ += it.carInQ; s.carInA += it.carInA;
        s.dedQ += it.dedQ; s.dedA += it.dedA;
        s.carQ += it.carQ; s.carA += it.carA;
        s.payQ += it.payQ; s.payA += it.payA; return s;
      }, { buyQ: 0, buyA: 0, retQ: 0, retA: 0, carInQ: 0, carInA: 0, dedQ: 0, dedA: 0, carQ: 0, carA: 0, payQ: 0, payA: 0 });
      var rg = periodRange(k);
      return { key: k, label: periodLabel(k), from: rg.from, to: rg.to, isFirstHalf: isFirstHalf, items: items, tot: tot };
    });
  }

  function drawStockSettleView(rows) {
    var el = document.getElementById('stWrap');
    if (!el) return;
    var mode = state.stSettleMode || 'next';
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的单据。点右上角「📋 粘贴调货单」或「↩ 登记退货」，或调整筛选条件。</div>';
      return;
    }
    var groups = settleAgg(rows, mode);
    var modeBar =
      '<div class="settle-modebar">' +
        '<span style="font-size:13px;color:var(--muted)">退货抵扣方式：</span>' +
        '<button class="btn ' + (mode === 'next' ? '' : 'ghost ') + 'sm" data-m="next">月末归集·次月初抵扣</button>' +
        '<button class="btn ' + (mode === 'cur' ? '' : 'ghost ') + 'sm" data-m="cur">当期直接抵扣</button>' +
        '<span class="muted" style="font-size:12px">' + (mode === 'next'
          ? '每月末归集退货，到次月「上半月」那次结算时一次性抵扣（结转变动见卡片底部）'
          : '本期发生的退货，直接在本期结算时扣掉') + '</span>' +
      '</div>';

    var html = modeBar + groups.map(function (g) {
      var trs = g.items.map(function (it) {
        var hasRet = Math.abs(it.retQ) > 0.000001;
        var hasIn = Math.abs(it.carInQ) > 0.000001;
        return '<tr>' +
          '<td>' + FW.esc(it.item) + (hasIn ? '<div class="muted" style="font-size:11px">含上期结转退货 ' + num(it.carInQ) + '</div>' : '') + '</td>' +
          '<td>' + (it.unit ? FW.esc(it.unit) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num income">' + num(it.buyQ) + '</td>' +
          '<td class="num">' + money(it.buyA) + '</td>' +
          '<td class="num ' + (hasRet ? 'expense' : 'muted') + '">' + (hasRet ? num(it.retQ) : '—') + '</td>' +
          '<td class="num ' + (hasRet ? 'expense' : 'muted') + '">' + (hasRet ? money(it.retA) : '—') + '</td>' +
          '<td class="num ' + (Math.abs(it.dedA) > 0.000001 ? 'expense' : 'muted') + '">' + (Math.abs(it.dedA) > 0.000001 ? money(it.dedA) : '—') + '</td>' +
          '<td class="num"><b>' + money(it.payA) + '</b></td>' +
          '</tr>';
      }).join('');
      var t = g.tot;
      var tot = '<tr class="per-total"><td><b>小计</b></td><td></td>' +
        '<td class="num"><b>' + num(t.buyQ) + '</b></td>' +
        '<td class="num"><b>' + money(t.buyA) + '</b></td>' +
        '<td class="num expense"><b>' + num(t.retQ) + '</b></td>' +
        '<td class="num expense"><b>' + money(t.retA) + '</b></td>' +
        '<td class="num expense"><b>' + money(t.dedA) + '</b></td>' +
        '<td class="num"><b>' + money(t.payA) + '</b></td></tr>';
      var span = g.from ? (g.from + ' ~ ' + g.to) : '';
      var kpi =
        '<div class="settle-kpis">' +
          '<div class="kpi"><div class="l">本期调货</div><div class="v income">' + money(t.buyA) + '</div><div class="s">' + num(t.buyQ) + ' 件</div></div>' +
          '<div class="kpi"><div class="l">抵扣退货</div><div class="v expense">' + money(t.dedA) + '</div><div class="s">' + (Math.abs(t.carInQ) > 0.000001 ? '含上期结转 ' + num(t.carInQ) + ' 件' : '本期 ' + num(t.retQ) + ' 件') + '</div></div>' +
          '<div class="kpi"><div class="l">本期应付</div><div class="v gold">' + money(t.payA) + '</div><div class="s">' + num(t.payQ) + ' 件</div></div>' +
        '</div>';
      var carryNote = (mode === 'next' && g.key !== NO_DATE_KEY && Math.abs(t.carQ) > 0.000001)
        ? '<div class="per-foot muted">本期未抵扣退货 <b>' + num(t.carQ) + ' 件 / ' + money(t.carA) + '</b>，结转至下一期抵扣</div>'
        : '';
      return '<div class="per-card">' +
        '<div class="per-head"><b>' + FW.esc(g.label) + '</b>' +
        '<span class="muted" style="font-size:12px">' + span + (span ? ' · ' : '') + g.items.length + ' 种产品</span></div>' +
        kpi +
        '<table><thead><tr><th>产品</th><th>单位</th><th class="num">调货数量</th><th class="num">调货金额</th><th class="num">退货数量</th><th class="num">退货金额</th><th class="num">抵扣金额</th><th class="num">本期应付</th></tr></thead><tbody>' +
        trs + tot + '</tbody></table>' + carryNote + '</div>';
    }).join('');
    el.innerHTML = html;
    FW.qa('#stWrap [data-m]').forEach(function (b) {
      b.onclick = function () { state.stSettleMode = this.dataset.m; renderStockList(); };
    });
  }

  // 导出结算对账（CSV）
  function exportStockSettleCsv() {
    var rows = stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType);
    if (!rows.length) { FW.toast('没有可导出的数据'); return; }
    var mode = state.stSettleMode || 'next';
    var out = [];
    settleAgg(rows, mode).forEach(function (g) {
      g.items.forEach(function (it) {
        out.push([g.label, g.from, g.to, it.item, it.unit,
          num(it.buyQ), num(it.buyA).toFixed(2),
          num(it.retQ), num(it.retA).toFixed(2),
          num(it.dedQ), num(it.dedA).toFixed(2),
          num(it.carQ), num(it.carA).toFixed(2),
          num(it.payQ), num(it.payA).toFixed(2)]);
      });
      var t = g.tot;
      out.push([g.label, g.from, g.to, '【小计】', '',
        num(t.buyQ), num(t.buyA).toFixed(2),
        num(t.retQ), num(t.retA).toFixed(2),
        num(t.dedQ), num(t.dedA).toFixed(2),
        num(t.carQ), num(t.carA).toFixed(2),
        num(t.payQ), num(t.payA).toFixed(2)]);
    });
    var head = ['结算期', '起始日', '截止日', '产品', '单位', '调货数量', '调货金额', '退货数量', '退货金额', '抵扣数量', '抵扣金额', '结转数量', '结转金额', '应付数量', '应付金额'];
    var csv = '\ufeff' + [head].concat(out).map(function (r) {
      return r.map(function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '结算对账_' + (mode === 'next' ? '次月初抵扣' : '当期抵扣') + '_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出结算对账（CSV）');
  }

  /* ---------- 快捷登记退货 ---------- */
  function openReturnForm() {
    var conf = loadTransferConf();
    var all = FW.db.getList(STOCK_KEY) || [];
    // 产品候选：历史里出现过的（调货入库/出库都算），带出最近一次单位
    var seen = {};
    all.forEach(function (t) {
      var nm = normItem(String(t.item || '').trim());
      if (!nm) return;
      if (!seen[nm]) seen[nm] = { item: nm, unit: t.unit || '', price: 0, wsum: 0, wqty: 0 };
      if (!seen[nm].unit && t.unit) seen[nm].unit = t.unit;
      var q = num(t.qty), a = num(t.amount);
      if (q > 0 && a > 0) { seen[nm].wsum += a; seen[nm].wqty += q; }
    });
    var products = Object.keys(seen).map(function (k) {
      var p = seen[k];
      p.avg = p.wqty > 0 ? (p.wsum / p.wqty) : 0;
      return p;
    }).sort(function (a, b) { return a.item.localeCompare(b.item, 'zh'); });
    if (!products.length) {
      FW.toast('还没有任何库存记录，请先粘贴调货单');
      return;
    }
    var optHtml = products.map(function (p) {
      return '<option value="' + FW.esc(p.item) + '" data-unit="' + FW.esc(p.unit) + '" data-price="' + (p.avg || 0) + '">' + FW.esc(p.item) + '</option>';
    }).join('');

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>退货日期</label><input id="rt_date" type="date" value="' + FW.esc(FW.today()) + '"></div>' +
        '<div class="field"><label>营期</label><input id="rt_period" value="' + FW.esc(conf.lastPeriod || '') + '" placeholder="如：七彩7.24营期"></div>' +
        '<div class="field full"><label>退回产品</label><select id="rt_item">' + optHtml + '</select></div>' +
        '<div class="field"><label>单位</label><input id="rt_unit" value="' + FW.esc(products[0].unit || '盒') + '"></div>' +
        '<div class="field"><label>数量</label><input id="rt_qty" type="number" step="0.01" min="0" placeholder="退回多少"></div>' +
        '<div class="field"><label>单价（自动带出均价，可改）</label><input id="rt_price" type="number" step="0.01" min="0" value="' + (products[0].avg || 0) + '"></div>' +
        '<div class="field"><label>退货类型</label><select id="rt_type"><option>销售退货</option><option>采购退货</option></select></div>' +
        '<div class="field"><label>往来单位</label><input id="rt_party" placeholder="选填"></div>' +
        '<div class="field full"><label>备注</label><input id="rt_remark" placeholder="选填，如：客户退回/整箱未拆"></div>' +
        '<div class="field full"><div id="rt_amt" class="muted" style="font-size:13px"></div><div id="rt_src" class="muted" style="font-size:12px"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="rt_cancel">取消</button><button class="btn" id="rt_save">保存退货</button></div>';

    FW.openModal('登记退货', body, function () {
      var dEl = document.getElementById('rt_date'), pEl = document.getElementById('rt_period');
      var iEl = document.getElementById('rt_item'), uEl = document.getElementById('rt_unit');
      var qEl = document.getElementById('rt_qty'), prEl = document.getElementById('rt_price');
      var tEl = document.getElementById('rt_type'), paEl = document.getElementById('rt_party'), rEl = document.getElementById('rt_remark');
      var aEl = document.getElementById('rt_amt'), sBtn = document.getElementById('rt_save');

      // 某产品在某营期内的调货加权均价；period 为空则取全局
      function avgOf(period, item) {
        var wsum = 0, wqty = 0;
        all.forEach(function (t) {
          if (normItem(String(t.item || '').trim()) !== String(item || '').trim()) return;
          if (isReturnType(t.type) || stockDir(t.type) !== 'in') return;
          if (period && String(t.period || '').trim() !== String(period).trim()) return;
          var q = num(t.qty), a = num(t.amount);
          if (q > 0 && a > 0) { wsum += a; wqty += q; }
        });
        return wqty > 0 ? (wsum / wqty) : 0;
      }
      function calcAmt() {
        var q = num(qEl.value), p = num(prEl.value);
        aEl.innerHTML = '退货金额：<b class="expense">' + money(q * p) + '</b>（将在结算时抵扣货款）';
      }
      // 单价优先取「该营期调货均价」，该营期没调货记录则回退全局均价
      function syncPrice() {
        var period = pEl.value.trim(), item = iEl.value;
        var inP = period ? avgOf(period, item) : 0;
        var glb = avgOf('', item);
        var avg = inP || glb;
        prEl.value = avg ? avg.toFixed(2) : 0;
        var src = inP ? '营期「' + period + '」调货均价' : (glb ? '全局调货均价（该营期暂无调货记录）' : '未取到历史单价，请手填');
        aEl.dataset.src = src;
        calcAmt();
        var tip = document.getElementById('rt_src');
        if (tip) tip.textContent = '单价来源：' + src;
      }
      function syncItem() {
        var o = iEl.options[iEl.selectedIndex];
        if (o && o.dataset.unit) uEl.value = o.dataset.unit;
        syncPrice();
      }
      iEl.onchange = syncItem;
      pEl.oninput = syncPrice;
      qEl.oninput = calcAmt; prEl.oninput = calcAmt;
      document.getElementById('rt_cancel').onclick = function () { FW.closeModal(); };
      sBtn.onclick = function () {
        var q = num(qEl.value);
        if (!(q > 0)) { FW.toast('请填写退货数量'); return; }
        var p = num(prEl.value);
        var rec = {
          id: FW.db.uid('st_'),
          date: dEl.value || FW.today(),
          period: pEl.value.trim(),
          item: iEl.value, spec: '', unit: uEl.value.trim() || '盒',
          type: tEl.value, qty: q, price: p, amount: q * p,
          party: paEl.value.trim(), warehouse: '',
          remark: rEl.value.trim() || '退货登记', no: '', photos: []
        };
        FW.db.upsert(STOCK_KEY, rec);
        FW.closeModal();
        renderStockView();
        FW.toast('已登记退货：' + rec.item + ' × ' + q + '（' + money(rec.amount) + '）');
      };
      syncItem();
    });
  }

  function openTransferPaste() {
    var conf = loadTransferConf();
    var rows = [];
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>调货日期</label><input id="tf_date" type="date" value="' + FW.esc(FW.today()) + '"></div>' +
        '<div class="field"><label>营期</label><input id="tf_period" value="' + FW.esc(conf.lastPeriod || '') + '" placeholder="如：七彩7.24营期"></div>' +
        '<div class="field"><label>单位</label><input id="tf_unit" value="' + FW.esc(conf.unit || '盒') + '"></div>' +
        '<div class="field"><label>往来单位</label><input id="tf_party" placeholder="选填"></div>' +
        '<div class="field full"><label>粘贴调货内容</label><textarea id="tf_text" rows="5" placeholder="示例：赫娇七彩时光焕颜能量套 x 58，赫娇舒缓特护冻干面膜组合 x 10，按摩导入仪 x 1，粉色售后卡 x 1&#10;支持 x / × / * 分隔数量，中文逗号或换行分条；含「售后卡」的项自动忽略。"></textarea></div>' +
        '<div class="field full"><button class="btn ghost sm" id="tf_parse">🔍 解析</button> <span id="tf_tip" style="font-size:12px;color:var(--muted)"></span></div>' +
        '<div class="field full" id="tf_preview"></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="tf_cancel">取消</button><button class="btn" id="tf_save" disabled>生成出入库</button></div>';

    FW.openModal('粘贴调货单（进多少出多少）', body, function () {
      var dateEl = document.getElementById('tf_date');
      var periodEl = document.getElementById('tf_period');
      var unitEl = document.getElementById('tf_unit');
      var partyEl = document.getElementById('tf_party');
      var textEl = document.getElementById('tf_text');
      var prevEl = document.getElementById('tf_preview');
      var tipEl = document.getElementById('tf_tip');
      var saveBtn = document.getElementById('tf_save');

      function renderPreview() {
        if (!rows.length) { prevEl.innerHTML = ''; saveBtn.disabled = true; return; }
        var trs = rows.map(function (r, i) {
          return '<tr>' +
            '<td>' + FW.esc(r.item) + '</td>' +
            '<td class="num"><input type="number" step="0.01" min="0" class="tf-qty" data-i="' + i + '" value="' + r.qty + '" style="width:84px"></td>' +
            '<td class="num"><input type="number" step="0.01" min="0" class="tf-price" data-i="' + i + '" value="' + r.price + '" style="width:84px"></td>' +
            '<td class="num">' + money(r.qty * r.price) + '</td>' +
            '<td><button class="btn danger sm tf-del" data-i="' + i + '">删</button></td>' +
            '</tr>';
        }).join('');
        var tq = rows.reduce(function (s, r) { return s + num(r.qty); }, 0);
        var ta = rows.reduce(function (s, r) { return s + num(r.qty) * num(r.price); }, 0);
        prevEl.innerHTML = '<table><thead><tr><th>产品</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th></th></tr></thead><tbody>' + trs +
          '<tr><td><b>合计</b></td><td class="num"><b>' + tq + '</b></td><td class="num"></td><td class="num"><b>' + money(ta) + '</b></td><td></td></tr>' +
          '</tbody></table>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:6px">确认后每个产品生成两条：采购入库 + 销售出库（数量与金额相同，即进多少出多少）。</div>';
        saveBtn.disabled = false;
        FW.qa('#tf_preview .tf-qty').forEach(function (inp) {
          inp.oninput = function () { rows[+this.dataset.i].qty = num(this.value); refreshAmounts(); };
        });
        FW.qa('#tf_preview .tf-price').forEach(function (inp) {
          inp.oninput = function () { rows[+this.dataset.i].price = num(this.value); refreshAmounts(); };
        });
        FW.qa('#tf_preview .tf-del').forEach(function (b) {
          b.onclick = function () { rows.splice(+this.dataset.i, 1); renderPreview(); };
        });
      }
      // 只刷新金额列与合计，避免重绘导致输入框失焦
      function refreshAmounts() {
        var tb = prevEl.querySelector('tbody');
        if (!tb) return;
        var trs = tb.querySelectorAll('tr');
        rows.forEach(function (r, i) {
          var tr = trs[i]; if (!tr) return;
          var td = tr.children[3]; if (td) td.textContent = money(num(r.qty) * num(r.price));
        });
        var tq = rows.reduce(function (s, r) { return s + num(r.qty); }, 0);
        var ta = rows.reduce(function (s, r) { return s + num(r.qty) * num(r.price); }, 0);
        var last = trs[rows.length];
        if (last) { last.children[1].innerHTML = '<b>' + tq + '</b>'; last.children[3].innerHTML = '<b>' + money(ta) + '</b>'; }
      }

      document.getElementById('tf_parse').onclick = function () {
        rows = parseTransferText(textEl.value, conf);
        if (!rows.length) {
          tipEl.textContent = '没解析出产品，请检查格式（示例：产品名 x 58）';
          renderPreview(); return;
        }
        var skipped = (conf.exclude || []).filter(function (k) { return k && textEl.value.indexOf(k) >= 0; });
        tipEl.textContent = '已解析 ' + rows.length + ' 种产品' + (skipped.length ? '（已忽略含「' + skipped.join('、') + '」的项）' : '');
        renderPreview();
      };
      document.getElementById('tf_cancel').onclick = FW.closeModal;
      saveBtn.onclick = function () {
        if (!rows.length) { FW.toast('请先点「解析」'); return; }
        var date = dateEl.value || FW.today();
        var period = periodEl.value.trim();
        var unit = unitEl.value.trim() || '盒';
        var party = partyEl.value.trim();
        if (!period && !confirm('没填营期，确定继续？')) return;
        // 防重复：同一「调货日期 + 营期」已有调货单解析记录时拦截确认
        var dup = findTransferDup(date, period);
        if (dup.length) {
          var dupMsg = '⚠️ 该日期（' + date + '）+ 营期（' + (period || '未填') + '）已有 ' + dup.length + ' 条调货记录。\n\n' +
            '继续会再新增 ' + (rows.length * 2) + ' 条，数量会被重复计入（库存翻倍）。\n\n' +
            '若是同一批货重复贴了，请点「取消」，去「按营期汇总」核对，或先点「↩ 撤销上次生成」清掉再贴。\n\n' +
            '确定仍要继续吗？';
          if (!confirm(dupMsg)) return;
        }
        var n = 0, genIds = [];
        rows.forEach(function (r) {
          var q = num(r.qty), p = num(r.price);
          if (!(q > 0)) return;
          var common = {
            date: date, period: period, item: r.item, unit: unit,
            qty: q, price: p, amount: q * p,
            party: party, remark: '调货单粘贴解析' + (period ? ' · ' + period : ''),
            no: '', spec: '', warehouse: '', photos: []
          };
          ['采购入库', '销售出库'].forEach(function (tp) {
            var rec = { id: FW.db.uid('st_'), type: tp };
            Object.keys(common).forEach(function (k) { rec[k] = common[k]; });
            FW.db.upsert(STOCK_KEY, rec);
            genIds.push(rec.id);
            n++;
          });
        });
        conf.lastPeriod = period; conf.unit = unit; saveTransferConf(conf);
        if (genIds.length) saveLastGen({ ids: genIds, count: genIds.length, date: date, period: period, ts: Date.now() });
        FW.closeModal(); renderStockView();
        FW.toast('已生成 ' + n + ' 条记录（每个产品入库+出库各 1 条）；贴错可点「↩ 撤销上次生成」');
      };
    });
  }

  function openStockForm(id) {
    var edit = id ? FW.db.getById(STOCK_KEY, id) : null;
    var v = {
      date: FW.today(), period: '', no: '', item: '', spec: '', unit: '个',
      type: '采购入库', qty: '', price: '', amount: '',
      party: '', warehouse: '', remark: '', photos: []
    };
    if (edit) {
      v = {
        date: edit.date || FW.today(), period: edit.period || '', no: edit.no || '', item: edit.item || '', spec: edit.spec || '', unit: edit.unit || '个',
        type: edit.type || '采购入库', qty: edit.qty, price: edit.price, amount: edit.amount,
        party: edit.party || '', warehouse: edit.warehouse || '', remark: edit.remark || '', photos: edit.photos || []
      };
    }
    state.stPhotos = v.photos.slice();

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>日期</label><input id="s_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>单号</label><input id="s_no" value="' + FW.esc(v.no) + '" placeholder="出入库单号（选填）"></div>' +
        '<div class="field"><label>营期</label><input id="s_period" value="' + FW.esc(v.period) + '" placeholder="选填，如：七彩7.24营期"></div>' +
        '<div class="field full"><label>商品/物料名称</label><input id="s_item" value="' + FW.esc(v.item) + '" placeholder="名称（必填）"></div>' +
        '<div class="field"><label>规格</label><input id="s_spec" value="' + FW.esc(v.spec) + '" placeholder="选填"></div>' +
        '<div class="field"><label>单位</label><input id="s_unit" value="' + FW.esc(v.unit) + '" placeholder="个/件/箱"></div>' +
        '<div class="field"><label>业务类型</label><select id="s_type">' + STOCK_TYPES.map(function (t) { return '<option ' + (t.label === v.type ? 'selected' : '') + '>' + t.label + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>数量</label><input id="s_qty" type="number" step="0.01" min="0" value="' + FW.esc(v.qty) + '"></div>' +
        '<div class="field"><label>单价（元）</label><input id="s_price" type="number" step="0.01" min="0" value="' + FW.esc(v.price) + '"></div>' +
        '<div class="field"><label>金额（元）</label><input id="s_amount" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '" placeholder="留空自动算"></div>' +
        '<div class="field"><label>往来单位</label><input id="s_party" value="' + FW.esc(v.party) + '" placeholder="供应商/客户"></div>' +
        '<div class="field"><label>仓库</label><input id="s_wh" value="' + FW.esc(v.warehouse) + '" placeholder="选填"></div>' +
        '<div class="field full"><label>备注</label><textarea id="s_remark" rows="2" placeholder="用途 / 关联单据">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>单据照片</label><div class="photo-grid" id="stPhotoGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="stCancel">取消</button><button class="btn" id="stSave">保存</button></div>';

    FW.openModal(edit ? '编辑单据' : '新增单据', body, function () {
      renderStockPhotoGrid(state.stPhotos);
      // 自动计算金额
      function autoAmount() {
        var q = num(document.getElementById('s_qty').value);
        var p = num(document.getElementById('s_price').value);
        var am = document.getElementById('s_amount');
        if (q > 0 && p > 0 && !am.value) am.value = (q * p).toFixed(2);
      }
      document.getElementById('s_qty').oninput = autoAmount;
      document.getElementById('s_price').oninput = autoAmount;
      document.getElementById('stCancel').onclick = FW.closeModal;
      document.getElementById('stSave').onclick = function () {
        var item = document.getElementById('s_item').value.trim();
        if (!item) { FW.toast('请填写商品/物料名称'); return; }
        var qty = num(document.getElementById('s_qty').value);
        if (!(qty > 0)) { FW.toast('数量必须大于 0'); return; }
        var price = num(document.getElementById('s_price').value);
        var amountRaw = document.getElementById('s_amount').value;
        var amount = amountRaw ? num(amountRaw) : (qty * price);
        var rec = {
          id: edit ? edit.id : FW.db.uid('st_'),
          date: document.getElementById('s_date').value || FW.today(),
          period: document.getElementById('s_period').value.trim(),
          no: document.getElementById('s_no').value.trim(),
          item: item,
          spec: document.getElementById('s_spec').value.trim(),
          unit: document.getElementById('s_unit').value.trim() || '个',
          type: document.getElementById('s_type').value,
          qty: qty, price: price, amount: amount,
          party: document.getElementById('s_party').value.trim(),
          warehouse: document.getElementById('s_wh').value.trim(),
          remark: document.getElementById('s_remark').value.trim(),
          photos: state.stPhotos
        };
        FW.db.upsert(STOCK_KEY, rec);
        FW.closeModal(); renderStockView(); FW.toast('已保存');
      };
    });
  }

  function delStock(id) {
    var rec = FW.db.getById(STOCK_KEY, id);
    if (!rec) return;
    if (!confirm('确定删除该单据？' + (rec.photos && rec.photos.length ? '（将同时删除 ' + rec.photos.length + ' 张单据照片）' : ''))) return;
    FW.db.remove(STOCK_KEY, id);
    if (rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
    renderStockView(); FW.toast('已删除');
  }

  function renderStockPhotoGrid(photos) {
    var grid = document.getElementById('stPhotoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    (photos || []).forEach(function (pid) {
      var wrap = document.createElement('div'); wrap.style.position = 'relative';
      var img = document.createElement('img'); img.className = 'photo-thumb';
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderStockPhotoGrid(photos); };
      img.style.cursor = 'pointer';
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div'); add.className = 'photo-add'; add.textContent = '＋'; add.title = '上传单据照片';
    add.onclick = function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files);
        var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderStockPhotoGrid(photos); });
      };
      inp.click();
    };
    grid.appendChild(add);
  }

  function setStockRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'smonth') { state.stFrom = y + '-' + p(m + 1) + '-01'; state.stTo = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'syear') { state.stFrom = y + '-01-01'; state.stTo = y + '-12-31'; }
    else { state.stFrom = ''; state.stTo = ''; }
    renderStockView();
  }

  function exportStockCsv() {
    var rows = stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType);
    if (!rows.length) { FW.toast('没有可导出的单据'); return; }
    var head = ['日期', '营期', '单号', '商品/物料', '规格', '单位', '业务类型', '方向', '数量', '单价', '金额', '往来单位', '仓库', '备注'];
    var data = rows.map(function (t) {
      return [t.date, t.period || '', t.no || '', t.item || '', t.spec || '', t.unit || '', t.type || '', (stockDir(t.type) === 'in' ? '入' : '出'), t.qty, t.price, t.amount, t.party || '', t.warehouse || '', t.remark || ''];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '库存台账_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 条单据（CSV）');
  }

  FW.stockCalc = { stockSummary: stockSummary };

  FW.modules = FW.modules || {};
  FW.modules.invoices = {
    title: '发票台账',
    render: render,
    tabs: [
      { key: 'all', label: '全部' },
      { key: 'in', label: '进项发票' },
      { key: 'out', label: '销项发票' },
      { key: 'contract', label: '合同台账' },
      { key: 'stock', label: '库存台账' }
    ],
    getTab: function () { return state.tab; },
    setTab: function (k) { state.tab = k; state.deduction = ''; render(); if (window.FW.nav) FW.nav.refreshSubNav(); }
  };
})(window);
