/* 老板月报 / 季报 —— 一键导出给老板看的经营简报（PDF 走浏览器打印） */
(function (global) {
  'use strict';
  var FW = global.FW;

  function list() { return FW.db.getList('internal'); }
  function esc(s) { return FW.esc(s == null ? '' : String(s)); }
  function fmt(n) { return FW.fmtMoney(n); }

  function monthsList() {
    var a = [], d = new Date();
    for (var i = 0; i < 12; i++) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); a.push(x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2)); }
    return a;
  }
  function quartersList() {
    var a = [], d = new Date();
    for (var i = 0; i < 8; i++) { var x = new Date(d.getFullYear(), d.getMonth() - i * 3, 1); var q = Math.floor(x.getMonth() / 3) + 1; a.push(x.getFullYear() + '-' + q); }
    return a;
  }
  function periodRows(type, val) {
    return list().filter(function (t) {
      if (!t.date) return false;
      if (type === 'month') return t.date.slice(0, 7) === val;
      var y = val.slice(0, 4), q = +val.slice(5);
      var m = +t.date.slice(5, 7);
      return t.date.slice(0, 4) === y && (Math.floor((m - 1) / 3) + 1) === q;
    });
  }
  function sum(rows) {
    var inc = 0, exp = 0, div = 0, rf = 0;
    rows.forEach(function (t) {
      var a = Number(t.amount) || 0;
      if (t.type === 'income') inc += a;
      else if (t.type === 'expense') exp += a;
      else if (t.type === 'refund') { exp -= a; rf += a; }
      else if (t.type === 'dividend') div += a;
    });
    return { inc: inc, exp: exp, net: inc - exp, div: div, rf: rf };
  }
  function projectPnl(rows) {
    var map = {};
    rows.forEach(function (t) {
      var p = t.project || '未分配';
      if (!map[p]) map[p] = { inc: 0, exp: 0 };
      var a = Number(t.amount) || 0;
      if (t.type === 'income') map[p].inc += a;
      else if (t.type === 'expense') map[p].exp += a;
      else if (t.type === 'refund') map[p].exp -= a;
    });
    var arr = Object.keys(map).map(function (p) {
      var inc = map[p].inc, exp = map[p].exp, profit = inc - exp;
      return { project: p, revenue: inc, profit: profit, rate: inc > 0 ? profit / inc * 100 : null };
    });
    arr.sort(function (a, b) { return b.profit - a.profit; });
    return arr;
  }
  function trend() {
    var d = new Date(), months = [];
    for (var i = 5; i >= 0; i--) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); months.push(x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2)); }
    var inc = months.map(function (m) { return { label: m.slice(5) + '月', value: sum(periodRows('month', m)).inc }; });
    var exp = months.map(function (m) { return { label: m.slice(5) + '月', value: sum(periodRows('month', m)).exp }; });
    return FW.lineChart('近 6 个月收支趋势', [{ name: '收入', color: '#e63946', points: inc }, { name: '支出', color: '#1f9d55', points: exp }]);
  }
  function catPie(rows) {
    var map = {};
    rows.forEach(function (t) { if (t.type === 'expense') { var c = t.category || '其他'; map[c] = (map[c] || 0) + (Number(t.amount) || 0); } });
    var items = Object.keys(map).map(function (c) { return { label: c, value: map[c] }; }).sort(function (a, b) { return b.value - a.value; });
    return items.length ? FW.pieChart('支出分类占比', items) : '';
  }
  function projBar(rows) {
    var pnl = projectPnl(rows).filter(function (r) { return r.project !== '未分配'; }).slice(0, 10);
    var items = pnl.map(function (r) { return { label: r.project.length > 6 ? r.project.slice(0, 6) + '…' : r.project, value: r.profit }; });
    return items.length ? FW.barChart('各项目利润（TOP10）', items, { color: '#C9A227' }) : '';
  }
  function collectPhotos(rows, max) {
    var pids = [];
    rows.forEach(function (t) { (t.photos || []).forEach(function (p) { if (p) pids.push(p); }); });
    pids = pids.slice(0, max || 9);
    return Promise.all(pids.map(function (pid) {
      return FW.db.getPhoto(pid).then(function (d) { return d ? { pid: pid, src: d } : null; }).catch(function () { return null; });
    })).then(function (arr) { return arr.filter(Boolean); });
  }

  function kpiCard(label, value, cls) {
    return '<div class="bb-kpi"><div class="bb-kpi-label">' + label + '</div><div class="bb-kpi-value ' + (cls || '') + '">' + value + '</div></div>';
  }

  /* ---------- 经营驾驶舱：项目利润实时看板 + 现金流预测（#3 #4） ---------- */
  // 口径统一：驾驶舱直接复用「项目核算」引擎(FW.projectCostCalc.compute)，
  // 利润 = 收入 − 流水成本 + 应收回款项 − 工资成本（与「项目核算」模块完全一致，消除同项目两个利润数字）。
  function projectBoard() {
    if (FW.projectCostCalc && FW.projectCostCalc.compute) {
      var d = FW.projectCostCalc.compute('all');
      var divMap = {};
      list().forEach(function (t) {
        if (t.type === 'dividend') { var p = (t.project || '').trim() || '未分配'; divMap[p] = (divMap[p] || 0) + (Number(t.amount) || 0); }
      });
      return (d.rows || []).map(function (r) {
        var cost = (r.flowCost || 0) + (r.laborCost || 0); // 成本 = 流水成本 + 工资成本
        return { project: r.project, inc: r.revenue, exp: cost, div: divMap[r.project] || 0, profit: r.profit, net: r.profit - (divMap[r.project] || 0) };
      }).sort(function (a, b) { return b.net - a.net; });
    }
    // 回退（组件未加载时）保持原口径
    var rows = list();
    var map = {};
    rows.forEach(function (t) {
      var p = (t.project || '').trim() || '未分配';
      var a = Number(t.amount) || 0;
      if (!map[p]) map[p] = { inc: 0, exp: 0, div: 0 };
      if (t.type === 'income') map[p].inc += a;
      else if (t.type === 'expense') map[p].exp += a;
      else if (t.type === 'refund') map[p].exp -= a;
      else if (t.type === 'dividend') map[p].div += a;
    });
    return Object.keys(map).map(function (p) {
      var m = map[p], profit = m.inc - m.exp, net = m.inc - m.exp - m.div;
      return { project: p, inc: m.inc, exp: m.exp, div: m.div, profit: profit, net: net };
    }).sort(function (a, b) { return b.net - a.net; });
  }
  function cashflowForecast() {
    var d = new Date(), months = [];
    for (var i = 5; i >= 0; i--) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); months.push(x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2)); }
    var hist = months.map(function (m) { var s = sum(periodRows('month', m)); return { m: m, inc: s.inc, exp: s.exp, net: s.net }; });
    var avgInc = hist.reduce(function (a, h) { return a + h.inc; }, 0) / hist.length;
    var avgExp = hist.reduce(function (a, h) { return a + h.exp; }, 0) / hist.length;
    var avgNet = avgInc - avgExp;
    var cashTotal = 0;
    try { var bd = (FW.internalCalc && FW.internalCalc.accountBreakdown) ? FW.internalCalc.accountBreakdown() : []; cashTotal = bd.reduce(function (a, x) { return a + (x.bal || 0); }, 0); } catch (e) {}
    var fc = [], run = cashTotal;
    for (var k = 1; k <= 3; k++) { var x2 = new Date(d.getFullYear(), d.getMonth() + k, 1); var m2 = x2.getFullYear() + '-' + ('0' + (x2.getMonth() + 1)).slice(-2); run += avgNet; fc.push({ m: m2, inc: avgInc, exp: avgExp, net: avgNet, bal: run }); }
    return { hist: hist, fc: fc, cashTotal: cashTotal, avgNet: avgNet };
  }
  function renderCockpit() {
    var el = document.getElementById('bbCockpit'); if (!el) return;
    var board = projectBoard();
    var cards = board.length ? board.map(function (b) {
      return '<div class="bb-pcard' + (b.net < 0 ? ' neg' : '') + '">' +
        '<div class="bb-pcard-name">' + esc(b.project) + '</div>' +
        '<div class="bb-pcard-row"><span>收入</span><b class="income">' + fmt(b.inc) + '</b></div>' +
        '<div class="bb-pcard-row"><span>成本</span><b class="expense">' + fmt(b.exp) + '</b></div>' +
        '<div class="bb-pcard-row"><span>已分红</span><b>' + fmt(b.div) + '</b></div>' +
        '<div class="bb-pcard-row total"><span>净利润</span><b class="' + (b.net >= 0 ? 'income' : 'expense') + '">' + fmt(b.net) + '</b></div>' +
        '</div>';
    }).join('') : '<div class="empty">还没有项目流水</div>';
    var cf = cashflowForecast();
    var cfRows = cf.fc.map(function (f) {
      return '<tr><td>' + f.m + '</td><td class="num income">' + fmt(f.inc) + '</td><td class="num expense">' + fmt(f.exp) + '</td><td class="num ' + (f.net >= 0 ? 'income' : 'expense') + '">' + fmt(f.net) + '</td><td class="num ' + (f.bal >= 0 ? 'income' : 'expense') + '">' + fmt(f.bal) + '</td></tr>';
    }).join('');
    var histRows = cf.hist.map(function (h) {
      return '<tr><td>' + h.m + '</td><td class="num income">' + fmt(h.inc) + '</td><td class="num expense">' + fmt(h.exp) + '</td><td class="num ' + (h.net >= 0 ? 'income' : 'expense') + '">' + fmt(h.net) + '</td><td class="muted">—</td></tr>';
    }).join('');
    el.innerHTML =
      '<h2 class="bb-h2">经营驾驶舱（实时 · 全部项目）</h2>' +
      '<div class="bb-pcards">' + cards + '</div>' +
      '<h2 class="bb-h2">现金流预测（近 6 月均值外推未来 3 月）</h2>' +
      '<div class="muted" style="font-size:12px;margin:-6px 0 8px">当前资金总额 ' + fmt(cf.cashTotal) + '；月均净额 ' + fmt(cf.avgNet) + '</div>' +
      '<table class="bb-tbl"><thead><tr><th>月份</th><th class="num">预计收入</th><th class="num">预计支出</th><th class="num">预计净额</th><th class="num">预计余额</th></tr></thead><tbody>' + histRows + cfRows + '</tbody></table>';
  }
  /* ---------- 导出图片（PNG，复用 FWTableImg，#2） ---------- */
  function exportImg() {
    var type = document.getElementById('bbType').value;
    var val = document.getElementById('bbVal').value;
    var rep = computeReport(type, val);
    var label = type === 'month' ? (val + ' 月度') : (val.replace('-', ' 年第') + ' 季度');
    var s = rep.s, pnl = rep.pnl;
    var rows = pnl.filter(function (r) { return r.project !== '未分配'; }).map(function (r) {
      return { cells: [r.project, fmt(r.revenue), fmt(r.exp || 0), fmt(r.profit), (r.rate != null && isFinite(r.rate) ? r.rate.toFixed(1) + '%' : '—')], amountCls: r.profit >= 0 ? 'income' : 'expense' };
    });
    if (!rows.length) rows = [{ cells: ['（本期无项目数据）', '', '', '', ''], amountCls: 'neutral' }];
    FWTableImg.render({
      title: '经营简报', subtitle: label + ' · 财务工作台',
      kpis: [
        { label: '收入', value: fmt(s.inc), cls: 'income' },
        { label: '支出', value: fmt(s.exp), cls: 'expense' },
        { label: '结余', value: fmt(s.net), cls: s.net >= 0 ? 'income' : 'expense' },
        { label: '分红', value: fmt(s.div), cls: 'neutral' }
      ],
      head: ['项目', '收入', '支出', '利润', '利润率'],
      rows: rows,
      amountCol: 3
    }).then(function (canvas) { FWTableImg.downloadPNG(canvas, '老板月报_' + val + '.png'); FW.toast('已导出图片'); })
      .catch(function (e) { FW.toast('导出图片失败：' + (e && e.message ? e.message : e)); });
  }
  /* ---------- 报表数据计算（buildPreview / exportImg 共用） ---------- */
  function computeReport(type, val) {
    var rows = periodRows(type, val);
    var s = sum(rows);
    var cumRate = null, cumProfit = 0, cumRev = 0;
    if (FW.projectCostCalc && FW.projectCostCalc.compute) {
      var data = FW.projectCostCalc.compute('all');
      (data.rows || []).forEach(function (r) { cumRev += (r.revenue || 0); cumProfit += (r.profit || 0); });
      if (cumRev > 0) cumRate = cumProfit / cumRev * 100;
    }
    var pnl = projectPnl(rows);
    return { rows: rows, s: s, pnl: pnl, cumRate: cumRate };
  }

  function buildPreview() {
    var c = document.getElementById('bbPreview'); if (!c) return;
    var type = document.getElementById('bbType').value;
    var val = document.getElementById('bbVal').value;
    var label = type === 'month' ? (val + ' 月度') : (val.replace('-', ' 年第') + ' 季度');
    var rep = computeReport(type, val);
    var rows = rep.rows, s = rep.s, pnl = rep.pnl, cumRate = rep.cumRate;

    var kpi =
      '<div class="bb-kpis">' +
        kpiCard('期间收入', fmt(s.inc), 'income') +
        kpiCard('期间支出', fmt(s.exp), 'expense') +
        kpiCard('收支结余', fmt(s.net), s.net >= 0 ? 'income' : 'expense') +
        kpiCard('股东分红', fmt(s.div), 'neutral') +
        (cumRate != null ? kpiCard('累计利润率', cumRate.toFixed(1) + '%', cumRate >= 0 ? 'income' : 'expense') : '') +
      '</div>';

    var pnlRows = pnl.map(function (r) {
      var rate = r.rate != null && isFinite(r.rate) ? r.rate.toFixed(1) + '%' : '—';
      var pcls = r.profit >= 0 ? 'income' : 'expense';
      return '<tr><td>' + esc(r.project) + '</td><td class="num">' + fmt(r.revenue) + '</td><td class="num">' + fmt(r.exp || 0) + '</td><td class="num ' + pcls + '">' + fmt(r.profit) + '</td><td class="num">' + rate + '</td></tr>';
    }).join('');
    if (!pnlRows) pnlRows = '<tr><td colspan="5" class="muted">本期无项目数据</td></tr>';

    c.innerHTML =
      '<div class="bb-cover">' +
        '<div class="bb-cover-brand">财务工作台 · 经营简报</div>' +
        '<h1 class="bb-cover-title">' + (type === 'month' ? '月度经营月报' : '季度经营简报') + '</h1>' +
        '<div class="bb-cover-period">' + label + '</div>' +
        '<div class="bb-cover-date">生成日期：' + new Date().toISOString().slice(0, 10) + '</div>' +
      '</div>' +
      kpi +
      '<h2 class="bb-h2">一、收支概览</h2>' +
      '<div class="bb-charts">' + trend() + catPie(rows) + projBar(rows) + '</div>' +
      '<h2 class="bb-h2">二、各项目盈亏</h2>' +
      '<table class="bb-tbl"><thead><tr><th>项目</th><th class="num">收入</th><th class="num">支出</th><th class="num">利润</th><th class="num">利润率</th></tr></thead><tbody>' + pnlRows + '</tbody></table>' +
      '<div class="muted" style="font-size:12px;margin-top:6px">上表为「本期」收支毛利（收入−支出，未含工资成本/未分配资金）；完整项目核算（含工资成本、应收回款项、下钻明细）见顶部「经营驾驶舱」或「项目核算」模块，口径与此处驾驶舱一致。</div>' +
      '<div id="bbPhotosWrap"><h2 class="bb-h2">三、凭证留痕</h2><div class="bb-photos"><span class="muted">加载中…</span></div></div>';

    collectPhotos(rows, 9).then(function (imgs) {
      var wrap = document.querySelector('#bbPhotosWrap .bb-photos'); if (!wrap) return;
      if (!imgs.length) { wrap.innerHTML = '<span class="muted">本期无凭证图片</span>'; return; }
      wrap.innerHTML = imgs.map(function (im) { return '<div class="bb-photo"><img src="' + im.src + '" alt=""><div class="bb-photo-cap">凭证</div></div>'; }).join('');
    }).catch(function () { var wrap = document.querySelector('#bbPhotosWrap .bb-photos'); if (wrap) wrap.innerHTML = '<span class="muted">凭证加载失败</span>'; });
  }

  function render() {
    var c = document.getElementById('content');
    var mOpts = monthsList().map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join('');
    var qOpts = quartersList().map(function (q) { return '<option value="' + q + '">' + q.replace('-', ' 第') + ' 季度</option>'; }).join('');
    c.innerHTML =
      '<div class="bb-tool no-print">' +
        '<div class="bb-tool-row">' +
          '<label>期间类型 <select id="bbType">' + '<option value="month">月度</option><option value="quarter">季度</option>' + '</select></label>' +
          '<label>期间 <select id="bbVal">' + mOpts + '</select></label>' +
          '<button class="btn" id="bbGen">🔄 生成预览</button>' +
          '<button class="btn primary" id="bbPdf">🖨 导出 PDF（打印）</button>' +
          '<button class="btn" id="bbImg">🖼 导出图片（PNG）</button>' +
        '</div>' +
        '<div class="bb-tool-note">PDF 走浏览器打印（对话框选「另存为 PDF」）；图片走本地 Canvas 生成 PNG；红金排版与界面一致。</div>' +
      '</div>' +
      '<div id="bbPreview" class="print-area"></div>' +
      '<div class="bb-cockpit no-print" id="bbCockpit"></div>';

    var typeSel = document.getElementById('bbType');
    var valSel = document.getElementById('bbVal');
    typeSel.onchange = function () { valSel.innerHTML = typeSel.value === 'month' ? mOpts : qOpts; };
    document.getElementById('bbGen').onclick = buildPreview;
    document.getElementById('bbPdf').onclick = function () { window.print(); };
    document.getElementById('bbImg').onclick = exportImg;
    buildPreview();
    renderCockpit();
  }

  FW.modules = FW.modules || {};
  FW.modules.baobiao = { title: '老板月报', render: render };
})(window);
