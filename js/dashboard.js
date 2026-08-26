/* ============================================================
 * 工作台首页（经营概览 / 老板看账）
 * 借鉴：柠檬云「老板看账」、牛算盘「经营驾驶舱」、鲨鱼记账首页
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  function internalList() { return FW.db.getList('internal'); }
  function monthSum(m) {
    var inc = 0, exp = 0;
    internalList().forEach(function (t) {
      if (t.date && t.date.slice(0, 7) === m) { if (t.type === 'income') inc += +t.amount; else if (t.type === 'expense') exp += +t.amount; else if (t.type === 'refund') exp -= +t.amount; }
    });
    return { inc: inc, exp: exp, net: inc - exp };
  }
  function prevMonth(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); m--; if (m === 0) { m = 12; y--; } return y + '-' + (m < 10 ? '0' + m : m); }
  function budgetFor(m) { return FW.db.getList('internal_budget').filter(function (b) { return b.month === m; })[0] || null; }
  function shift(dstr, days) {
    var d = new Date(dstr); d.setDate(d.getDate() + days);
    var p = function (x) { return (x < 10 ? '0' + x : x); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function card(label, value, cls, momVal) {
    var momHtml = momVal == null ? '' : '<span class="mom ' + (momVal >= 0 ? 'up' : 'down') + '">' + (momVal >= 0 ? '▲' : '▼') + Math.abs(momVal).toFixed(1) + '% 环比</span>';
    return '<div class="dash-card"><div class="dash-label">' + label + '</div><div class="dash-value ' + (cls || '') + '">' + value + '</div>' + momHtml + '</div>';
  }
  function budgetCard(pct, bud) {
    if (pct == null) return '<div class="dash-card"><div class="dash-label">本月预算</div><div class="dash-value muted" style="font-size:15px">未设置</div><span class="mom" style="color:var(--muted)">去「登记内账」设置</span></div>';
    var over = pct > 100;
    return '<div class="dash-card"><div class="dash-label">预算使用率</div><div class="dash-value" style="color:' + (over ? 'var(--income)' : 'var(--expense)') + '">' + pct.toFixed(0) + '%</div>' +
      '<div class="budget-bar" style="margin-top:10px"><div class="budget-fill" style="width:' + Math.min(pct, 100).toFixed(0) + '%;background:' + (over ? '#e63946' : (pct > 80 ? '#f0a020' : '#1f9d55')) + '"></div></div></div>';
  }
  function quick(ico, title, desc, mod) {
    return '<div class="dash-quick-card" data-mod="' + mod + '"><div class="dq-ico">' + ico + '</div><div><div class="dq-title">' + title + '</div><div class="dq-desc">' + desc + '</div></div></div>';
  }
  function todoItem(m) {
    var over = m.due < FW.today();
    return '<div class="todo-item"><span class="tag ' + (over ? 'expense' : 'income') + '">⏰ ' + FW.esc(m.due) + '</span> ' + FW.esc(m.title || '（无标题）') + '</div>';
  }
  function recentHtml(rows) {
    if (!rows.length) return '<div class="empty">还没有流水，去「登记内账」记一笔吧。</div>';
    var trs = rows.map(function (t) {
      var cls = t.type === 'income' ? 'income' : (t.type === 'refund' ? 'refund' : (t.type === 'expense' ? 'expense' : 'neutral'));
      return '<tr><td class="nowrap">' + FW.esc(t.date) + '</td><td>' + FW.esc(t.project || '—') + '</td><td>' + FW.esc(t.category || (t.type === 'transfer' || t.type === 'equity' ? '—' : '—')) + '</td><td class="num ' + cls + '">' + FW.fmtMoney(t.amount) + '</td></tr>';
    }).join('');
    return '<table><thead><tr><th>日期</th><th>项目</th><th>分类</th><th class="num">金额</th></tr></thead><tbody>' + trs + '</tbody></table>';
  }

  // 各账户余额（资金层，含期初）——复用 internalCalc.accountBalancesTree（树状：一级 + 二级）
  function accountsHtml() {
    if (!FW.internalCalc || !FW.internalCalc.accountBalancesTree) return '';
    var tree = FW.internalCalc.accountBalancesTree(); // [{name, bal, children:[{name, bal}]}]
    if (!tree.length) return '';
    var total = 0;
    var tiles = tree.map(function (p) {
      total += (Number(p.bal) || 0);
      var subs = (p.children || []).map(function (c) {
        return '<div class="da-sub"><span class="da-sub-name">' + FW.esc(c.name.split(' / ').slice(1).join(' / ')) + '</span><span class="da-sub-bal">' + FW.fmtMoney(c.bal) + '</span></div>';
      }).join('');
      var subHtml = subs ? '<div class="da-subs">' + subs + '</div>' : '';
      return '<div class="dash-acct-tile" data-mod="internal"><div class="da-name">' + FW.esc(p.name) + '</div><div class="da-bal">' + FW.fmtMoney(p.bal) + '</div>' + subHtml + '</div>';
    }).join('');
    tiles += '<div class="dash-acct-tile total"><div class="da-name">资金总计</div><div class="da-bal">' + FW.fmtMoney(total) + '</div></div>';
    return '<div class="card dash-acct-card" data-mod="internal"><h3>各账户余额 <span class="sub">点击进入登记内账</span></h3><div class="dash-acct-grid">' + tiles + '</div></div>';
  }

  // 各项目盈亏（利润层，全部年度汇总）——复用 projectCostCalc.compute
  function projectPnlHtml() {
    if (!FW.projectCostCalc || !FW.projectCostCalc.compute) return '';
    var data = FW.projectCostCalc.compute('all');
    var rows = (data.rows || []).slice().sort(function (a, b) { return b.profit - a.profit; });
    if (!rows.length) return '';
    // 企业累计未分配利润（已扣分红）—— 与「报表中心」资金状况表口径一致
    var retained = null;
    if (FW.reportsCalc && FW.reportsCalc.agg) { var ra = FW.reportsCalc.agg('', ''); retained = ra.netProfit - ra.dividend; }
    var top = rows.slice(0, 8);
    var trs = top.map(function (r) {
      var pcls = r.profit >= 0 ? 'pnl-income' : 'pnl-expense';
      var badge = r.profit >= 0 ? '<span class="badge ok">盈利</span>' : '<span class="badge bad">亏损</span>';
      var rate = r.rate != null && isFinite(r.rate) ? r.rate.toFixed(1) + '%' : '—';
      return '<tr data-mod="projectCost"><td>' + FW.esc(r.project) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.revenue) + '</td>' +
        '<td class="num ' + pcls + '">' + FW.fmtMoney(r.profit) + '</td>' +
        '<td class="num">' + rate + '</td>' +
        '<td>' + badge + '</td></tr>';
    }).join('');
    var more = rows.length > top.length ? '<div class="dash-more">共 ' + rows.length + ' 个项目，点击查看全部 →</div>' : '';
    var retainedHtml = retained != null
      ? '<div class="dash-retained">企业累计未分配利润（已扣分红）：<b>' + FW.fmtMoney(retained) + '</b> <span class="muted">· 与「报表中心」口径一致</span></div>'
      : '';
    return '<div class="card" data-mod="projectCost"><h3>各项目盈亏 <span class="sub">按利润排序 · 经营口径（不含分红）· 点击查看项目核算</span></h3>' +
      '<table class="dash-pnl-table"><thead><tr><th>项目</th><th class="num">收入</th><th class="num">利润</th><th class="num">利润率</th><th>状态</th></tr></thead><tbody>' + trs + '</tbody></table>' + more + retainedHtml + '</div>';
  }

  function render() {
    var c = document.getElementById('content');
    var now = new Date();
    var cur = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
    var ms = monthSum(cur);
    var pm = monthSum(prevMonth(cur));
    var bud = budgetFor(cur);
    function mom(curv, prevv) { if (!(prevv > 0)) return null; return (curv - prevv) / prevv * 100; }
    var incMom = mom(ms.inc, pm.inc), expMom = mom(ms.exp, pm.exp);
    var budPct = bud && bud.total ? (ms.exp / Number(bud.total) * 100) : null;

    // 近 6 个月趋势
    var months = [];
    for (var i = 5; i >= 0; i--) { var d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)); }
    var incLine = months.map(function (m) { return { label: m.slice(5) + '月', value: monthSum(m).inc }; });
    var expLine = months.map(function (m) { return { label: m.slice(5) + '月', value: monthSum(m).exp }; });

    // 待办提醒
    var memos = FW.db.getList('memos');
    var t = FW.today();
    var overdue = memos.filter(function (m) { return m.due && m.due < t; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; });
    var upcoming = memos.filter(function (m) { return m.due && m.due >= t && m.due <= shift(t, 7); }).sort(function (a, b) { return a.due < b.due ? -1 : 1; });
    var todoCount = overdue.length + upcoming.length;

    var recent = internalList().slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).slice(0, 6);

    var html =
      '<div class="dash-grid">' +
        card('本月收入', FW.fmtMoney(ms.inc), 'income', incMom) +
        card('本月支出', FW.fmtMoney(ms.exp), 'expense', expMom) +
        card('本月结余', FW.fmtMoney(ms.net), '', null) +
        budgetCard(budPct, bud) +
      '</div>' +

      '<div class="card" style="margin-bottom:18px">' + FW.lineChart('近 6 个月收支趋势', [{ name: '收入', color: '#e63946', points: incLine }, { name: '支出', color: '#1f9d55', points: expLine }]) + '</div>' +

      '<div class="dash-quick">' +
        quick('📒', '登记内账', '日常收支流水 / 凭证', 'internal') +
        quick('🧾', '报税记账', '凭证 / 日记账 / 报表', 'tax') +
        quick('🤝', '往来账', '应收应付管理', 'contacts') +
        quick('📝', '备忘录', '待办与提醒', 'memo') +
      '</div>' +

      accountsHtml() +
      projectPnlHtml() +

      '<div class="card" style="margin-top:18px"><h3>待办与提醒 <span class="sub">' + todoCount + ' 项临近</span></h3>' +
        (overdue.length ? '<div class="todo-sec"><div class="todo-h">已逾期</div>' + overdue.map(todoItem).join('') + '</div>' : '') +
        (upcoming.length ? '<div class="todo-sec"><div class="todo-h">未来 7 天</div>' + upcoming.map(todoItem).join('') + '</div>' : '') +
        (todoCount === 0 ? '<div class="empty">暂无临近的待办提醒 🎉</div>' : '') +
      '</div>' +

      '<div class="card" style="margin-top:18px"><h3>最近流水</h3>' + recentHtml(recent) + '</div>';

    c.innerHTML = html;

    // 通用跳转：带 data-mod 的元素（快速入口 / 账户余额 / 项目盈亏）点击进入对应模块
    FW.qa('#content [data-mod]').forEach(function (el) {
      el.onclick = function () {
        var nav = document.querySelector('#moduleNav .nav-item[data-module="' + el.dataset.mod + '"]');
        if (nav) nav.click();
      };
    });
  }

  FW.modules = FW.modules || {};
  FW.modules.home = { title: '工作台首页', render: render };
})(window);
