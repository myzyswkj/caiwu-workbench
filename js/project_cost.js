/* ============================================================
 * 项目成本利润盈亏单产核算
 *   - 收入：登记内账流水中「类型=收入」且带「项目」的合计
 *   - 流水成本：登记内账流水中「类型=支出」且带「项目」的合计（按分类拆解）
 *   - 工资成本：工资登记中底薪/奖金/提成按「项目」分类的合计（按类型拆解）
 *   - 总成本 = 流水成本 + 工资成本
 *   - 利润 = 收入 - 总成本
 *   - 单产：利润率 = 利润 / 收入；投入产出比 = 收入 / 总成本
 *   - 额外：成本结构拆解、逐月趋势、未分配资金提醒、排名 + 下钻
 *   可按年度筛选（默认「全部年度」）。
 * ============================================================ */
(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  // 往来账余额：金额 − 已核销
  function contactBalance(r) { return (Number(r.amount) || 0) - (Number(r.settled) || 0); }

  function getInternal() { return FW.db.getList('internal'); }
  function getSalaryRecs() { return FW.db.getList('salary_records'); }

  // 一级分类（"主 / 子" 取主）
  function cat1(t) { return ((t.category || '').split(' / ')[0] || '').trim() || '其他'; }

  // 把一条工资记录拆成 {project, type, amount} 明细（type: base/bonus/commission；兼容新旧数据）
  function salaryComps(r) {
    var out = [];
    function push(arr, type) {
      (arr || []).forEach(function (it) {
        out.push({ project: (it.project || '').trim() || '未分类', type: type, amount: num(it.amount) });
      });
    }
    push(r.baseItems, 'base'); push(r.bonusItems, 'bonus'); push(r.commissionItems, 'commission');
    if (!r.baseItems && !r.bonusItems && !r.commissionItems) {
      if (num(r.base) > 0) out.push({ project: '未分类', type: 'base', amount: num(r.base) });
      if (num(r.bonus) > 0) out.push({ project: '未分类', type: 'bonus', amount: num(r.bonus) });
      if (num(r.commission) > 0) out.push({ project: '未分类', type: 'commission', amount: num(r.commission) });
    }
    return out;
  }

  // 对外兼容接口（旧数值工资 → 单条「未分类」）
  function salaryItems(r) {
    return salaryComps(r).map(function (c) { return { project: c.project, amount: c.amount }; });
  }

  function inYear(val, year) {
    if (year === 'all') return true;
    return String(val) === String(year);
  }

  // 核心聚合：返回 { rows, tot, avgRate, avgRoi, cats, laborTypes, monthly, unalloc }
  function compute(year) {
    year = (year == null) ? state.year : year;
    var txs = getInternal().filter(function (t) { return inYear((t.date || '').slice(0, 4), year); });
    var recs = getSalaryRecs().filter(function (r) { return inYear(r.year, year); });

    var map = {};
    function ensure(p) {
      if (!map[p]) map[p] = { revenue: 0, flowCost: 0, laborCost: 0, byCat: {}, laborByType: { base: 0, bonus: 0, commission: 0 }, recoverable: 0, recoverList: [] };
      return map[p];
    }

    // ===== 未分配统计 =====
    var unFlowCount = 0, unFlowAmt = 0;
    var unLaborAmt = 0, laborUnallocRecs = {};
    var preUnallocCount = 0, preUnallocAmt = 0;

    // 流水：收入 / 支出（仅统计带项目的流水；不带项目的进入未分配）
    txs.forEach(function (t) {
      var p = (t.project || '').trim();
      var a = num(t.amount);
      if (!p) { unFlowCount++; unFlowAmt += a; return; }
      var d = ensure(p);
      if (t.type === 'income') d.revenue += a;
      else if (t.type === 'expense') { d.flowCost += a; var c = cat1(t); d.byCat[c] = (d.byCat[c] || 0) + a; }
    });

    // 工资：底薪/奖金/提成按项目汇总；「未分类」部分进入未分配
    recs.forEach(function (r) {
      var recKey = r.id || (r.empId + '-' + r.year + '-' + r.month);
      salaryComps(r).forEach(function (c) {
        if (c.project === '未分类') { unLaborAmt += c.amount; laborUnallocRecs[recKey] = 1; }
        else { var d = ensure(c.project); d.laborCost += c.amount; d.laborByType[c.type] += c.amount; }
      });
    });

    // ===== 往来账：预付款未用完余额 → 应收回款项（按项目） =====
    FW.db.getList('contacts').filter(function (r) {
      return r.kind === '预付' && inYear((r.date || '').slice(0, 4), year);
    }).forEach(function (r) {
      var b = contactBalance(r);
      if (b <= 0) return;
      var p = (r.project || '').trim();
      if (!p) { preUnallocCount++; preUnallocAmt += b; return; }
      var dp = ensure(p);
      dp.recoverable += b;
      dp.recoverList.push({ party: (r.party || '').trim() || '—', date: r.date || '', amount: num(r.amount), settled: num(r.settled), balance: b });
    });

    var projects = Object.keys(map).filter(function (p) {
      var d = map[p]; return d.revenue || d.flowCost || d.laborCost || d.recoverable;
    });
    projects.sort(function (a, b) {
      var da = map[a], db = map[b];
      return (db.revenue - db.flowCost - db.laborCost) - (da.revenue - da.flowCost - da.laborCost);
    });

    var rows = projects.map(function (p, idx) {
      var d = map[p];
      var totalCost = d.flowCost + d.laborCost;
      var profit = d.revenue - totalCost;
      var rate = d.revenue > 0 ? profit / d.revenue * 100 : 0;
      var roi = totalCost > 0 ? d.revenue / totalCost : (d.revenue > 0 ? Infinity : 0);
      return {
        project: p, revenue: d.revenue, flowCost: d.flowCost, laborCost: d.laborCost,
        totalCost: totalCost, profit: profit, rate: rate, roi: roi, gain: profit >= 0,
        rank: idx + 1, byCat: d.byCat, laborByType: d.laborByType, recoverable: d.recoverable || 0, recoverList: d.recoverList || []
      };
    });

    var tot = { revenue: 0, flowCost: 0, laborCost: 0, totalCost: 0, profit: 0, recoverable: 0 };
    rows.forEach(function (r) {
      tot.revenue += r.revenue; tot.flowCost += r.flowCost; tot.laborCost += r.laborCost;
      tot.totalCost += r.totalCost; tot.profit += r.profit; tot.recoverable += (r.recoverable || 0);
    });
    var avgRate = tot.revenue > 0 ? tot.profit / tot.revenue * 100 : 0;
    var avgRoi = tot.totalCost > 0 ? tot.revenue / tot.totalCost : (tot.revenue > 0 ? Infinity : 0);

    // ===== 成本结构（全局） =====
    var catTot = {};
    rows.forEach(function (r) { Object.keys(r.byCat).forEach(function (c) { catTot[c] = (catTot[c] || 0) + r.byCat[c]; }); });
    var cats = Object.keys(catTot).map(function (c) { return { label: c, value: catTot[c] }; })
      .sort(function (a, b) { return b.value - a.value; });
    var laborTot = { base: 0, bonus: 0, commission: 0 };
    rows.forEach(function (r) { laborTot.base += r.laborByType.base; laborTot.bonus += r.laborByType.bonus; laborTot.commission += r.laborByType.commission; });
    var laborTypes = [
      { label: '底薪', value: laborTot.base },
      { label: '奖金', value: laborTot.bonus },
      { label: '提成', value: laborTot.commission }
    ].filter(function (x) { return x.value > 0; });

    // ===== 逐月趋势 =====
    var mMap = {};
    function mEnsure(k) { if (!mMap[k]) mMap[k] = { rev: 0, cost: 0 }; return mMap[k]; }
    txs.forEach(function (t) {
      var p = (t.project || '').trim(); if (!p) return;
      var k = (t.date || '').slice(0, 7); if (k.length < 7) return;
      var d = mEnsure(k);
      if (t.type === 'income') d.rev += num(t.amount);
      else if (t.type === 'expense') d.cost += num(t.amount);
    });
    recs.forEach(function (r) {
      var k = String(r.year) + '-' + ('0' + r.month).slice(-2);
      var sum = salaryComps(r).reduce(function (s, c) { return s + (c.project === '未分类' ? 0 : c.amount); }, 0);
      mEnsure(k).cost += sum;
    });
    var mkeys = Object.keys(mMap).sort();
    var monthly = {
      labels: mkeys.map(function (k) { return year === 'all' ? k : k.slice(5); }),
      revenue: mkeys.map(function (k) { return mMap[k].rev; }),
      cost: mkeys.map(function (k) { return mMap[k].cost; }),
      profit: mkeys.map(function (k) { return mMap[k].rev - mMap[k].cost; })
    };

    var unalloc = {
      flowCount: unFlowCount, flowAmt: unFlowAmt,
      laborCount: Object.keys(laborUnallocRecs).length, laborAmt: unLaborAmt,
      prepayCount: preUnallocCount, prepayAmt: preUnallocAmt
    };

    return { rows: rows, tot: tot, avgRate: avgRate, avgRoi: avgRoi, cats: cats, laborTypes: laborTypes, monthly: monthly, unalloc: unalloc };
  }

  function getYears() {
    var set = {};
    getInternal().forEach(function (t) { if (t.date && t.date.length >= 4) set[t.date.slice(0, 4)] = 1; });
    getSalaryRecs().forEach(function (r) { if (r.year) set[String(r.year)] = 1; });
    return Object.keys(set).sort();
  }

  var state = { year: 'all', expanded: {} };

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
    html += recoverNote(data);
    html += unallocHtml(data);
    html += chartHtml(data);
    html += trendHtml(data);
    html += tableHtml(data);
    html += '</div>';
    var c = document.getElementById('content'); if (c) c.innerHTML = html;

    // 下钻：点击项目行展开/收起明细
    var tbl = document.getElementById('pcTable');
    if (tbl) {
      tbl.onclick = function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-p]') : null;
        if (!tr) return;
        var p = tr.getAttribute('data-p');
        if (state.expanded[p]) delete state.expanded[p]; else state.expanded[p] = true;
        render();
      };
    }
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
      statCard('应收回款项（预付未用完）', FW.fmtMoney(t.recoverable), 'amt-recover') +
      statCard('平均利润率', (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—') + '%') +
      statCard('平均投入产出比', isFinite(data.avgRoi) ? data.avgRoi.toFixed(2) : '∞') +
      '</div>';
  }

  // 应收回款项说明（来自往来账预付未用完余额）
  function recoverNote(data) {
    if (!data.tot.recoverable) return '';
    return '<div class="pc-note">' +
      '<span class="pc-note-ico">↩</span>' +
      '<div>项目「应收回款项」合计 <b>' + FW.fmtMoney(data.tot.recoverable) + '</b>：来自「往来账」中标记为 <b>预付</b> 且关联了项目的单据，取其<b>未用完余额</b>（预付款 − 已核销）。这是待收回 / 待核销的资金，<b>不参与利润计算</b>，但属于项目占用的可收回资金。核销（收回 / 消耗）后余额减少，这里的金额会同步下降。</div>' +
      '</div>';
  }

  // 未分配资金提醒
  function unallocHtml(data) {
    var u = data.unalloc;
    if (!u.flowCount && !u.laborCount && !u.prepayCount) return '';
    var parts = [];
    if (u.flowCount) parts.push('流水 <b>' + u.flowCount + '</b> 笔、合计 <b>' + FW.fmtMoney(u.flowAmt) + '</b> 未填写项目');
    if (u.laborCount) parts.push('工资 <b>' + u.laborCount + '</b> 条、合计 <b>' + FW.fmtMoney(u.laborAmt) + '</b> 未分类项目');
    if (u.prepayCount) parts.push('预付款 <b>' + u.prepayCount + '</b> 笔、余额合计 <b>' + FW.fmtMoney(u.prepayAmt) + '</b> 未关联项目');
    return '<div class="pc-unalloc">' +
      '<span class="pc-unalloc-ico">⚠</span>' +
      '<div class="pc-unalloc-body"><b>有 ' + parts.join('；') + '</b>，未纳入项目核算。' +
      (u.flowCount || u.laborCount ? '补全流水「项目」或工资「按项目分类」后，会自动进入对应项目的成本 / 利润。' : '') +
      (u.prepayCount ? '在「往来账」给预付款登记「关联项目」后，其未用完余额会自动进入对应项目的「应收回款项」。' : '') +
      '</div>' +
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

    // 成本结构拆解
    var structParts = [];
    if (data.cats.length) {
      structParts.push(FW.barChart('流水成本结构（按分类）', data.cats, { height: 210 }));
    }
    if (data.laborTypes.length) {
      structParts.push(FW.pieChart('工资成本构成（底薪/奖金/提成）', data.laborTypes));
    }
    if (structParts.length) {
      h += '<div class="pc-section-title">成本结构拆解</div>';
      h += '<div class="pc-charts">' + structParts.join('') + '</div>';
      if (data.tot.flowCost || data.tot.laborCost) {
        h += FW.pieChart('总成本构成（流水 vs 工资）', [
          { label: '流水成本', value: data.tot.flowCost },
          { label: '工资成本', value: data.tot.laborCost }
        ]);
      }
    }
    return h;
  }

  // 逐月趋势
  function trendHtml(data) {
    if (!data.monthly.labels.length) return '';
    var m = data.monthly;
    var series = [
      { name: '收入', color: '#C8102E', points: m.labels.map(function (lb, i) { return { label: lb, value: m.revenue[i] }; }) },
      { name: '总成本', color: '#1f9d55', points: m.labels.map(function (lb, i) { return { label: lb, value: m.cost[i] }; }) },
      { name: '利润', color: '#C9A227', points: m.labels.map(function (lb, i) { return { label: lb, value: m.profit[i] }; }) }
    ];
    var title = (state.year === 'all' ? '逐月 收入/成本/利润趋势（全部年度）' : '逐月 收入/成本/利润趋势（' + state.year + ' 年）');
    return '<div class="pc-section-title">逐月趋势</div>' + FW.lineChart(title, series, {}) +
      '<div class="muted" style="font-size:12px;margin:-6px 0 8px">点项目行可展开查看该项目的成本分类与工资构成明细。</div>';
  }

  // 下钻明细
  function detailHtml(r) {
    var h = '<tr class="pc-detail-row"><td colspan="11"><div class="pc-detail">';
    var cats = Object.keys(r.byCat).map(function (c) { return { label: c, value: r.byCat[c] }; }).sort(function (a, b) { return b.value - a.value; });
    h += '<div class="pc-detail-block"><h5>流水成本构成（按分类）</h5>';
    h += cats.length ? FW.barChart('', cats, { height: 180 }) : '<div class="muted">无</div>';
    h += '</div>';
    var lt = [
      { label: '底薪', value: r.laborByType.base },
      { label: '奖金', value: r.laborByType.bonus },
      { label: '提成', value: r.laborByType.commission }
    ].filter(function (x) { return x.value > 0; });
    h += '<div class="pc-detail-block"><h5>工资成本构成（底薪/奖金/提成）</h5>';
    h += lt.length ? FW.pieChart('', lt) : '<div class="muted">无</div>';
    h += '</div>';
    if (r.recoverList && r.recoverList.length) {
      h += '<div class="pc-detail-block"><h5>应收回款项明细（预付未用完，来自「往来账」）</h5>';
      h += '<table class="pc-recov-table"><thead><tr>' +
        '<th>供应商 / 对象</th><th>单据日期</th><th class="num">预付金额</th><th class="num">已核销</th><th class="num">未用余额</th></tr></thead><tbody>';
      r.recoverList.forEach(function (x) {
        h += '<tr><td>' + FW.esc(x.party) + '</td><td>' + FW.esc(x.date) + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.amount) + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.settled) + '</td>' +
          '<td class="num amt-recover"><b>' + FW.fmtMoney(x.balance) + '</b></td></tr>';
      });
      h += '</tbody></table>';
      h += '<div class="muted" style="font-size:12px;margin-top:6px">以上为付给各对象的预付款尚未用完（已核销后）的余款，属待收回 / 待核销资金，<b>不计入项目利润</b>。</div>';
      h += '</div>';
    }
    h += '</div></td></tr>';
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
    var h = '<div class="proj-sum-wrap"><table class="proj-sum-table" id="pcTable"><thead><tr>' +
      '<th class="pc-rank">排名</th><th>项目</th><th class="num">收入</th><th class="num">流水成本</th><th class="num">工资成本</th><th class="num">总成本</th><th class="num">利润</th><th class="num">利润率</th><th class="num">投入产出比</th><th class="num">应收回款项</th><th>盈亏</th></tr></thead><tbody>';
    data.rows.forEach(function (r) {
      var profitCls = r.profit >= 0 ? 'amt-income' : 'amt-expense';
      var badge = r.profit >= 0 ? '<span class="badge ok">盈利</span>' : '<span class="badge bad">亏损</span>';
      var open = !!state.expanded[r.project];
      h += '<tr class="pc-row' + (open ? ' open' : '') + '" data-p="' + FW.esc(r.project) + '">' +
        '<td class="pc-rank">' + r.rank + '</td>' +
        '<td><span class="pc-caret">' + (open ? '▾' : '▸') + '</span> ' + FW.esc(r.project) + '</td>' +
        '<td class="num amt-income">' + FW.fmtMoney(r.revenue) + '</td>' +
        '<td class="num amt-expense">' + FW.fmtMoney(r.flowCost) + '</td>' +
        '<td class="num amt-expense">' + FW.fmtMoney(r.laborCost) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.totalCost) + '</td>' +
        '<td class="num ' + profitCls + '"><b>' + FW.fmtMoney(r.profit) + '</b></td>' +
        '<td class="num">' + r.rate.toFixed(1) + '%</td>' +
        '<td class="num">' + fmtRoi(r.roi) + '</td>' +
        '<td class="num amt-recover">' + FW.fmtMoney(r.recoverable || 0) + '</td>' +
        '<td>' + badge + '</td></tr>';
      if (open) h += detailHtml(r);
    });
    h += '<tr class="proj-sum-total"><td></td><td>合计</td>' +
      '<td class="num amt-income">' + FW.fmtMoney(data.tot.revenue) + '</td>' +
      '<td class="num amt-expense">' + FW.fmtMoney(data.tot.flowCost) + '</td>' +
      '<td class="num amt-expense">' + FW.fmtMoney(data.tot.laborCost) + '</td>' +
      '<td class="num">' + FW.fmtMoney(data.tot.totalCost) + '</td>' +
      '<td class="num ' + (data.tot.profit >= 0 ? 'amt-income' : 'amt-expense') + '"><b>' + FW.fmtMoney(data.tot.profit) + '</b></td>' +
      '<td class="num">' + (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—') + '%</td>' +
      '<td class="num">' + fmtRoi(data.avgRoi) + '</td>' +
      '<td class="num amt-recover"><b>' + FW.fmtMoney(data.tot.recoverable) + '</b></td><td></td></tr>';
    h += '</tbody></table></div>';
    return h;
  }

  function exportCSV(data) {
    var header = ['排名', '项目', '收入', '流水成本', '工资成本', '总成本', '利润', '利润率(%)', '投入产出比', '应收回款项', '盈亏'];
    var lines = [header.join(',')];
    data.rows.forEach(function (r) {
      lines.push([
        r.rank, r.project, r.revenue, r.flowCost, r.laborCost, r.totalCost, r.profit,
        r.rate.toFixed(1), fmtRoi(r.roi), (r.recoverable || 0), r.profit >= 0 ? '盈利' : '亏损'
      ].join(','));
    });
    lines.push([
      '', '合计', data.tot.revenue, data.tot.flowCost, data.tot.laborCost, data.tot.totalCost, data.tot.profit,
      (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—'), fmtRoi(data.avgRoi), data.tot.recoverable, ''
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

  FW.projectCostCalc = { compute: compute, salaryItems: salaryItems, salaryComps: salaryComps, getYears: getYears };

  FW.modules = FW.modules || {};
  FW.modules.projectCost = { title: '项目核算', render: render };
})(window);
