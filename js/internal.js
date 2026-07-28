/* ============================================================
 * 登记内账模块
 * 流水账：项目 / 每月 / 每日 / 分类账户 统计 + 照片凭证
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'internal';
  var DEFAULT_CATS = ['办公用品', '差旅费', '餐饮招待', '工资薪酬', '房租物业', '交通出行', '广告宣传', '材料采购', '设备购置', '税费', '利息收入', '其他收入', '其他支出'];
  var ACCTS = ['现金', '银行卡', '支付宝', '微信', '对公账户', '其他'];
  // 用途分类（一级/二级，可自定义，按账本隔离）
  var CATKEY = 'internal_cats';
  function cats() { return FW.db.getList(CATKEY); }
  function ensureCats() { if (!cats().length) FW.db.saveList(CATKEY, DEFAULT_CATS.map(function (n) { return { name: n, children: [] }; })); }
  function cat1Name(t) { return (t.category || '').split(' / ')[0]; }

  /* ---------- 预算辅助 ---------- */
  var BKEY = 'internal_budget';
  function getBudget(month) { return FW.db.getList(BKEY).filter(function (b) { return b.month === month; })[0] || null; }
  function monthExpense(month) {
    return all().filter(function (t) { return t.date.slice(0, 7) === month && t.type === 'expense'; })
      .reduce(function (a, t) { return a + Number(t.amount); }, 0);
  }
  function monthSum(m) {
    var inc = 0, exp = 0;
    all().forEach(function (t) { if (t.date && t.date.slice(0, 7) === m) { if (t.type === 'income') inc += +t.amount; else exp += +t.amount; } });
    return { inc: inc, exp: exp, net: inc - exp };
  }
  function prevMonth(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); m--; if (m === 0) { m = 12; y--; } return y + '-' + (m < 10 ? '0' + m : m); }
  function shiftMonth(ym, delta) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + delta; y += Math.floor(m / 12); m = (m % 12 + 12) % 12; return y + '-' + (m + 1 < 10 ? '0' + (m + 1) : m + 1); }

  var state = { tab: 'list', filter: { project: '', category: '', account: '', type: '', kw: '', from: '', to: '' }, statFrom: '', statTo: '', calMonth: '', calSel: '', fundType: '' };

  function all() { return FW.db.getList(KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }); }
  function projects() {
    var set = {};
    FW.db.getList(KEY).forEach(function (t) { if (t.project) set[t.project] = 1; });
    return Object.keys(set);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function lastDay(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function rangeDates(kind) {
    var now = new Date(); var y = now.getFullYear(), m = now.getMonth();
    if (kind === 'month') return { from: y + '-' + pad(m + 1) + '-01', to: y + '-' + pad(m + 1) + '-' + lastDay(y, m) };
    if (kind === 'quarter') { var q = Math.floor(m / 3) * 3; return { from: y + '-' + pad(q + 1) + '-01', to: y + '-' + pad(q + 2 + 1) + '-' + lastDay(y, q + 2) }; }
    if (kind === 'year') return { from: y + '-01-01', to: y + '-12-31' };
    return { from: '', to: '' };
  }
  function filteredRows() {
    var f = state.filter;
    return all().filter(function (t) {
      if (f.project && t.project !== f.project) return false;
      if (f.category && cat1Name(t) !== f.category) return false;
      if (f.account && t.account !== f.account) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.from && t.date < f.from) return false;
      if (f.to && t.date > f.to) return false;
      if (f.kw && (t.remark + t.project + t.category).indexOf(f.kw) < 0) return false;
      return true;
    });
  }

  /* ---------- 渲染主框架 ---------- */
  function render() {
    ensureCats();
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="tabs" id="inTabs">' +
        '<button class="tab ' + (state.tab === 'list' ? 'active' : '') + '" data-t="list">流水明细</button>' +
        '<button class="tab ' + (state.tab === 'calendar' ? 'active' : '') + '" data-t="calendar">收支日历</button>' +
        '<button class="tab ' + (state.tab === 'stat' ? 'active' : '') + '" data-t="stat">统计分析</button>' +
        '<button class="tab ' + (state.tab === 'fund' ? 'active' : '') + '" data-t="fund">资金变动明细</button>' +
      '</div>' +
      '<div id="inBody"></div>';
    FW.qa('#inTabs .tab').forEach(function (b) {
      b.onclick = function () { state.tab = b.dataset.t; FW.qa('#inTabs .tab').forEach(function (x) { x.classList.toggle('active', x === b); }); drawBody(); };
    });
    drawBody();

    // 顶部操作区
    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="budgetBtn">⚙ 设置预算</button><button class="btn ghost" id="catBtn">🏷 分类管理</button><button class="btn ghost" id="impBtn">📥 批量导入</button><button class="btn" id="addTxBtn">＋ 新增流水</button><button class="btn ghost" id="expTxBtn">⬇ 导出表格</button>';
    document.getElementById('budgetBtn').onclick = openBudgetForm;
    document.getElementById('catBtn').onclick = openCatManager;
    document.getElementById('addTxBtn').onclick = openForm;
    document.getElementById('expTxBtn').onclick = exportTable;
    document.getElementById('impBtn').onclick = openImport;
  }

  function drawBody() {
    if (state.tab === 'list') drawList();
    else if (state.tab === 'calendar') drawCalendar();
    else if (state.tab === 'fund') drawFund();
    else drawStat();
  }

  /* ---------- 流水明细 ---------- */
  function drawList() {
    var f = state.filter;
    var projOpts = '<option value="">全部项目</option>' + projects().map(function (p) { return '<option>' + FW.esc(p) + '</option>'; }).join('');
    var catOpts = '<option value="">全部分类</option>' + cats().map(function (c) { return '<option' + (c.name === f.category ? ' selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('');
    var accOpts = '<option value="">全部账户</option>' + ACCTS.map(function (p) { return '<option>' + FW.esc(p) + '</option>'; }).join('');
    document.getElementById('inBody').innerHTML =
      '<div id="budgetCard">' + budgetBannerHtml() + '</div>' +
      '<div id="txStats" class="stat-row"></div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="field"><input id="fKw" placeholder="搜索备注/项目" value="' + FW.esc(f.kw) + '"></div>' +
          '<div class="field"><select id="fProj">' + projOpts + '</select></div>' +
          '<div class="field"><select id="fCat">' + catOpts + '</select></div>' +
          '<div class="field"><select id="fAcc">' + accOpts + '</select></div>' +
          '<div class="field"><select id="fType"><option value="">全部类型</option><option value="income">收入</option><option value="expense">支出</option><option value="transfer">账户互转</option><option value="equity">股本资金</option></select></div>' +
          '<div class="field"><input id="fFrom" type="date" title="起始日期"></div>' +
          '<div class="field"><input id="fTo" type="date" title="结束日期"></div>' +
          '<button class="btn ghost sm" id="fReset">重置</button>' +
        '</div>' +
        '<div id="txWrap"></div>' +
      '</div>';
    document.getElementById('fProj').value = f.project;
    document.getElementById('fCat').value = f.category;
    document.getElementById('fAcc').value = f.account;
    document.getElementById('fType').value = f.type || '';
    document.getElementById('fFrom').value = f.from;
    document.getElementById('fTo').value = f.to;
    bindFilter();
    drawTable();
    var gb = document.getElementById('goBudget');
    if (gb) gb.onclick = openBudgetForm;
  }

  function bindFilter() {
    var g = function (id) { return document.getElementById(id); };
    g('fKw').oninput = function () { state.filter.kw = this.value.trim(); drawTable(); };
    g('fProj').onchange = function () { state.filter.project = this.value; drawTable(); };
    g('fCat').onchange = function () { state.filter.category = this.value; drawTable(); };
    g('fAcc').onchange = function () { state.filter.account = this.value; drawTable(); };
    g('fType').onchange = function () { state.filter.type = this.value; drawTable(); };
    g('fFrom').onchange = function () { state.filter.from = this.value; drawTable(); };
    g('fTo').onchange = function () { state.filter.to = this.value; drawTable(); };
    g('fReset').onclick = function () { state.filter = { project: '', category: '', account: '', type: '', kw: '', from: '', to: '' }; drawList(); };
  }

  function drawTable() {
    var rows = filteredRows();
    var income = rows.filter(function (t) { return t.type === 'income'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var expense = rows.filter(function (t) { return t.type === 'expense'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    document.getElementById('txStats').innerHTML =
      '<div class="stat"><div class="label">筛选后收入</div><div class="value income">' + FW.fmtMoney(income) + '</div></div>' +
      '<div class="stat"><div class="label">筛选后支出</div><div class="value expense">' + FW.fmtMoney(expense) + '</div></div>' +
      '<div class="stat"><div class="label">筛选后结余</div><div class="value">' + FW.fmtMoney(income - expense) + '</div></div>' +
      '<div class="stat"><div class="label">笔数</div><div class="value">' + rows.length + '</div></div>';
    document.getElementById('txWrap').innerHTML = rows.length ? tableHtml(rows) : '<div class="empty">没有符合条件的流水，点右上角「新增流水」开始登记。</div>';
    FW.qa('#txTable .row-edit').forEach(function (b) { b.onclick = function () { openForm(b.dataset.id); }; });
    FW.qa('#txTable .row-del').forEach(function (b) { b.onclick = function () { delTx(b.dataset.id); }; });
    FW.qa('#txTable .photo-cell img').forEach(function (img) { img.onclick = function () { previewPhoto(img.dataset.pid); }; });
    loadThumbs();
  }

  function typeMeta(t) {
    if (t.type === 'income') return { tag: '收入', cls: 'income' };
    if (t.type === 'expense') return { tag: '支出', cls: 'expense' };
    if (t.type === 'transfer') return { tag: '账户互转', cls: 'transfer' };
    if (t.type === 'equity') return { tag: (t.equityDir === 'out' ? '股本抽回' : '股本注入'), cls: 'equity' };
    return { tag: t.type || '—', cls: '' };
  }

  function tableHtml(rows) {
    var trs = rows.map(function (t) {
      var photos = (t.photos || []).map(function (pid) {
        return '<img class="photo-thumb" data-pid="' + pid + '" src="" data-load="' + pid + '" alt="凭证">';
      }).join('');
      var m = typeMeta(t);
      var amtCls = (t.type === 'income' || t.type === 'expense') ? m.cls : 'neutral';
      var acctTxt = t.type === 'transfer' ? (t.account || '—') : (t.type === 'equity' ? (t.account || '—') : (t.account || '—'));
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date) + '</td>' +
        '<td>' + (t.type === 'transfer' || t.type === 'equity' ? '<span class="tag ' + m.cls + '">' + m.tag + '</span><div class="muted" style="font-size:11px">不影响收支</div>' : '<span class="tag ' + m.cls + '">' + m.tag + '</span>') + '</td>' +
        '<td>' + FW.esc(t.project || '—') + '</td>' +
        '<td>' + FW.esc(t.category || (t.type === 'income' || t.type === 'expense' ? '—' : '—')) + '</td>' +
        '<td>' + FW.esc(acctTxt) + '</td>' +
        '<td class="num ' + amtCls + '">' + FW.fmtMoney(t.amount) + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="photo-cell">' + (photos || '<span class="muted">—</span>') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    return '<table id="txTable"><thead><tr>' +
      '<th>日期</th><th>类型</th><th>项目</th><th>分类</th><th>账户</th><th class="num">金额</th><th>备注</th><th>凭证</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
  }

  // 懒加载照片缩略图
  function loadThumbs() {
    FW.qa('#txTable img[data-load]').forEach(function (img) {
      var pid = img.dataset.load;
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
    });
  }

  /* ---------- 统计 ---------- */
  function groupSum(rows, keyFn) {
    var map = {};
    rows.forEach(function (t) {
      if (t.type !== 'income' && t.type !== 'expense') return;
      var k = keyFn(t);
      if (!map[k]) map[k] = { income: 0, expense: 0 };
      map[k][t.type] += Number(t.amount);
    });
    return map;
  }

  function drawStat() {
    var rows = all().filter(function (t) {
      if (state.statFrom && t.date < state.statFrom) return false;
      if (state.statTo && t.date > state.statTo) return false;
      return true;
    });
    var byProj = groupSum(rows, function (t) { return t.project || '未分类项目'; });
    var byMonth = groupSum(rows, function (t) { return t.date.slice(0, 7); });
    var byDay = groupSum(rows, function (t) { return t.date; });
    var byCat = groupSum(rows, function (t) { return t.category || '其他'; });
    var byAcc = groupSum(rows, function (t) { return t.account || '其他'; });

    var totalIncome = rows.reduce(function (a, t) { return a + (t.type === 'income' ? +t.amount : 0); }, 0);
    var totalExpense = rows.reduce(function (a, t) { return a + (t.type === 'expense' ? +t.amount : 0); }, 0);
    var curMonth = FW.today().slice(0, 7);
    var prev = monthSum(prevMonth(curMonth));
    function mom(cur, pv) { if (!(pv > 0)) return null; return (cur - pv) / pv * 100; }
    var incMom = mom(totalIncome, prev.inc);
    var expMom = mom(totalExpense, prev.exp);

    // 月度柱状图（收入 vs 支出）
    var months = Object.keys(byMonth).sort();
    var monthItems = months.map(function (m) { return { label: m.slice(5) + '月', value: byMonth[m].income - byMonth[m].expense }; });
    var catItems = Object.keys(byCat).map(function (k) { return { label: k, value: byCat[k].expense }; }).filter(function (x) { return x.value > 0; });
    var accItems = Object.keys(byAcc).map(function (k) { return { label: k, value: byAcc[k].income + byAcc[k].expense }; }).filter(function (x) { return x.value > 0; });
    var projItems = Object.keys(byProj).map(function (k) { return { label: k, value: byProj[k].income - byProj[k].expense }; });

    var rangeTxt = (state.statFrom || state.statTo) ? ('（' + (state.statFrom || '最早') + ' 至 ' + (state.statTo || '最新') + '）') : '（全部期间）';
    var html =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">统计时间区间：</span>' +
        '<div class="field"><input id="statFrom" type="date" value="' + FW.esc(state.statFrom) + '" title="开始日期"></div>' +
        '<div class="field"><input id="statTo" type="date" value="' + FW.esc(state.statTo) + '" title="结束日期"></div>' +
        '<button class="btn ghost sm" data-range="month">本月</button>' +
        '<button class="btn ghost sm" data-range="quarter">本季</button>' +
        '<button class="btn ghost sm" data-range="year">本年</button>' +
        '<button class="btn ghost sm" id="statReset">全部</button>' +
      '</div></div>' +
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">区间收入 ' + rangeTxt + '</div><div class="value income">' + FW.fmtMoney(totalIncome) + '</div></div>' +
        '<div class="stat"><div class="label">区间支出</div><div class="value expense">' + FW.fmtMoney(totalExpense) + '</div></div>' +
        '<div class="stat"><div class="label">区间结余</div><div class="value">' + FW.fmtMoney(totalIncome - totalExpense) + '</div></div>' +
        '<div class="stat"><div class="label">收入环比（上月）</div><div class="value ' + (incMom == null ? '' : (incMom >= 0 ? 'income' : 'expense')) + '">' + (incMom == null ? '—' : (incMom >= 0 ? '▲' : '▼') + Math.abs(incMom).toFixed(1) + '%') + '</div></div>' +
        '<div class="stat"><div class="label">支出环比（上月）</div><div class="value ' + (expMom == null ? '' : (expMom >= 0 ? 'income' : 'expense')) + '">' + (expMom == null ? '—' : (expMom >= 0 ? '▲' : '▼') + Math.abs(expMom).toFixed(1) + '%') + '</div></div>' +
      '</div>' +
      '<div class="chart-wrap">' +
        (months.length ? FW.lineChart('月度收支趋势（收入/支出）', [{ name: '收入', color: '#e63946', points: months.map(function (m) { return { label: m.slice(5) + '月', value: byMonth[m].income }; }) }, { name: '支出', color: '#1f9d55', points: months.map(function (m) { return { label: m.slice(5) + '月', value: byMonth[m].expense }; }) }]) : '') +
        (months.length ? FW.barChart('每月净收支（收入-支出）', monthItems, { color: '#2f6bff' }) : '') +
        (catItems.length ? FW.pieChart('支出分类占比', catItems) : '') +
        (accItems.length ? FW.pieChart('账户收支分布', accItems) : '') +
        (projItems.length ? FW.barChart('各项目净收支', projItems, { color: '#9b5de5' }) : '') +
      '</div>';

    // 明细统计表（四个维度 tab）
    html +=
      '<div class="card" style="margin-top:18px"><div class="tabs" id="statTabs">' +
        '<button class="tab active" data-s="proj">项目统计</button>' +
        '<button class="tab" data-s="month">每月统计</button>' +
        '<button class="tab" data-s="day">每日统计</button>' +
        '<button class="tab" data-s="catacc">分类账户统计</button>' +
      '</div><div id="statTable"></div></div>';

    document.getElementById('inBody').innerHTML = html;
    drawStatTable('proj', byProj, byMonth, byDay, byCat, byAcc);

    // 时间区间事件
    var g = function (id) { return document.getElementById(id); };
    g('statFrom').onchange = function () { state.statFrom = this.value; drawStat(); };
    g('statTo').onchange = function () { state.statTo = this.value; drawStat(); };
    g('statReset').onclick = function () { state.statFrom = ''; state.statTo = ''; drawStat(); };
    FW.qa('#inBody [data-range]').forEach(function (b) {
      b.onclick = function () { var r = rangeDates(b.dataset.range); state.statFrom = r.from; state.statTo = r.to; drawStat(); };
    });

    FW.qa('#statTabs .tab').forEach(function (b) {
      b.onclick = function () {
        FW.qa('#statTabs .tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        drawStatTable(b.dataset.s, byProj, byMonth, byDay, byCat, byAcc);
      };
    });
  }

  /* ---------- 资金变动明细（账户互转 / 股本，不影响收支） ---------- */
  function drawFund() {
    var fType = state.fundType || '';
    var rows = all().filter(function (t) { return t.type === 'transfer' || t.type === 'equity'; });
    if (fType === 'transfer') rows = rows.filter(function (t) { return t.type === 'transfer'; });
    else if (fType === 'equity') rows = rows.filter(function (t) { return t.type === 'equity'; });

    var transfers = rows.filter(function (t) { return t.type === 'transfer'; });
    var equities = rows.filter(function (t) { return t.type === 'equity'; });
    var transferSum = transfers.reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var eqIn = equities.filter(function (t) { return t.equityDir !== 'out'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var eqOut = equities.filter(function (t) { return t.equityDir === 'out'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);

    // 各账户资金净变动（仅统计互转与股本，不含收支）
    var acctMap = {};
    all().forEach(function (t) {
      var amt = Number(t.amount);
      if (t.type === 'transfer') {
        acctMap[t.fromAccount] = (acctMap[t.fromAccount] || 0) - amt;
        acctMap[t.toAccount] = (acctMap[t.toAccount] || 0) + amt;
      } else if (t.type === 'equity') {
        if (t.equityDir === 'out') acctMap[t.account] = (acctMap[t.account] || 0) - amt;
        else acctMap[t.account] = (acctMap[t.account] || 0) + amt;
      }
    });
    var acctKeys = Object.keys(acctMap).filter(function (k) { return acctMap[k] !== 0; });
    var acctTrs = acctKeys.map(function (k) {
      var v = acctMap[k];
      return '<tr><td>' + FW.esc(k) + '</td><td class="num ' + (v >= 0 ? 'income' : 'expense') + '">' + (v >= 0 ? '+' : '') + FW.fmtMoney(v) + '</td></tr>';
    }).join('');

    var trs = rows.map(function (t) {
      var m = typeMeta(t);
      var detail;
      if (t.type === 'transfer') detail = FW.esc(t.fromAccount) + ' <span class="muted">→</span> ' + FW.esc(t.toAccount);
      else detail = (t.equityDir === 'out' ? '股本抽回' : '股本注入') + '（' + FW.esc(t.account) + '）';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date) + '</td>' +
        '<td><span class="tag ' + m.cls + '">' + m.tag + '</span><div class="muted" style="font-size:11px">不影响收支</div></td>' +
        '<td>' + FW.esc(t.project || '—') + '</td>' +
        '<td>' + detail + '</td>' +
        '<td class="num neutral">' + FW.fmtMoney(t.amount) + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn danger sm fund-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');

    var html =
      '<div class="toolbar" style="margin-bottom:14px">' +
        '<div class="field"><select id="fundType">' +
          '<option value="">全部资金变动</option>' +
          '<option value="transfer">仅账户互转</option>' +
          '<option value="equity">仅股本资金</option>' +
        '</select></div>' +
        '<span class="muted" style="align-self:center">账户互转与股本资金只改变资金归属，不计入收支结余。</span>' +
      '</div>' +
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">账户互转笔数</div><div class="value">' + transfers.length + '</div></div>' +
        '<div class="stat"><div class="label">账户互转金额</div><div class="value">' + FW.fmtMoney(transferSum) + '</div></div>' +
        '<div class="stat"><div class="label">股本注入</div><div class="value income">' + FW.fmtMoney(eqIn) + '</div></div>' +
        '<div class="stat"><div class="label">股本抽回</div><div class="value expense">' + FW.fmtMoney(eqOut) + '</div></div>' +
        '<div class="stat"><div class="label">股本资金净变动</div><div class="value ' + ((eqIn - eqOut) >= 0 ? 'income' : 'expense') + '">' + FW.fmtMoney(eqIn - eqOut) + '</div></div>' +
      '</div>' +
      '<div class="card" style="margin-bottom:18px"><h3>各账户资金净变动 <span class="sub">仅含互转与股本，不含收支</span></h3>' +
        (acctKeys.length ? '<table><thead><tr><th>账户</th><th class="num">净变动</th></tr></thead><tbody>' + acctTrs + '</tbody></table>' : '<div class="empty">暂无资金变动记录</div>') +
      '</div>' +
      '<div class="card"><h3>资金变动明细 <span class="sub">账户互转 / 股本资金，不影响收支</span></h3>' +
        (rows.length ? '<table><thead><tr><th>日期</th><th>类型</th><th>项目</th><th>资金流向</th><th class="num">金额</th><th>备注</th><th>操作</th></tr></thead><tbody>' + trs + '</tbody></table>' : '<div class="empty">暂无账户互转或股本资金记录。可在「流水明细」中点「新增流水」选择对应类型登记。</div>') +
      '</div>';
    document.getElementById('inBody').innerHTML = html;
    document.getElementById('fundType').value = fType;
    document.getElementById('fundType').onchange = function () { state.fundType = this.value; drawFund(); };
    FW.qa('#inBody .fund-del').forEach(function (b) { b.onclick = function () { delTx(b.dataset.id); }; });
  }

  function statTableRows(map, fmtKey) {
    var keys = Object.keys(map).sort(function (a, b) { return (map[b].income + map[b].expense) - (map[a].income + map[a].expense); });
    if (!keys.length) return '<div class="empty">暂无数据</div>';
    var trs = keys.map(function (k) {
      var v = map[k];
      return '<tr><td>' + FW.esc(k) + '</td><td class="num income">' + FW.fmtMoney(v.income) + '</td><td class="num expense">' + FW.fmtMoney(v.expense) + '</td><td class="num"><b>' + FW.fmtMoney(v.income - v.expense) + '</b></td></tr>';
    }).join('');
    return '<table><thead><tr><th>' + fmtKey + '</th><th class="num">收入</th><th class="num">支出</th><th class="num">净额</th></tr></thead><tbody>' + trs + '</tbody></table>';
  }

  function drawStatTable(s, byProj, byMonth, byDay, byCat, byAcc) {
    var el = document.getElementById('statTable');
    if (s === 'proj') el.innerHTML = statTableRows(byProj, '项目');
    else if (s === 'month') el.innerHTML = statTableRows(byMonth, '月份');
    else if (s === 'day') el.innerHTML = statTableRows(byDay, '日期');
    else if (s === 'catacc') {
      el.innerHTML = '<h4 style="margin:4px 0 8px">按分类</h4>' + statTableRows(byCat, '分类') +
        '<h4 style="margin:18px 0 8px">按账户</h4>' + statTableRows(byAcc, '账户');
    }
  }

  /* ---------- 分类 / 账户 辅助 ---------- */
  function accOpts(sel) {
    return ACCTS.map(function (a) { return '<option ' + (a === sel ? 'selected' : '') + '>' + a + '</option>'; }).join('');
  }
  function cat1Opts(sel) {
    return '<option value="">（不选）</option>' + cats().map(function (c) { return '<option ' + (c.name === sel ? 'selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('');
  }
  function cat2Opts(c1, sel) {
    var c = null; cats().forEach(function (x) { if (x.name === c1) c = x; });
    var kids = c ? (c.children || []) : [];
    return '<option value="">（无二级）</option>' + kids.map(function (k) { return '<option ' + (k === sel ? 'selected' : '') + '>' + FW.esc(k) + '</option>'; }).join('');
  }

  // 依据类型动态渲染分类/账户区域
  function renderDyn(type, v) {
    var el = document.getElementById('dynArea');
    if (type === 'transfer') {
      el.innerHTML =
        '<div class="field"><label>源账户</label><select id="f_from">' + accOpts(v.fromAccount) + '</select></div>' +
        '<div class="field"><label>目标账户</label><select id="f_to">' + accOpts(v.toAccount) + '</select></div>';
    } else if (type === 'equity') {
      el.innerHTML =
        '<div class="field"><label>方向</label><select id="f_edir"><option value="in" ' + (v.equityDir !== 'out' ? 'selected' : '') + '>股本注入（增加）</option><option value="out" ' + (v.equityDir === 'out' ? 'selected' : '') + '>股本抽回（减少）</option></select></div>' +
        '<div class="field"><label>账户</label><select id="f_account">' + accOpts(v.account) + '</select></div>';
    } else {
      var c1 = v.cat1 || '', c2 = v.cat2 || '';
      el.innerHTML =
        '<div class="field"><label>分类（一级）</label><select id="f_cat1">' + cat1Opts(c1) + '</select></div>' +
        '<div class="field"><label>分类（二级）</label><select id="f_cat2">' + cat2Opts(c1, c2) + '</select> <a href="#" id="mgCats" style="font-size:12px;color:var(--primary);align-self:center">管理分类</a></div>' +
        '<div class="field"><label>账户</label><select id="f_account">' + accOpts(v.account) + '</select></div>';
      var c1sel = document.getElementById('f_cat1');
      if (c1sel) c1sel.onchange = function () { document.getElementById('f_cat2').innerHTML = cat2Opts(this.value, ''); };
      var mg = document.getElementById('mgCats');
      if (mg) mg.onclick = function (e) { e.preventDefault(); openCatManager(); };
    }
  }

  /* ---------- 新增 / 编辑 表单 ---------- */
  /* ===================== 批量导入（微信账单 / 表格） ===================== */
  var impPreviewState = null;

  // 简易 CSV 行解析（处理双引号包裹与转义）
  function csvSplit(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  // 文件解码（支持 GBK / UTF-8 / 自动）
  function decodeFile(file, enc, cb) {
    var r = new FileReader();
    r.onload = function () {
      var buf = new Uint8Array(r.result);
      var text;
      try {
        if (enc === 'utf8') text = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
        else if (enc === 'gbk') text = (window.iconv ? window.iconv.decode(buf, 'gbk') : new TextDecoder('gbk').decode(buf));
        else {
          var u = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
          text = ((u.match(/�/g) || []).length === 0) ? u : (window.iconv ? window.iconv.decode(buf, 'gbk') : new TextDecoder('gbk').decode(buf));
        }
      } catch (e) { text = ''; }
      cb(text.replace(/^﻿/, ''));
    };
    r.onerror = function () { cb(''); };
    r.readAsArrayBuffer(file);
  }

  // 解析微信支付账单（用于个人对账的 CSV，GBK）
  function parseWeChatBill(text) {
    var lines = text.split(/\r?\n/);
    var headerIdx = -1, header = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('交易时间') > -1 && lines[i].indexOf('收/支') > -1) { headerIdx = i; header = csvSplit(lines[i]); break; }
    }
    if (headerIdx < 0) return { ok: false, msg: '未识别到微信账单表头，请确认导出的是「用于个人对账」的 CSV 文件。', rows: [], skipped: 0 };
    function col(name) { for (var k = 0; k < header.length; k++) if (header[k].indexOf(name) > -1) return k; return -1; }
    var cTime = col('交易时间'), cParty = col('交易对方'), cGoods = col('商品'),
        cInout = col('收/支'), cAmt = col('金额'), cPay = col('支付方式'), cStatus = col('当前状态'), cNote = col('备注');
    var rows = [], skipped = 0;
    for (var j = headerIdx + 1; j < lines.length; j++) {
      var ln = lines[j].trim();
      if (!ln) continue;
      var f = csvSplit(ln);
      var inout = (f[cInout] || '').trim();
      var status = (f[cStatus] || '').trim();
      if (inout === '不计收支') { skipped++; continue; }                 // 零钱提现/充值等
      if (/退还|退款/.test(status) && !/已收钱|已转账/.test(status)) { skipped++; continue; }
      if (inout !== '收入' && inout !== '支出') { skipped++; continue; }
      var amt = parseFloat((f[cAmt] || '').replace(/[￥¥\s,]/g, ''));
      if (isNaN(amt)) { skipped++; continue; }
      var dt = (f[cTime] || '').slice(0, 10);
      var party = (f[cParty] || '').trim();
      var goods = (f[cGoods] || '').trim();
      var note = (f[cNote] || '').trim();
      var remark = goods + (note ? (goods ? ' · ' : '') + note : '');
      var pay = (f[cPay] || '').trim();
      var account = /银行卡|信用卡/.test(pay) ? '银行卡' : '微信';
      rows.push({ date: dt, type: inout === '收入' ? 'income' : 'expense', amount: amt, project: party, remark: remark, account: account, _status: status, _inout: inout });
    }
    return { ok: true, rows: rows, skipped: skipped };
  }

  // 自动猜测表格列映射
  function guessMap(headers) {
    function find(words) {
      for (var i = 0; i < headers.length; i++) {
        var h = (headers[i] || '').toLowerCase();
        for (var w = 0; w < words.length; w++) if (h.indexOf(words[w]) > -1) return i;
      }
      return -1;
    }
    var dateCol = find(['日期', '时间', 'date']);
    var amountCol = find(['金额', '钱', 'amount', '数额']);
    var typeCol = find(['收/支', '收支', '类型', '方向', 'type']);
    var partyCol = find(['对方', '商户', '姓名', '客户', '名称', '付款方', '收款方']);
    var remarkCol = find(['备注', '摘要', '说明', '用途', '商品']);
    return { hasHeader: true, dateCol: dateCol < 0 ? 0 : dateCol, amountCol: amountCol < 0 ? 1 : amountCol, typeCol: typeCol, partyCol: partyCol, remarkCol: remarkCol, signMode: typeCol < 0 ? 'neg' : 'col' };
  }

  // 解析通用表格 CSV
  function parseGenericCsv(text, map) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var startRow = map.hasHeader ? 1 : 0;
    var rows = [], skipped = 0;
    function normDate(s) {
      s = (s || '').trim();
      var m = s.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
      if (m) { var y = m[1], mo = m[2], d = m[3]; return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (d < 10 ? '0' + d : d); }
      return '';
    }
    for (var j = startRow; j < lines.length; j++) {
      var f = csvSplit(lines[j]);
      var amt = parseFloat((f[map.amountCol] || '').replace(/[￥¥\s,]/g, ''));
      if (isNaN(amt)) { skipped++; continue; }
      var type = 'expense';
      if (map.signMode === 'neg') { type = amt < 0 ? 'expense' : 'income'; if (amt < 0) amt = -amt; }
      else {
        var tv = (map.typeCol > -1 ? (f[map.typeCol] || '') : '').trim();
        if (/收|入|贷/.test(tv) && !/支|出/.test(tv)) type = 'income';
        else if (/支|出|付|借/.test(tv)) type = 'expense';
        else type = amt < 0 ? 'expense' : 'income';
        if (amt < 0) amt = -amt;
      }
      var dt = normDate(f[map.dateCol]);
      if (!dt) { skipped++; continue; }
      rows.push({ date: dt, type: type, amount: amt, project: (map.partyCol > -1 ? (f[map.partyCol] || '').trim() : ''), remark: (map.remarkCol > -1 ? (f[map.remarkCol] || '').trim() : ''), account: '微信', _raw: f });
    }
    return { ok: true, rows: rows, skipped: skipped };
  }

  // 把解析结果写入内账
  function doImportRows(rows) {
    var n = 0;
    rows.forEach(function (r) {
      var rec = {
        id: FW.db.uid('t_'), date: r.date, type: r.type, project: r.project || '',
        amount: Number(r.amount), remark: r.remark || '', photos: [],
        category: '', account: r.account || '微信', fromAccount: '', toAccount: '', equityDir: 'in'
      };
      FW.db.upsert(KEY, rec); n++;
    });
    return n;
  }

  // 导入预览弹窗（勾选后确认）
  function openImportPreview(rows, skipped, mode) {
    impPreviewState = { rows: rows, chosen: rows.map(function () { return true; }) };
    var s = impPreviewState;
    function renderPreview() {
      var trs = s.rows.map(function (r, i) {
        var cls = r.type === 'income' ? 'income' : 'expense';
        return '<tr>' +
          '<td><input type="checkbox" class="pc" data-i="' + i + '" ' + (s.chosen[i] ? 'checked' : '') + '></td>' +
          '<td>' + FW.esc(r.date) + '</td>' +
          '<td class="' + cls + '">' + (r.type === 'income' ? '收入' : '支出') + '</td>' +
          '<td class="num ' + cls + '">' + FW.fmtMoney(r.amount) + '</td>' +
          '<td>' + FW.esc(r.project || '—') + '</td>' +
          '<td>' + FW.esc(r.remark || '—') + '</td>' +
          '<td>' + FW.esc(r.account || '—') + '</td>' +
        '</tr>';
      }).join('');
      var cnt = s.chosen.filter(Boolean).length;
      var body =
        '<div class="muted" style="font-size:12px;margin-bottom:8px">共解析 <b>' + s.rows.length + '</b> 笔' + (skipped ? '，跳过 ' + skipped + ' 笔（退款 / 不计收支 / 无法识别）' : '') + '。勾选要导入的，取消的将被忽略。</div>' +
        '<div style="max-height:46vh;overflow:auto"><table id="impPrevTable"><thead><tr><th><input type="checkbox" id="impAll" checked></th><th>日期</th><th>类型</th><th class="num">金额</th><th>对方/项目</th><th>备注</th><th>账户</th></tr></thead><tbody>' + trs + '</tbody></table></div>' +
        '<div class="form-actions"><button class="btn ghost" id="impPrevCancel">取消</button><button class="btn" id="impDo">确认导入 <span id="impCnt">' + cnt + '</span> 笔</button></div>';
      FW.openModal('确认导入', body, function () {
        FW.qa('#impPrevTable .pc').forEach(function (cb) {
          cb.onchange = function () { s.chosen[+cb.dataset.i] = cb.checked; document.getElementById('impCnt').textContent = s.chosen.filter(Boolean).length; document.getElementById('impAll').checked = s.chosen.every(Boolean); };
        });
        document.getElementById('impAll').onchange = function () { var v = this.checked; FW.qa('#impPrevTable .pc').forEach(function (cb) { cb.checked = v; s.chosen[+cb.dataset.i] = v; }); document.getElementById('impCnt').textContent = s.chosen.filter(Boolean).length; };
        document.getElementById('impPrevCancel').onclick = FW.closeModal;
        document.getElementById('impDo').onclick = function () {
          var sel = s.rows.filter(function (r, i) { return s.chosen[i]; });
          if (!sel.length) { FW.toast('请至少选择一笔'); return; }
          var n = doImportRows(sel);
          FW.closeModal(); render(); FW.toast('已导入 ' + n + ' 笔流水');
        };
      });
    }
    renderPreview();
  }

  // 导入入口弹窗
  function openImport() {
    var body =
      '<div class="field"><label>导入方式</label><div class="seg">' +
        '<button type="button" class="seg-btn active" data-m="wechat">微信账单</button>' +
        '<button type="button" class="seg-btn" data-m="table">表格导入</button>' +
      '</div></div>' +
      '<div class="field"><label>选择文件（CSV）</label><input type="file" id="impFile" accept=".csv,text/csv"></div>' +
      '<div class="field"><label>编码</label><select id="impEnc"><option value="auto">自动（推荐）</option><option value="gbk">GBK（微信 / 老 Excel）</option><option value="utf8">UTF-8</option></select></div>' +
      '<div class="muted" style="font-size:12px;margin-top:6px" id="impTip">微信账单：在微信「服务通知 / 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账」导出 CSV（GBK）。表格导入：从 Excel 复制或另存为 CSV。</div>' +
      '<div class="form-actions"><button class="btn ghost" id="impCancel">取消</button><button class="btn" id="impParse">解析并预览</button></div>';
    FW.openModal('批量导入流水', body, function () {
      var mode = 'wechat';
      var segs = FW.qa('.seg-btn');
      segs.forEach(function (b) {
        b.onclick = function () {
          mode = b.dataset.m;
          segs.forEach(function (x) { x.classList.toggle('active', x === b); });
          document.getElementById('impTip').textContent = mode === 'wechat'
            ? '微信账单：在微信「服务通知 / 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账」导出 CSV（GBK）。'
            : '表格导入：从 Excel 复制或另存为 CSV，系统会自动识别日期 / 金额 / 收支列。';
        };
      });
      document.getElementById('impCancel').onclick = FW.closeModal;
      document.getElementById('impParse').onclick = function () {
        var file = document.getElementById('impFile').files[0];
        if (!file) { FW.toast('请先选择文件'); return; }
        var enc = document.getElementById('impEnc').value;
        decodeFile(file, enc, function (text) {
          if (!text) { FW.toast('文件读取失败'); return; }
          var res;
          if (mode === 'wechat') {
            res = parseWeChatBill(text);
          } else {
            var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
            var headers = lines.length ? csvSplit(lines[0]) : [];
            var map = guessMap(headers);
            res = parseGenericCsv(text, map);
            if (!res.rows.length && lines.length > 1) res = parseGenericCsv(text, Object.assign({}, map, { hasHeader: false }));
          }
          if (res.ok === false) { FW.toast(res.msg); return; }
          if (!res.rows.length) { FW.toast('没有可导入的记录（跳过 ' + res.skipped + ' 行）'); return; }
          FW.closeModal();
          openImportPreview(res.rows, res.skipped, mode);
        });
      };
    });
  }

  FW.internalImport = { parseWeChatBill: parseWeChatBill, parseGenericCsv: parseGenericCsv, csvSplit: csvSplit, guessMap: guessMap };

  function openForm(id) {
    var edit = id ? FW.db.getById(KEY, id) : null;
    var projList = projects().map(function (p) { return '<option>' + FW.esc(p) + '</option>'; }).join('');
    var v = { date: FW.today(), type: 'expense', cat1: DEFAULT_CATS[0], cat2: '', account: ACCTS[0], amount: '', remark: '', project: '', photos: [],
      fromAccount: ACCTS[0], toAccount: ACCTS[1] || ACCTS[0], equityDir: 'in' };
    if (edit) {
      v = { date: edit.date || FW.today(), type: edit.type || 'expense', cat1: '', cat2: '', account: edit.account || ACCTS[0],
        amount: edit.amount, remark: edit.remark || '', project: edit.project || '', photos: edit.photos || [],
        fromAccount: ACCTS[0], toAccount: ACCTS[1] || ACCTS[0], equityDir: 'in' };
      if (edit.category) { var parts = edit.category.split(' / '); v.cat1 = parts[0]; v.cat2 = parts[1] || ''; }
      if (edit.type === 'transfer') { v.fromAccount = edit.fromAccount || ACCTS[0]; v.toAccount = edit.toAccount || (ACCTS[1] || ACCTS[0]); }
      if (edit.type === 'equity') { v.equityDir = edit.equityDir || 'in'; }
    }
    var photos = (edit && edit.photos) ? edit.photos.slice() : [];
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>日期</label><input id="f_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>类型</label><select id="f_type">' +
          '<option value="expense" ' + (v.type === 'expense' ? 'selected' : '') + '>支出</option>' +
          '<option value="income" ' + (v.type === 'income' ? 'selected' : '') + '>收入</option>' +
          '<option value="transfer" ' + (v.type === 'transfer' ? 'selected' : '') + '>账户互转（不影响收支）</option>' +
          '<option value="equity" ' + (v.type === 'equity' ? 'selected' : '') + '>股本资金（不影响收支）</option>' +
        '</select></div>' +
        '<div class="field"><label>项目</label><input id="f_project" list="projList" value="' + FW.esc(v.project) + '" placeholder="如：XX项目"><datalist id="projList">' + projList + '</datalist></div>' +
        '<div id="dynArea"></div>' +
        '<div class="field"><label>金额（元）</label><input id="f_amount" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
        '<div class="field full"><label>备注</label><textarea id="f_remark" rows="2" placeholder="用途说明">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>收付款凭证照片</label><div class="muted" style="font-size:12px;margin-bottom:4px">可点「＋」选择，也可直接 <b>Ctrl+V 粘贴</b> 或把图片拖到下方</div><div class="photo-grid" id="photoGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="txCancel">取消</button><button class="btn" id="txSave">保存</button></div>';

    FW.openModal(edit ? '编辑流水' : '新增流水', body, function () {
      var typeSel = document.getElementById('f_type');
      renderDyn(typeSel.value, v);
      typeSel.onchange = function () { renderDyn(this.value, v); };
      renderPhotoGrid(photos);
      var unbind = bindPaste(photos);
      document.getElementById('txCancel').onclick = function () { unbind(); FW.closeModal(); };
      document.getElementById('txSave').onclick = function () {
        var amount = parseFloat(document.getElementById('f_amount').value);
        if (!(amount >= 0) || isNaN(amount)) { FW.toast('请输入有效金额'); return; }
        var type = document.getElementById('f_type').value;
        var rec = {
          id: edit ? edit.id : FW.db.uid('t_'),
          date: document.getElementById('f_date').value || FW.today(),
          type: type,
          project: document.getElementById('f_project').value.trim(),
          amount: amount,
          remark: document.getElementById('f_remark').value.trim(),
          photos: photos,
          category: '', account: '', fromAccount: '', toAccount: '', equityDir: 'in'
        };
        if (type === 'income' || type === 'expense') {
          var c1 = document.getElementById('f_cat1').value;
          var c2 = document.getElementById('f_cat2').value;
          rec.category = c1 ? (c2 ? c1 + ' / ' + c2 : c1) : '';
          rec.account = document.getElementById('f_account').value;
        } else if (type === 'transfer') {
          rec.fromAccount = document.getElementById('f_from').value;
          rec.toAccount = document.getElementById('f_to').value;
          rec.account = rec.fromAccount + ' → ' + rec.toAccount;
        } else if (type === 'equity') {
          rec.equityDir = document.getElementById('f_edir').value;
          rec.account = document.getElementById('f_account').value;
        }
        unbind();
        FW.db.upsert(KEY, rec);
        FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  // 粘贴剪贴板图片（Ctrl+V）
  function bindPaste(photos) {
    var mask = document.getElementById('modalMask');
    if (!mask) return function () {};
    function onPaste(e) {
      var cd = e.clipboardData || (global.clipboardData);
      if (!cd || !cd.items) return;
      var handled = false;
      Array.prototype.forEach.call(cd.items, function (it) {
        if (it.type && it.type.indexOf('image') === 0) {
          var file = it.getAsFile();
          if (file) {
            handled = true;
            var r = new FileReader();
            r.onload = function () { FW.db.savePhoto(r.result).then(function (id) { photos.push(id); renderPhotoGrid(photos); }).catch(function () {}); };
            r.readAsDataURL(file);
          }
        }
      });
      if (handled) e.preventDefault();
    }
    mask.addEventListener('paste', onPaste);
    return function () { mask.removeEventListener('paste', onPaste); };
  }

  function renderPhotoGrid(photos) {
    var grid = document.getElementById('photoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    photos.forEach(function (pid) {
      var wrap = document.createElement('div');
      wrap.style.position = 'relative';
      var img = document.createElement('img');
      img.className = 'photo-thumb'; img.dataset.load = pid;
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderPhotoGrid(photos); };
      img.onclick = function () { previewPhoto(pid); };
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div');
    add.className = 'photo-add'; add.textContent = '＋';
    add.title = '上传凭证照片';
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
    // 拖拽图片
    grid.ondragover = function (e) { e.preventDefault(); grid.classList.add('drag'); };
    grid.ondragleave = function () { grid.classList.remove('drag'); };
    grid.ondrop = function (e) {
      e.preventDefault(); grid.classList.remove('drag');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) addFiles(files, photos);
    };
  }

  function addFiles(fileList, photos) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) { return f.type.indexOf('image') === 0; });
    if (!files.length) return;
    var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
    Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderPhotoGrid(photos); });
  }

  /* ---------- 用途分类管理（支持拖拽排序） ---------- */
  function moveInArray(arr, from, to) {
    if (to < 0 || to >= arr.length || from < 0 || from >= arr.length || from === to) return false;
    var x = arr.splice(from, 1)[0];
    arr.splice(to, 0, x);
    return true;
  }
  function openCatManager() {
    var dragState = null; // { type:'l1'|'l2', pi, from }
    function delCat1(i) {
      var l = cats(); var name = l[i].name;
      var used = FW.db.getList(KEY).some(function (t) { return cat1Name(t) === name; });
      if (used && !confirm('「' + name + '」下已有流水记录，删除后该分类将显示为空白，仍要删除？')) return;
      l.splice(i, 1); FW.db.saveList(CATKEY, l); render();
    }
    function addCat2(i) {
      var n = prompt('输入二级分类名称：'); if (!n) return; n = n.trim();
      var l = cats(); var c = l[i];
      if ((c.children || []).indexOf(n) >= 0) { FW.toast('已存在该二级分类'); return; }
      c.children = c.children || []; c.children.push(n); FW.db.saveList(CATKEY, l); render();
    }
    function delCat2(i, j) {
      var l = cats(); l[i].children.splice(j, 1); FW.db.saveList(CATKEY, l); render();
    }
    function render() {
      var list = cats();
      var rows = list.map(function (c, i) {
        var kids = (c.children || []).map(function (k, j) {
          return '<div class="cat-l2" draggable="true" data-i="' + i + '" data-j="' + j + '">' +
            '<span class="drag-h" draggable="false">⇕</span><span>↳ ' + FW.esc(k) + '</span>' +
            '<button class="btn danger sm cat-l2-del" data-i="' + i + '" data-j="' + j + '">删</button></div>';
        }).join('');
        return '<div class="cat-l1" draggable="true" data-i="' + i + '">' +
          '<div class="cat-l1-head"><span class="drag-h" draggable="false">⇕</span><b>' + FW.esc(c.name) + '</b>' +
          '<span class="cat-ops"><button class="btn ghost sm cat-l2-add" data-i="' + i + '">＋二级</button><button class="btn danger sm cat-l1-del" data-i="' + i + '">删</button></span></div>' +
          (kids || '<div class="muted" style="font-size:12px">（暂无二级分类）</div>') + '</div>';
      }).join('');
      var body = '<div class="cat-hint muted">提示：拖动左侧 ⇕ 手柄可调整分类顺序，顺序将被保存。</div>' +
        '<div class="cat-mgr">' + rows + '</div>' +
        '<div class="field" style="margin-top:12px"><label>新增一级分类</label><input id="newCat1" placeholder="如：通讯费"><button class="btn" id="addCat1" style="margin-left:8px">添加</button></div>' +
        '<div class="form-actions"><button class="btn ghost" id="cmClose">关闭</button></div>';
      FW.openModal('管理用途分类（一级 / 二级 · 可拖拽排序）', body, function () {
        FW.qa('#modalBody .cat-l1-del').forEach(function (b) { b.onclick = function () { delCat1(parseInt(b.dataset.i, 10)); }; });
        FW.qa('#modalBody .cat-l2-add').forEach(function (b) { b.onclick = function () { addCat2(parseInt(b.dataset.i, 10)); }; });
        FW.qa('#modalBody .cat-l2-del').forEach(function (b) { b.onclick = function () { delCat2(parseInt(b.dataset.i, 10), parseInt(b.dataset.j, 10)); }; });
        document.getElementById('addCat1').onclick = function () {
          var n = document.getElementById('newCat1').value.trim();
          if (!n) { FW.toast('请输入名称'); return; }
          var l = cats();
          if (l.some(function (x) { return x.name === n; })) { FW.toast('已存在该一级分类'); return; }
          l.push({ name: n, children: [] }); FW.db.saveList(CATKEY, l); render();
        };
        document.getElementById('cmClose').onclick = FW.closeModal;

        // 一级分类拖拽
        FW.qa('#modalBody .cat-l1').forEach(function (el) {
          var i = parseInt(el.dataset.i, 10);
          el.ondragstart = function (e) { dragState = { type: 'l1', from: i }; e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); };
          el.ondragend = function () { el.classList.remove('dragging'); FW.qa('#modalBody .cat-l1,#modalBody .cat-l2').forEach(function (x) { x.classList.remove('dragging'); }); };
          el.ondragover = function (e) { e.preventDefault(); el.classList.add('drop-over'); };
          el.ondragleave = function () { el.classList.remove('drop-over'); };
          el.ondrop = function (e) {
            e.preventDefault(); el.classList.remove('drop-over');
            if (dragState && dragState.type === 'l1') {
              var l = cats();
              if (moveInArray(l, dragState.from, i)) { FW.db.saveList(CATKEY, l); render(); }
              dragState = null;
            }
          };
        });
        // 二级分类拖拽（支持跨一级移动）
        FW.qa('#modalBody .cat-l2').forEach(function (el) {
          var i = parseInt(el.dataset.i, 10), j = parseInt(el.dataset.j, 10);
          el.ondragstart = function (e) { e.stopPropagation(); dragState = { type: 'l2', pi: i, from: j }; el.classList.add('dragging'); };
          el.ondragover = function (e) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop-over'); };
          el.ondragleave = function () { el.classList.remove('drop-over'); };
          el.ondrop = function (e) {
            e.preventDefault(); el.classList.remove('drop-over');
            if (dragState && dragState.type === 'l2') {
              e.stopPropagation();
              var l = cats();
              var item = l[dragState.pi].children.splice(dragState.from, 1)[0];
              l[i].children = l[i].children || [];
              l[i].children.splice(j, 0, item);
              FW.db.saveList(CATKEY, l); render();
              dragState = null;
            }
          };
        });
      });
    }
    render();
  }

  function previewPhoto(pid) {
    FW.db.getPhoto(pid).then(function (d) {
      if (!d) { FW.toast('照片读取失败'); return; }
      FW.openModal('凭证照片', '<div style="text-align:center"><img src="' + d + '" style="max-width:100%;border-radius:8px"></div>');
    }).catch(function () { FW.toast('照片读取失败'); });
  }

  function delTx(id) {
    var rec = FW.db.getById(KEY, id);
    if (!rec) return;
    if (!confirm('确定删除该笔流水？' + (rec.photos && rec.photos.length ? '（将同时删除 ' + rec.photos.length + ' 张凭证照片）' : ''))) return;
    FW.db.remove(KEY, id);
    if (rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
    render(); FW.toast('已删除');
  }

  function exportTable() {
    var rows = filteredRows();
    if (!rows.length) { FW.toast('没有可导出的流水'); return; }
    function typeLabel(t) {
      if (t.type === 'income') return '收入';
      if (t.type === 'expense') return '支出';
      if (t.type === 'transfer') return '账户互转';
      if (t.type === 'equity') return (t.equityDir === 'out' ? '股本抽回' : '股本注入');
      return t.type || '';
    }
    var head = ['日期', '类型', '项目', '分类', '账户', '金额', '备注', '凭证数', '是否影响收支'];
    var data = rows.map(function (t) {
      return [t.date, typeLabel(t), t.project || '', t.category || '', t.account || '', t.amount, (t.remark || '').replace(/[\r\n]+/g, ' '), (t.photos ? t.photos.length : 0), (t.type === 'income' || t.type === 'expense') ? '是' : '否'];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '内账流水_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 笔流水（CSV）');
  }

  /* ---------- 预算横幅 ---------- */
  function budgetBannerHtml() {
    var month = FW.today().slice(0, 7);
    var b = getBudget(month);
    if (!b) {
      return '<div class="card budget-card" style="margin-bottom:14px">本月（' + month + '）尚未设置预算，<a href="#" id="goBudget" style="color:var(--primary)">点击设置</a>，超支会及时提醒。</div>';
    }
    var exp = monthExpense(month);
    var total = Number(b.total) || 0;
    var pct = total > 0 ? (exp / total * 100) : 0;
    var over = pct > 100;
    var barColor = over ? '#e63946' : (pct > 80 ? '#f0a020' : '#1f9d55');
    return '<div class="card budget-card" style="margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<span>本月预算使用 <b style="color:' + (over ? 'var(--income)' : 'var(--expense)') + '">' + pct.toFixed(0) + '%</b></span>' +
        '<span class="muted">支出 ' + FW.fmtMoney(exp) + ' / 预算 ' + FW.fmtMoney(total) + (over ? ' <span class="tag expense">已超支 ' + FW.fmtMoney(exp - total) + '</span>' : '') + '</span>' +
      '</div>' +
      '<div class="budget-bar"><div class="budget-fill" style="width:' + Math.min(pct, 100).toFixed(0) + '%;background:' + barColor + '"></div></div>' +
    '</div>';
  }

  /* ---------- 设置预算 ---------- */
  function openBudgetForm() {
    var month = FW.today().slice(0, 7);
    var cur = getBudget(month) || { month: month, total: '', cats: {} };
    var catRows = cats().map(function (c) {
      return '<div class="bud-row"><span>' + FW.esc(c.name) + '</span><input type="number" step="0.01" min="0" data-cat="' + FW.esc(c.name) + '" value="' + (cur.cats && cur.cats[c.name] != null ? cur.cats[c.name] : '') + '" placeholder="0"></div>';
    }).join('');
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>预算月份</label><input id="b_month" value="' + month + '" type="month"></div>' +
        '<div class="field"><label>月度总预算（元）</label><input id="b_total" type="number" step="0.01" min="0" value="' + FW.esc(cur.total) + '"></div>' +
        '<div class="field full"><label>分类预算（可选，留空表示不限制该类）</label><div class="bud-grid">' + catRows + '</div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="bCancel">取消</button><button class="btn" id="bSave">保存预算</button></div>';
    FW.openModal('设置预算', body, function () {
      document.getElementById('bCancel').onclick = FW.closeModal;
      document.getElementById('bSave').onclick = function () {
        var m = document.getElementById('b_month').value || month;
        var total = document.getElementById('b_total').value;
        var cats = {};
        FW.qa('#modalBody [data-cat]').forEach(function (inp) { var v = parseFloat(inp.value); if (v > 0) cats[inp.dataset.cat] = v; });
        var rec = { id: (cur.id || FW.db.uid('b_')), month: m, total: total === '' ? '' : Number(total), cats: cats };
        var list = FW.db.getList(BKEY).filter(function (x) { return x.month !== m; });
        list.push(rec); FW.db.saveList(BKEY, list);
        FW.closeModal(); render(); FW.toast('预算已保存（' + m + '）');
      };
    });
  }

  /* ---------- 收支日历 ---------- */
  function drawCalendar() {
    var now = new Date();
    if (!state.calMonth) state.calMonth = now.getFullYear() + '-' + pad(now.getMonth() + 1);
    var ym = state.calMonth;
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    var first = new Date(y, m, 1).getDay();
    var days = lastDay(y, m);
    var todayStr = FW.today();
    var dayMap = {};
    all().forEach(function (t) {
      if (!t.date || t.date.slice(0, 7) !== ym) return;
      if (t.type !== 'income' && t.type !== 'expense') return;
      if (!dayMap[t.date]) dayMap[t.date] = { inc: 0, exp: 0 };
      if (t.type === 'income') dayMap[t.date].inc += +t.amount; else dayMap[t.date].exp += +t.amount;
    });
    var weekNames = ['日', '一', '二', '三', '四', '五', '六'];
    var head = '<div class="cal-head"><button class="btn ghost sm" id="calPrev">‹</button><span id="calTitle">' + y + '年 ' + (m + 1) + '月</span><button class="btn ghost sm" id="calNext">›</button><button class="btn ghost sm" id="calToday">今天</button></div>';
    var week = '<div class="cal-grid cal-week">' + weekNames.map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>';
    var grid = '<div class="cal-grid">';
    for (var i = 0; i < first; i++) grid += '<div class="cal-cell empty"></div>';
    for (var d = 1; d <= days; d++) {
      var ds = ym + '-' + (d < 10 ? '0' + d : d);
      var dm = dayMap[ds] || { inc: 0, exp: 0 };
      var net = dm.inc - dm.exp;
      var has = (dm.inc + dm.exp) > 0;
      var cls = 'cal-cell' + (ds === todayStr ? ' today' : '') + (state.calSel === ds ? ' sel' : '') + (has ? ' has' : '');
      grid += '<div class="' + cls + '" data-d="' + ds + '">' +
        '<div class="cal-d">' + d + '</div>' +
        (has ? '<div class="cal-net ' + (net >= 0 ? 'pos' : 'neg') + '">' + (net >= 0 ? '+' : '') + FW.shortMoney(net) + '</div>' : '') +
        '</div>';
    }
    grid += '</div>';
    document.getElementById('inBody').innerHTML = head + week + grid + '<div class="cal-legend muted">点击某天 → 查看当天流水明细</div>';
    document.getElementById('calPrev').onclick = function () { state.calMonth = shiftMonth(ym, -1); state.calSel = ''; drawCalendar(); };
    document.getElementById('calNext').onclick = function () { state.calMonth = shiftMonth(ym, 1); state.calSel = ''; drawCalendar(); };
    document.getElementById('calToday').onclick = function () { state.calMonth = now.getFullYear() + '-' + pad(now.getMonth() + 1); state.calSel = ''; drawCalendar(); };
    FW.qa('#inBody .cal-cell[data-d]').forEach(function (c) {
      c.onclick = function () {
        var day = c.dataset.d;
        state.tab = 'list';
        state.filter = { project: '', category: '', account: '', type: '', kw: '', from: day, to: day };
        render();
      };
    });
  }

  FW.modules = FW.modules || {};
  FW.modules.internal = {
    title: '登记内账',
    render: function () { render(); loadThumbs(); },
    onShow: function () { render(); loadThumbs(); },
    // 供测试 / 编程调用：分类拖拽排序的核心逻辑
    reorderCat: function (from, to) { var l = cats(); if (moveInArray(l, from, to)) { FW.db.saveList(CATKEY, l); return true; } return false; },
    reorderSubCat: function (pi, from, j) {
      var l = cats(); if (!l[pi]) return false;
      var item = (l[pi].children || []).splice(from, 1)[0]; if (item == null) return false;
      l[pi].children = l[pi].children || []; l[pi].children.splice(j, 0, item);
      FW.db.saveList(CATKEY, l); return true;
    },
    cats: cats
  };
})(window);
