/* ============================================================
 * 项目成本利润盈亏单产核算
 *   - 收入：登记内账流水中「类型=收入」且带「项目」的合计
 *   - 流水成本：登记内账流水中「类型=支出」且带「项目」的合计
 *   - 工资成本：工资登记中底薪/奖金/提成按「项目」分类的合计
 *   - 总成本 = 流水成本 + 工资成本
 *   - 利润 = 收入 - 总成本
 *   - 单产：利润率 = 利润 / 收入；投入产出比 = 收入 / 总成本
 *   可按年度筛选（默认「全部年度」）。
 * ============================================================ */
(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function getInternal() { return FW.db.getList('internal'); }
  function getSalaryRecs() { return FW.db.getList('salary_records'); }

  // 把一条工资记录拆成 {project, amount} 明细（兼容新旧数据）
  function salaryItems(r) {
    var out = [];
    function push(arr) {
      (arr || []).forEach(function (it) {
        out.push({ project: (it.project || '').trim() || '未分类', amount: num(it.amount) });
      });
    }
    push(r.baseItems); push(r.bonusItems); push(r.commissionItems);
    if (!r.baseItems && !r.bonusItems && !r.commissionItems) {
      if (num(r.base) > 0) out.push({ project: '未分类', amount: num(r.base) });
      if (num(r.bonus) > 0) out.push({ project: '未分类', amount: num(r.bonus) });
      if (num(r.commission) > 0) out.push({ project: '未分类', amount: num(r.commission) });
    }
    return out;
  }

  function inYear(val, year) {
    if (year === 'all') return true;
    return String(val) === String(year);
  }

  // 核心聚合：返回 { rows, tot, avgRate, avgRoi }
  function compute(year) {
    year = (year == null) ? state.year : year;
    var txs = getInternal().filter(function (t) { return inYear((t.date || '').slice(0, 4), year); });
    var recs = getSalaryRecs().filter(function (r) { return inYear(r.year, year); });

    var map = {};
    function ensure(p) { if (!map[p]) map[p] = { revenue: 0, flowCost: 0, laborCost: 0 }; return map[p]; }

    // 流水：收入 / 支出（仅统计带项目的流水）
    txs.forEach(function (t) {
      var p = (t.project || '').trim();
      if (!p) return;
      var a = num(t.amount);
      var d = ensure(p);
      if (t.type === 'income') d.revenue += a;
      else if (t.type === 'expense') d.flowCost += a;
    });

    // 工资：底薪/奖金/提成按项目汇总为工资成本
    recs.forEach(function (r) {
      salaryItems(r).forEach(function (it) {
        ensure(it.project).laborCost += it.amount;
      });
    });

    var projects = Object.keys(map).filter(function (p) {
      var d = map[p]; return d.revenue || d.flowCost || d.laborCost;
    });
    projects.sort(function (a, b) {
      var da = map[a], db = map[b];
      return (db.revenue - db.flowCost - db.laborCost) - (da.revenue - da.flowCost - da.laborCost);
    });

    var rows = projects.map(function (p) {
      var d = map[p];
      var totalCost = d.flowCost + d.laborCost;
      var profit = d.revenue - totalCost;
      var rate = d.revenue > 0 ? profit / d.revenue * 100 : 0;
      var roi = totalCost > 0 ? d.revenue / totalCost : (d.revenue > 0 ? Infinity : 0);
      return { project: p, revenue: d.revenue, flowCost: d.flowCost, laborCost: d.laborCost, totalCost: totalCost, profit: profit, rate: rate, roi: roi, gain: profit >= 0 };
    });

    var tot = { revenue: 0, flowCost: 0, laborCost: 0, totalCost: 0, profit: 0 };
    rows.forEach(function (r) {
      tot.revenue += r.revenue; tot.flowCost += r.flowCost; tot.laborCost += r.laborCost;
      tot.totalCost += r.totalCost; tot.profit += r.profit;
    });
    var avgRate = tot.revenue > 0 ? tot.profit / tot.revenue * 100 : 0;
    var avgRoi = tot.totalCost > 0 ? tot.revenue / tot.totalCost : (tot.revenue > 0 ? Infinity : 0);

    return { rows: rows, tot: tot, avgRate: avgRate, avgRoi: avgRoi };
  }

  function getYears() {
    var set = {};
    getInternal().forEach(function (t) { if (t.date && t.date.length >= 4) set[t.date.slice(0, 4)] = 1; });
    getSalaryRecs().forEach(function (r) { if (r.year) set[String(r.year)] = 1; });
    return Object.keys(set).sort();
  }

  var state = { year: 'all' };

  function render() {
    var data = compute(state.year);
    var years = getYears();

    var top = document.getElementById('topActions');
    if (top) {
      top.innerHTML =
        '<label class="pc-year-label">统计年度</label>' +
        '<select id="pcYear" class="pc-year">' +
        '<option value="all"' + (state.year === 'all' ? ' selected' : '') + '>全部年度</option>' +
        years.map(function (y) { return '<option value="' + y + '"' + (state.year === y ? ' selected' : '') + '>' + y + ' 年</option>'; }).join('') +
        '</select>' +
        '<button class="btn" id="pcExport">⬇ 导出CSV</button>';
      document.getElementById('pcYear').onchange = function () { state.year = this.value; render(); };
      document.getElementById('pcExport').onclick = function () { exportCSV(data); };
    }

    var html = '<div class="salary-wrap">';
    html += statRow(data);
    html += chartHtml(data);
    html += tableHtml(data);
    html += '</div>';
    var c = document.getElementById('content'); if (c) c.innerHTML = html;
  }

  function statCard(label, val, cls) {
    return '<div class="sal-stat"><div class="sal-stat-val ' + (cls || '') + '">' + val + '</div><div class="sal-stat-label">' + label + '</div></div>';
  }

  function statRow(data) {
    var t = data.tot;
    return '<div class="sal-stats">' +
      statCard('参与核算项目', data.rows.length + ' 个') +
      statCard('总收入', FW.fmtMoney(t.revenue), 'amt-income') +
      statCard('总流水成本', FW.fmtMoney(t.flowCost), 'amt-expense') +
      statCard('总工资成本', FW.fmtMoney(t.laborCost), 'amt-expense') +
      statCard('总成本', FW.fmtMoney(t.totalCost)) +
      statCard('总利润', FW.fmtMoney(t.profit), t.profit >= 0 ? 'amt-income' : 'amt-expense') +
      statCard('平均利润率', (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—') + '%') +
      statCard('平均投入产出比', isFinite(data.avgRoi) ? data.avgRoi.toFixed(2) : '∞') +
      '</div>';
  }

  function fmtRoi(v) { return isFinite(v) ? v.toFixed(2) : '∞'; }

  function chartHtml(data) {
    if (!data.rows.length) return '';
    var labels = data.rows.map(function (r) { return r.project; });
    var series = [
      { name: '收入', color: '#C8102E', values: data.rows.map(function (r) { return r.revenue; }) },
      { name: '总成本', color: '#1f9d55', values: data.rows.map(function (r) { return r.totalCost; }) },
      { name: '利润', color: '#C9A227', values: data.rows.map(function (r) { return r.profit; }) }
    ];
    var chartW = Math.max(440, labels.length * 74 + 70);
    var title = (state.year === 'all' ? '各项目 收入/成本/利润（全部年度）' : '各项目 收入/成本/利润（' + state.year + ' 年）');
    var h = '<div class="mindmap-box"><div style="min-width:' + chartW + 'px">' +
      FW.groupedBarChart(title, series, labels, { width: chartW, height: 240 }) + '</div></div>';
    if (data.tot.flowCost || data.tot.laborCost) {
      h += FW.pieChart('总成本构成（流水 vs 工资）', [
        { label: '流水成本', value: data.tot.flowCost },
        { label: '工资成本', value: data.tot.laborCost }
      ]);
    }
    return h;
  }

  function tableHtml(data) {
    if (!data.rows.length) {
      return '<div class="empty-state">' +
        '<div class="empty-ico">📊</div>' +
        '<div class="empty-title">还没有可用于项目核算的数据</div>' +
        '<div class="empty-sub">请在「登记内账」的流水里填写 <b>项目</b> 字段（收入与支出都计入），并在「工资登记」里把底薪 / 奖金 / 提成按 <b>项目</b> 分类。系统会把同一项目的收入、流水支出与工资成本汇总，自动核算利润、利润率与投入产出比（单产）。</div>' +
        '</div>';
    }
    var h = '<div class="proj-sum-wrap"><table class="proj-sum-table"><thead><tr>' +
      '<th>项目</th><th class="num">收入</th><th class="num">流水成本</th><th class="num">工资成本</th><th class="num">总成本</th><th class="num">利润</th><th class="num">利润率</th><th class="num">投入产出比</th><th>盈亏</th></tr></thead><tbody>';
    data.rows.forEach(function (r) {
      var profitCls = r.profit >= 0 ? 'amt-income' : 'amt-expense';
      var badge = r.profit >= 0 ? '<span class="badge ok">盈利</span>' : '<span class="badge bad">亏损</span>';
      h += '<tr><td>' + FW.esc(r.project) + '</td>' +
        '<td class="num amt-income">' + FW.fmtMoney(r.revenue) + '</td>' +
        '<td class="num amt-expense">' + FW.fmtMoney(r.flowCost) + '</td>' +
        '<td class="num amt-expense">' + FW.fmtMoney(r.laborCost) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.totalCost) + '</td>' +
        '<td class="num ' + profitCls + '"><b>' + FW.fmtMoney(r.profit) + '</b></td>' +
        '<td class="num">' + r.rate.toFixed(1) + '%</td>' +
        '<td class="num">' + fmtRoi(r.roi) + '</td>' +
        '<td>' + badge + '</td></tr>';
    });
    h += '<tr class="proj-sum-total"><td>合计</td>' +
      '<td class="num amt-income">' + FW.fmtMoney(data.tot.revenue) + '</td>' +
      '<td class="num amt-expense">' + FW.fmtMoney(data.tot.flowCost) + '</td>' +
      '<td class="num amt-expense">' + FW.fmtMoney(data.tot.laborCost) + '</td>' +
      '<td class="num">' + FW.fmtMoney(data.tot.totalCost) + '</td>' +
      '<td class="num ' + (data.tot.profit >= 0 ? 'amt-income' : 'amt-expense') + '"><b>' + FW.fmtMoney(data.tot.profit) + '</b></td>' +
      '<td class="num">' + (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—') + '%</td>' +
      '<td class="num">' + fmtRoi(data.avgRoi) + '</td><td></td></tr>';
    h += '</tbody></table></div>';
    return h;
  }

  function exportCSV(data) {
    var header = ['项目', '收入', '流水成本', '工资成本', '总成本', '利润', '利润率(%)', '投入产出比', '盈亏'];
    var lines = [header.join(',')];
    data.rows.forEach(function (r) {
      lines.push([
        r.project, r.revenue, r.flowCost, r.laborCost, r.totalCost, r.profit,
        r.rate.toFixed(1), fmtRoi(r.roi), r.profit >= 0 ? '盈利' : '亏损'
      ].join(','));
    });
    lines.push([
      '合计', data.tot.revenue, data.tot.flowCost, data.tot.laborCost, data.tot.totalCost, data.tot.profit,
      (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—'), fmtRoi(data.avgRoi), ''
    ].join(','));
    var csv = lines.join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '项目成本利润核算_' + (state.year === 'all' ? '全部年度' : state.year) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast('已导出 CSV');
  }

  FW.projectCostCalc = { compute: compute, salaryItems: salaryItems, getYears: getYears };

  FW.modules = FW.modules || {};
  FW.modules.projectCost = { title: '项目核算', render: render };
})(window);
