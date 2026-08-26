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

  function buildPreview() {
    var c = document.getElementById('bbPreview'); if (!c) return;
    var type = document.getElementById('bbType').value;
    var val = document.getElementById('bbVal').value;
    var label = type === 'month' ? (val + ' 月度') : (val.replace('-', ' 年第') + ' 季度');
    var rows = periodRows(type, val);
    var s = sum(rows);

    var cumRate = null, cumProfit = 0, cumRev = 0;
    if (FW.projectCostCalc && FW.projectCostCalc.compute) {
      var data = FW.projectCostCalc.compute('all');
      (data.rows || []).forEach(function (r) { cumRev += (r.revenue || 0); cumProfit += (r.profit || 0); });
      if (cumRev > 0) cumRate = cumProfit / cumRev * 100;
    }
    var pnl = projectPnl(rows);

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
        '</div>' +
        '<div class="bb-tool-note">导出会调用浏览器打印，在打印对话框选「另存为 PDF」即可；红金排版与界面一致。</div>' +
      '</div>' +
      '<div id="bbPreview" class="print-area"></div>';

    var typeSel = document.getElementById('bbType');
    var valSel = document.getElementById('bbVal');
    typeSel.onchange = function () { valSel.innerHTML = typeSel.value === 'month' ? mOpts : qOpts; };
    document.getElementById('bbGen').onclick = buildPreview;
    document.getElementById('bbPdf').onclick = function () { window.print(); };
    buildPreview();
  }

  FW.modules = FW.modules || {};
  FW.modules.baobiao = { title: '老板月报', render: render };
})(window);
