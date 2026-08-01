/* ============================================================
 * 报表中心（基于「登记内账」流水自动汇总）
 *   - 利润表：营业收入 − 营业成本 − 税金及附加 − 费用 − 固定资产购置 = 净利润
 *   - 资金状况表（简化资产负债表）：货币资金 + 实收资本 + 未分配利润，自动平衡
 *   - 现金流量表：经营 / 投资 / 筹资 活动现金流量
 * 说明：内账为单式流水账，报表为面向老板的实务口径（收减支），
 *       非严格会计准则；所得税依实际申报填列，本表不自动计提。
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'internal';
  var ACCT_ORDER = ['现金', '银行卡', '支付宝', '微信', '对公账户', '其他'];

  var state = { tab: 'pl', from: '', to: '' };

  function rowsAll() { return FW.db.getList(KEY); }
  function inRange(t, from, to) { return (!from || t.date >= from) && (!to || t.date <= to); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  /* 支出分类：成本 / 税金 / 费用 / 固定资产购置 */
  function classify(cat) {
    cat = cat || '';
    if (/材料|采购|进货|商品|库存|原料|主料/.test(cat)) return 'cost';
    if (cat === '税费' || /增值税|所得税|附加税|印花|城建|教育费附加|水利基金/.test(cat)) return 'tax';
    if (/设备|固定资产|购置|装修|构建|基建/.test(cat)) return 'invest';
    return 'fee';
  }

  /* 按账户汇总余额（截至某日）。优先复用内账的统一计算（含期初余额），保证两处逻辑一致 */
  function accountBalances(upto) {
    if (FW.internalCalc && FW.internalCalc.accountBalances) return FW.internalCalc.accountBalances(upto);
    // 兜底：内账未加载时，用旧逻辑（不含期初）
    var m = {};
    rowsAll().forEach(function (t) {
      if (upto && t.date > upto) return;
      var a = num(t.amount);
      if (t.type === 'income') m[t.account] = (m[t.account] || 0) + a;
      else if (t.type === 'expense') m[t.account] = (m[t.account] || 0) - a;
      else if (t.type === 'refund') m[t.account] = (m[t.account] || 0) + a;
      else if (t.type === 'transfer') {
        m[t.fromAccount] = (m[t.fromAccount] || 0) - a;
        m[t.toAccount] = (m[t.toAccount] || 0) + a;
      } else if (t.type === 'equity') {
        if (t.equityDir === 'out') m[t.account] = (m[t.account] || 0) - a;
        else m[t.account] = (m[t.account] || 0) + a;
      }
    });
    var seen = {}, ordered = [];
    ACCT_ORDER.forEach(function (k) { if (m[k] !== undefined) { ordered.push(k); seen[k] = 1; } });
    Object.keys(m).forEach(function (k) { if (!seen[k]) ordered.push(k); });
    return ordered.map(function (k) { return { name: k, bal: m[k] }; });
  }

  /* 期间发生额聚合 */
  function agg(from, to) {
    var income = {}, cost = {}, tax = {}, fee = {}, invest = {};
    var incomeTotal = 0, costTotal = 0, taxTotal = 0, feeTotal = 0, investTotal = 0;
    var equityIn = 0, equityOut = 0;
    rowsAll().forEach(function (t) {
      if (!inRange(t, from, to)) return;
      var a = num(t.amount), cat = t.category || '未分类';
      if (t.type === 'income') {
        // 实际收入 = 到账净额 + 已扣支出（还原毛额）；已扣支出计入对应分类成本（只计一次）
        var dv = num(t.deduct);
        var gross = a + (dv > 0 ? dv : 0);
        income[cat] = (income[cat] || 0) + gross; incomeTotal += gross;
        if (dv > 0) {
          var ik = classify(cat);
          if (ik === 'cost') { cost[cat] = (cost[cat] || 0) + dv; costTotal += dv; }
          else if (ik === 'tax') { tax[cat] = (tax[cat] || 0) + dv; taxTotal += dv; }
          else if (ik === 'invest') { invest[cat] = (invest[cat] || 0) + dv; investTotal += dv; }
          else { fee[cat] = (fee[cat] || 0) + dv; feeTotal += dv; }
        }
      } else if (t.type === 'expense') {
        var k = classify(cat);
        if (k === 'cost') { cost[cat] = (cost[cat] || 0) + a; costTotal += a; }
        else if (k === 'tax') { tax[cat] = (tax[cat] || 0) + a; taxTotal += a; }
        else if (k === 'invest') { invest[cat] = (invest[cat] || 0) + a; investTotal += a; }
        else { fee[cat] = (fee[cat] || 0) + a; feeTotal += a; }
      } else if (t.type === 'refund') {
        // 退款收入：冲减对应分类的支出（成本 / 税金 / 费用 / 固定资产），不计入总收入
        var rk = classify(cat);
        if (rk === 'cost') { cost[cat] = (cost[cat] || 0) - a; costTotal -= a; }
        else if (rk === 'tax') { tax[cat] = (tax[cat] || 0) - a; taxTotal -= a; }
        else if (rk === 'invest') { invest[cat] = (invest[cat] || 0) - a; investTotal -= a; }
        else { fee[cat] = (fee[cat] || 0) - a; feeTotal -= a; }
      } else if (t.type === 'equity') {
        if (t.equityDir === 'out') equityOut += a; else equityIn += a;
      }
    });
    return {
      income: income, incomeTotal: incomeTotal,
      cost: cost, costTotal: costTotal,
      tax: tax, taxTotal: taxTotal,
      fee: fee, feeTotal: feeTotal,
      invest: invest, investTotal: investTotal,
      equityNet: equityIn - equityOut, equityIn: equityIn, equityOut: equityOut,
      netProfit: incomeTotal - costTotal - taxTotal - feeTotal - investTotal
    };
  }

  /* ---------- 渲染辅助 ---------- */
  function money(x) { return FW.fmtMoney(x); }
  function grpMap(map) {
    return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; })
      .map(function (k) { return '<tr><td>' + FW.esc(k) + '</td><td class="num">' + money(map[k]) + '</td></tr>'; }).join('');
  }
  function subRow(label, val) {
    return '<tr class="sub"><td>' + FW.esc(label) + '</td><td class="num">' + money(val) + '</td></tr>';
  }
  function boldRow(label, val, cls) {
    return '<tr class="bold"><td>' + FW.esc(label) + '</td><td class="num ' + (cls || '') + '">' + money(val) + '</td></tr>';
  }

  /* ---------- 利润表 ---------- */
  function drawPL(from, to) {
    var d = agg(from, to);
    var html =
      '<table class="rep-table"><tbody>' +
      '<tr class="sec"><td>一、营业收入</td><td class="num"></td></tr>' +
      (grpMap(d.income) || '<tr><td class="muted">（无收入记录）</td><td class="num">0.00</td></tr>') +
      subRow('营业收入小计', d.incomeTotal) +
      '<tr class="sec"><td>减：营业成本</td><td class="num"></td></tr>' +
      (grpMap(d.cost) || '<tr><td class="muted">（无）</td><td class="num">0.00</td></tr>') +
      subRow('营业成本小计', d.costTotal) +
      '<tr class="sec"><td>减：税金及附加</td><td class="num"></td></tr>' +
      (grpMap(d.tax) || '<tr><td class="muted">（无）</td><td class="num">0.00</td></tr>') +
      subRow('税金及附加小计', d.taxTotal) +
      '<tr class="sec"><td>减：销售费用及管理费用</td><td class="num"></td></tr>' +
      (grpMap(d.fee) || '<tr><td class="muted">（无）</td><td class="num">0.00</td></tr>') +
      subRow('费用小计', d.feeTotal) +
      '<tr class="sec"><td>减：购置固定资产（资本性支出）</td><td class="num"></td></tr>' +
      (grpMap(d.invest) || '<tr><td class="muted">（无）</td><td class="num">0.00</td></tr>') +
      subRow('固定资产购置小计', d.investTotal) +
      boldRow('二、净利润', d.netProfit, d.netProfit >= 0 ? 'income' : 'expense') +
      '</tbody></table>' +
      '<div class="muted" style="font-size:12px;margin-top:8px">注：所得税依实际申报填列，本表未自动计提；净利润 = 收入 −（成本+税金+费用+固定资产购置）。</div>';
    return html;
  }

  /* ---------- 资金状况表（截至期末） ---------- */
  function drawFund(from, to) {
    var d = agg('', to); // 累计到期末
    var accts = accountBalances(to);
    var cashTotal = accts.reduce(function (s, x) { return s + x.bal; }, 0);
    var paidIn = d.equityNet;            // 实收资本 = 股本净注入（累计）
    var retained = d.netProfit;          // 未分配利润 = 累计净利润（累计到期末）
    var openingsTotal = (FW.internalCalc && FW.internalCalc.getOpeningsTotal) ? FW.internalCalc.getOpeningsTotal() : 0;
    var liabEq = paidIn + retained + openingsTotal;   // 负债+权益（含期初余额）
    var balanced = Math.abs(cashTotal - liabEq) < 0.005;

    var acctRows = accts.length ? accts.map(function (x) {
      return '<tr><td>' + FW.esc(x.name) + '</td><td class="num">' + money(x.bal) + '</td></tr>';
    }).join('') : '<tr><td class="muted">（暂无资金变动记录）</td><td class="num">0.00</td></tr>';

    var html =
      '<table class="rep-table"><tbody>' +
      '<tr class="sec"><td>资产</td><td class="num"></td></tr>' +
      '<tr class="sec"><td>　货币资金</td><td class="num"></td></tr>' +
      acctRows +
      boldRow('　货币资金合计', cashTotal) +
      '<tr class="sec"><td>负债及所有者权益</td><td class="num"></td></tr>' +
      '<tr><td>　期初余额（资金）</td><td class="num">' + money(openingsTotal) + '</td></tr>' +
      '<tr><td>　实收资本（股本净注入）</td><td class="num">' + money(paidIn) + '</td></tr>' +
      '<tr><td>　未分配利润（累计净利润）</td><td class="num">' + money(retained) + '</td></tr>' +
      boldRow('　负债及所有者权益合计', liabEq) +
      '</tbody></table>' +
      '<div class="muted" style="font-size:12px;margin-top:8px">' +
      '资产 = 负债 + 所有者权益：' + (balanced ? '✅ 已平衡' : '⚠️ 不平衡（请检查数据）') +
      '。内账为单式流水，未单独核算应收应付等负债，故「负债」项为 0。' +
      '</div>';
    return html;
  }

  /* ---------- 现金流量表 ---------- */
  function drawCash(from, to) {
    var d = agg(from, to);
    var opIn = d.incomeTotal;
    var opOut = d.costTotal + d.taxTotal + d.feeTotal;
    var invOut = d.investTotal;
    var finNet = d.equityNet; // 筹资净流量（注入-抽回）
    var netInc = opIn - opOut - invOut + finNet;
    var html =
      '<table class="rep-table"><tbody>' +
      '<tr class="sec"><td>一、经营活动产生的现金流量</td><td class="num"></td></tr>' +
      '<tr><td>　销售商品、提供劳务收到的现金</td><td class="num income">' + money(opIn) + '</td></tr>' +
      '<tr><td>　购买商品、接受劳务支付的现金</td><td class="num expense">-' + money(d.costTotal) + '</td></tr>' +
      '<tr><td>　支付的各项税费</td><td class="num expense">-' + money(d.taxTotal) + '</td></tr>' +
      '<tr><td>　支付的其他与经营活动有关的现金</td><td class="num expense">-' + money(d.feeTotal) + '</td></tr>' +
      boldRow('　经营活动现金净流量', opIn - opOut, (opIn - opOut) >= 0 ? 'income' : 'expense') +
      '<tr class="sec"><td>二、投资活动产生的现金流量</td><td class="num"></td></tr>' +
      '<tr><td>　购建固定资产支付的现金</td><td class="num expense">-' + money(invOut) + '</td></tr>' +
      boldRow('　投资活动现金净流量', -invOut, (-invOut) >= 0 ? 'income' : 'expense') +
      '<tr class="sec"><td>三、筹资活动产生的现金流量</td><td class="num"></td></tr>' +
      '<tr><td>　吸收投资（股本注入）</td><td class="num income">' + money(d.equityIn) + '</td></tr>' +
      '<tr><td>　偿还投资（股本抽回）</td><td class="num expense">-' + money(d.equityOut) + '</td></tr>' +
      boldRow('　筹资活动现金净流量', finNet, finNet >= 0 ? 'income' : 'expense') +
      boldRow('四、现金及现金等价物净增加额', netInc, netInc >= 0 ? 'income' : 'expense') +
      '</tbody></table>' +
      '<div class="muted" style="font-size:12px;margin-top:8px">净增加额 = 期末货币资金 − 期初货币资金。与「资金状况表」勾稽一致。</div>';
    return html;
  }

  /* ---------- 期间范围 ---------- */
  function setRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'month') { state.from = y + '-' + p(m + 1) + '-01'; state.to = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'quarter') { var q = Math.floor(m / 3) * 3; state.from = y + '-' + p(q + 1) + '-01'; state.to = y + '-' + p(q + 3) + '-' + new Date(y, q + 3, 0).getDate(); }
    else if (kind === 'year') { state.from = y + '-01-01'; state.to = y + '-12-31'; }
    else if (kind === 'all') { state.from = ''; state.to = ''; }
    render();
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    if (!state.from && !state.to) setRange('year');
    var c = document.getElementById('content');
    var hasData = rowsAll().length > 0; // 含收入/支出/账户互转/股本资金任意一种即可生成报表（资金状况表依赖互转与股本余额）
    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">统计期间：</span>' +
        '<button class="btn ghost sm" data-r="month">本月</button>' +
        '<button class="btn ghost sm" data-r="quarter">本季</button>' +
        '<button class="btn ghost sm" data-r="year">本年</button>' +
        '<button class="btn ghost sm" data-r="all">全部</button>' +
        '<div class="field"><input id="repFrom" type="date" value="' + FW.esc(state.from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="repTo" type="date" value="' + FW.esc(state.to) + '" title="结束日期"></div>' +
      '</div></div>' +
      (hasData ? '<div id="repBody" class="print-area"></div>'
        : '<div class="empty" style="padding:40px">还没有内账流水，先去「登记内账」记几笔收入支出，报表会自动生成。</div>');

    // 顶部操作区：打印 / 导出
    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="repPrint">🖨 打印</button><button class="btn ghost" id="repCsv">⬇ 导出CSV</button>';
    document.getElementById('repPrint').onclick = function () { window.print(); };
    document.getElementById('repCsv').onclick = exportCsv;

    // 事件
    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setRange(b.dataset.r); }; });
    var gf = document.getElementById('repFrom'), gt = document.getElementById('repTo');
    if (gf) gf.onchange = function () { state.from = this.value; drawBody(); };
    if (gt) gt.onchange = function () { state.to = this.value; drawBody(); };

    if (hasData) drawBody();
  }

  function drawBody() {
    var el = document.getElementById('repBody');
    if (!el) return;
    var title = state.tab === 'pl' ? '利润表' : (state.tab === 'fund' ? '资金状况表' : '现金流量表');
    var rngTxt = (state.from || state.to) ? ('（' + (state.from || '最早') + ' 至 ' + (state.to || '最新') + '）') : '（全部期间）';
    var body = state.tab === 'pl' ? drawPL(state.from, state.to)
      : state.tab === 'fund' ? drawFund(state.from, state.to)
      : drawCash(state.from, state.to);
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<h3 style="margin:0">' + title + ' <span class="sub">' + rngTxt + ' · 单位：元（由内账流水自动汇总）</span></h3>' +
      '</div>' + body;
  }

  /* ---------- 导出 CSV ---------- */
  function exportCsv() {
    var rows = [];
    var title = state.tab === 'pl' ? '利润表' : (state.tab === 'fund' ? '资金状况表' : '现金流量表');
    var rngTxt = (state.from || state.to) ? (state.from + '_' + state.to) : '全部';
    if (state.tab === 'pl') {
      var d = agg(state.from, state.to);
      rows.push(['项目', '金额']);
      rows.push(['一、营业收入', '']); Object.keys(d.income).forEach(function (k) { rows.push([k, d.income[k]]); });
      rows.push(['营业收入小计', d.incomeTotal]);
      rows.push(['减：营业成本', '']); Object.keys(d.cost).forEach(function (k) { rows.push([k, d.cost[k]]); });
      rows.push(['营业成本小计', d.costTotal]);
      rows.push(['减：税金及附加', '']); Object.keys(d.tax).forEach(function (k) { rows.push([k, d.tax[k]]); });
      rows.push(['税金及附加小计', d.taxTotal]);
      rows.push(['减：销售费用及管理费用', '']); Object.keys(d.fee).forEach(function (k) { rows.push([k, d.fee[k]]); });
      rows.push(['费用小计', d.feeTotal]);
      rows.push(['减：购置固定资产', '']); Object.keys(d.invest).forEach(function (k) { rows.push([k, d.invest[k]]); });
      rows.push(['固定资产购置小计', d.investTotal]);
      rows.push(['二、净利润', d.netProfit]);
    } else if (state.tab === 'fund') {
      var df = agg('', state.to);
      var accts = accountBalances(state.to);
      var openT = (FW.internalCalc && FW.internalCalc.getOpeningsTotal) ? FW.internalCalc.getOpeningsTotal() : 0;
      rows.push(['项目', '金额']);
      rows.push(['资产：货币资金', '']);
      accts.forEach(function (x) { rows.push([x.name, x.bal]); });
      rows.push(['货币资金合计', accts.reduce(function (s, x) { return s + x.bal; }, 0)]);
      rows.push(['负债及所有者权益', '']);
      rows.push(['期初余额（资金）', openT]);
      rows.push(['实收资本（股本净注入）', df.equityNet]);
      rows.push(['未分配利润（累计净利润）', df.netProfit]);
      rows.push(['负债及所有者权益合计', df.equityNet + df.netProfit + openT]);
    } else {
      var dc = agg(state.from, state.to);
      rows.push(['项目', '金额']);
      rows.push(['一、经营活动', '']);
      rows.push(['销售商品提供劳务收到的现金', dc.incomeTotal]);
      rows.push(['购买商品接受劳务支付的现金', -dc.costTotal]);
      rows.push(['支付的各项税费', -dc.taxTotal]);
      rows.push(['支付其他与经营有关的现金', -dc.feeTotal]);
      rows.push(['经营活动现金净流量', dc.incomeTotal - dc.costTotal - dc.taxTotal - dc.feeTotal]);
      rows.push(['二、投资活动', '']);
      rows.push(['购建固定资产支付的现金', -dc.investTotal]);
      rows.push(['投资活动现金净流量', -dc.investTotal]);
      rows.push(['三、筹资活动', '']);
      rows.push(['吸收投资（股本注入）', dc.equityIn]);
      rows.push(['偿还投资（股本抽回）', -dc.equityOut]);
      rows.push(['筹资活动现金净流量', dc.equityNet]);
      rows.push(['四、现金净增加额', dc.incomeTotal - dc.costTotal - dc.taxTotal - dc.feeTotal - dc.investTotal + dc.equityNet]);
    }
    var csv = '﻿' + [['报表：' + title + ' ' + rngTxt]].concat(rows).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title + '_' + rngTxt + '.csv';
    a.click();
    FW.toast('已导出 ' + title);
  }

  // 暴露核心计算（便于自动化验证与未来复用）
  FW.reportsCalc = {
    agg: agg,
    accountBalances: accountBalances,
    classify: classify
  };

  FW.modules = FW.modules || {};
  FW.modules.reports = {
    title: '报表中心',
    render: render,
    tabs: [
      { key: 'pl', label: '利润表' },
      { key: 'fund', label: '资金状况' },
      { key: 'cash', label: '现金流量表' }
    ],
    getTab: function () { return state.tab; },
    setTab: function (k) { state.tab = k; if (document.getElementById('repBody')) drawBody(); if (window.FW.nav) FW.nav.refreshSubNav(); }
  };
})(window);
