/* ============================================================
 * 税负率计算（知识工具子模块）
 *   增值税税负率 / 流转税税负率 / 所得税税负率 / 综合税负率
 *   并与行业经验区间对比，给出「税负率异常」自查提示
 * 说明：行业区间为实务经验参考值，各地税务机关口径不同，仅供内部自查
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  // 城建税税率（按纳税人所在地）
  var ADD_RATES = { city: 0.07, county: 0.05, other: 0.01 };
  var EDU = 0.03, LOCAL_EDU = 0.02; // 教育费附加 / 地方教育附加

  // 行业增值税税负率经验参考区间（%）
  var INDUSTRY = [
    { key: 'none', name: '不对比（仅计算）', min: null, max: null },
    { key: 'wholesale', name: '商业批发', min: 0.9, max: 1.5 },
    { key: 'retail', name: '商业零售', min: 1.5, max: 2.5 },
    { key: 'manufacture', name: '工业制造', min: 2.0, max: 3.5 },
    { key: 'food', name: '农副食品加工', min: 1.0, max: 2.5 },
    { key: 'construction', name: '建筑安装', min: 1.5, max: 3.0 },
    { key: 'transport', name: '交通运输', min: 2.0, max: 3.0 },
    { key: 'catering', name: '餐饮住宿', min: 2.0, max: 4.0 },
    { key: 'service', name: '现代服务/咨询', min: 3.0, max: 6.0 },
    { key: 'software', name: '软件/信息技术', min: 3.0, max: 6.0 },
    { key: 'lease', name: '租赁服务', min: 3.0, max: 5.0 },
    { key: 'realestate', name: '房地产开发', min: 4.0, max: 5.0 }
  ];

  function industryOf(key) {
    for (var i = 0; i < INDUSTRY.length; i++) if (INDUSTRY[i].key === key) return INDUSTRY[i];
    return INDUSTRY[0];
  }

  function num(v) { var n = parseFloat(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
  function r2(n) { return Math.round(n * 100) / 100; }

  /* ---------------- 核心纯函数：税负率计算 ---------------- */
  function calcBurden(i) {
    i = i || {};
    var income = num(i.income); // 不含税营业收入（计税口径）

    // 增值税：直接填 or 由销项-进项推导
    var vat;
    if (i.vatMode === 'derive') vat = Math.max(0, num(i.outputTax) - num(i.inputTax));
    else vat = num(i.vatPayable);
    if (vat < 0) vat = 0;

    // 附加税费：自动（城建+教育费附加+地方教育附加，可减半）或手填
    var surtax, surRate = 0;
    if (i.surtaxMode === 'manual') {
      surtax = num(i.surtax);
    } else {
      var city = ADD_RATES[i.region] !== undefined ? ADD_RATES[i.region] : ADD_RATES.city;
      surRate = city + EDU + LOCAL_EDU;
      surtax = vat * surRate * (i.halfSurtax ? 0.5 : 1);
    }
    if (surtax < 0) surtax = 0;

    var cit = num(i.cit);        // 企业所得税（或个体户经营所得个税）
    var iit = num(i.iit);        // 代扣代缴个税（工资薪金）
    var other = num(i.otherTax); // 印花税/房产税/土地使用税等
    var incIit = !!i.includeIit;

    var totalTax = vat + surtax + cit + other + (incIit ? iit : 0);
    var profit = num(i.profit);

    function ratio(a, b) { return b > 0 ? r2(a / b * 100) : 0; }

    return {
      income: income, profit: profit,
      vat: vat, surtax: surtax, surtaxRateUsed: surRate,
      cit: cit, iit: iit, otherTax: other,
      includeIit: incIit, totalTax: totalTax,
      vatRate: ratio(vat, income),            // 增值税税负率
      turnoverRate: ratio(vat + surtax, income), // 流转税（含附加）税负率
      citRate: ratio(cit, income),            // 所得税税负率（收入口径）
      citOnProfit: ratio(cit, profit),        // 实际所得税率（利润口径）
      overallRate: ratio(totalTax, income),   // 综合税负率
      netProfitRate: ratio(profit, income)    // 利润率（对照）
    };
  }

  /* ---------------- 核心纯函数：行业区间判定 ---------------- */
  function judge(vatRate, industryKey) {
    var ind = industryOf(industryKey);
    if (!ind || ind.min === null) return { level: 'none', ind: ind };
    if (vatRate < ind.min) return { level: 'low', ind: ind };
    if (vatRate > ind.max) return { level: 'high', ind: ind };
    return { level: 'normal', ind: ind };
  }

  /* ---------------- 核心纯函数：结论与预警 ---------------- */
  function buildWarnings(res, industryKey) {
    var w = [];
    if (!res || res.income <= 0) {
      w.push({ level: 'info', text: 'ℹ️ 请先填写「不含税营业收入」，税负率 = 各项税额 ÷ 不含税营业收入，收入为 0 时无法计算。' });
      return w;
    }

    var j = judge(res.vatRate, industryKey);
    if (j.level === 'low') {
      w.push({ level: 'warn', text: '⚠️ 增值税税负率 ' + res.vatRate + '%，低于「' + j.ind.name + '」参考下限 ' + j.ind.min + '%。税务机关常将「税负率偏低」列为风险指标，常见原因：进项抵扣过多（如集中采购/大额固定资产）、存在未开票收入未申报、虚增进项。建议自查并留存业务合同、出入库、资金流水等佐证资料。' });
    } else if (j.level === 'high') {
      w.push({ level: 'warn', text: '⚠️ 增值税税负率 ' + res.vatRate + '%，高于「' + j.ind.name + '」参考上限 ' + j.ind.max + '%。多为进项抵扣不足：供应商为小规模无法开专票、取得普票未抵扣、专票逾期未勾选认证。建议优先选择可开专票的供应商，并按月勾选认证。' });
    } else if (j.level === 'normal') {
      w.push({ level: 'ok', text: '✅ 增值税税负率 ' + res.vatRate + '%，处于「' + j.ind.name + '」参考区间 ' + j.ind.min + '%–' + j.ind.max + '% 内，属正常水平。' });
    }

    if (res.cit > 0 && res.profit > 0) {
      var eff = res.citOnProfit;
      if (eff <= 5.5 && eff > 0) w.push({ level: 'ok', text: '✅ 实际所得税率（所得税 ÷ 利润总额）约 ' + eff + '%，与小型微利企业优惠税负（5%）接近，说明已享受优惠。' });
      else if (eff > 25.5) w.push({ level: 'warn', text: '⚠️ 实际所得税率约 ' + eff + '%，高于法定 25%，通常是存在纳税调增（如超标业务招待费、无票支出、罚款滞纳金）。建议核对纳税调整明细，规范取票。' });
    }
    if (res.profit > 0 && res.income > 0 && res.netProfitRate > 0) {
      w.push({ level: 'info', text: 'ℹ️ 利润率 ' + res.netProfitRate + '%，综合税负率 ' + res.overallRate + '%。综合税负率长期高于利润率时，说明税负侵蚀利润较重，可从进项管理、税收优惠适用两方面着手。' });
    }
    if (res.income > 0 && res.totalTax === 0) {
      w.push({ level: 'info', text: 'ℹ️ 当前各税种金额均为 0，综合税负率为 0%。若确为享受小微免税，属正常；否则请补充各税种金额。' });
    }
    if (!res.includeIit && res.iit > 0) {
      w.push({ level: 'info', text: 'ℹ️ 代扣代缴个税 ' + FW.fmtMoney(res.iit) + ' 未计入综合税负（默认口径：代扣个税由员工负担，不属企业税负）。如需计入，勾选上方选项。' });
    }
    return w;
  }

  /* ---------------- 渲染 ---------------- */
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function checked(id) { var e = document.getElementById(id); return !!(e && e.checked); }

  function readInput() {
    return {
      income: val('tb_income'),
      vatMode: val('tb_vatmode'),
      vatPayable: val('tb_vat'),
      outputTax: val('tb_output'),
      inputTax: val('tb_input'),
      surtaxMode: val('tb_surmode'),
      region: val('tb_region'),
      halfSurtax: checked('tb_half'),
      surtax: val('tb_surtax'),
      cit: val('tb_cit'),
      iit: val('tb_iit'),
      includeIit: checked('tb_inciit'),
      otherTax: val('tb_other'),
      profit: val('tb_profit')
    };
  }

  function toggleFields() {
    var derive = val('tb_vatmode') === 'derive';
    var f1 = document.getElementById('f_vat'), f2 = document.getElementById('f_output'), f3 = document.getElementById('f_input');
    if (f1) f1.style.display = derive ? 'none' : '';
    if (f2) f2.style.display = derive ? '' : 'none';
    if (f3) f3.style.display = derive ? '' : 'none';
    var manual = val('tb_surmode') === 'manual';
    var g1 = document.getElementById('f_surtax'), g2 = document.getElementById('f_region');
    if (g1) g1.style.display = manual ? '' : 'none';
    if (g2) g2.style.display = manual ? 'none' : '';
  }

  function calc() {
    toggleFields();
    var input = readInput();
    var res = calcBurden(input);
    var industryKey = val('tb_industry');
    var ind = industryOf(industryKey);

    var statCls = '';
    var j = judge(res.vatRate, industryKey);
    if (j.level === 'low' || j.level === 'high') statCls = ' style="color:var(--expense)"';
    else if (j.level === 'normal') statCls = ' style="color:var(--income)"';

    var html =
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">增值税税负率</div><div class="value"' + statCls + '>' + res.vatRate.toFixed(2) + '%</div></div>' +
        '<div class="stat"><div class="label">流转税税负率（含附加）</div><div class="value">' + res.turnoverRate.toFixed(2) + '%</div></div>' +
        '<div class="stat"><div class="label">所得税税负率</div><div class="value">' + res.citRate.toFixed(2) + '%</div></div>' +
        '<div class="stat"><div class="label">综合税负率</div><div class="value">' + res.overallRate.toFixed(2) + '%</div></div>' +
      '</div>';

    var rows = [
      ['不含税营业收入', FW.fmtMoney(res.income)],
      ['应纳增值税', FW.fmtMoney(res.vat)],
      ['附加税费' + (val('tb_surmode') === 'manual' ? '' : '（自动按 ' + (res.surtaxRateUsed * 100).toFixed(0) + '%' + (checked('tb_half') ? ' × 减半' : '') + '）'), FW.fmtMoney(res.surtax)],
      ['企业所得税 / 经营所得个税', FW.fmtMoney(res.cit)],
      ['代扣代缴个税' + (res.includeIit ? '（已计入）' : '（未计入）'), FW.fmtMoney(res.iit)],
      ['其他税费（印花/房产/土地等）', FW.fmtMoney(res.otherTax)],
      ['税费合计（计入税负口径）', FW.fmtMoney(res.totalTax)],
      ['利润总额', FW.fmtMoney(res.profit)],
      ['实际所得税率（所得税÷利润总额）', res.citOnProfit.toFixed(2) + '%'],
      ['利润率（利润总额÷收入）', res.netProfitRate.toFixed(2) + '%']
    ];
    html += '<div class="card"><h3>税额与税负率明细' +
      (ind.min !== null ? '<span class="sub">行业参考：' + FW.esc(ind.name) + ' 增值税税负率 ' + ind.min + '%–' + ind.max + '%</span>' : '') +
      '</h3><table><tbody>' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td class="num"><b>' + r[1] + '</b></td></tr>'; }).join('') +
      '</tbody></table></div>';

    var warns = buildWarnings(res, industryKey);
    html += '<div class="card" style="margin-top:14px"><h3>结论与风险提示</h3>';
    html += warns.length
      ? warns.map(function (w) {
          var cls = w.level === 'ok' ? 'tcout-ok' : w.level === 'warn' ? 'tcout-warn' : 'tcout-info';
          return '<div class="tcout ' + cls + '">' + w.text + '</div>';
        }).join('')
      : '<div class="empty">填写数据后将给出结论与风险提示。</div>';
    html += '</div>';

    document.getElementById('tbResult').innerHTML = html;
  }

  /* 从内账带入本年数据（收入 / 税金 / 利润） */
  function importFromLedger() {
    if (!FW.reportsCalc || typeof FW.reportsCalc.agg !== 'function') { FW.toast('内账数据不可用'); return; }
    var y = new Date().getFullYear();
    var d = FW.reportsCalc.agg(y + '-01-01', y + '-12-31');
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.value = v ? r2(v) : 0; };
    set('tb_income', d.incomeTotal);
    set('tb_other', d.taxTotal);
    set('tb_profit', d.netProfit);
    calc();
    FW.toast('已带入 ' + y + ' 年内账数据：收入 ' + FW.fmtMoney(d.incomeTotal) + '，税金 ' + FW.fmtMoney(d.taxTotal) + '（税金已填入「其他税费」，请按税种拆分）');
  }

  function render() {
    var c = document.getElementById('content');
    var indOpts = INDUSTRY.map(function (g) {
      return '<option value="' + g.key + '"' + (g.key === 'manufacture' ? ' selected' : '') + '>' + FW.esc(g.name) +
        (g.min !== null ? '（' + g.min + '%–' + g.max + '%）' : '') + '</option>';
    }).join('');

    c.innerHTML =
      '<div class="card"><h3>税负率计算 <span class="sub">税负率 = 各项税额 ÷ 不含税营业收入 · 结果仅供内部自查参考</span></h3>' +
      '<div class="form-grid">' +
        '<div class="field full"><label>不含税营业收入（元）<span class="muted" style="font-weight:400">　含税收入 ÷ (1+税率) 后填入</span></label><input id="tb_income" type="number" step="0.01" min="0" value="1000000" placeholder="如：1000000"></div>' +

        '<div class="field"><label>增值税取数方式</label><select id="tb_vatmode"><option value="direct" selected>直接填应纳增值税</option><option value="derive">按销项 − 进项推导</option></select></div>' +
        '<div class="field"><label>所属行业（税负率对比）</label><select id="tb_industry">' + indOpts + '</select></div>' +

        '<div class="field" id="f_vat"><label>应纳增值税（元）</label><input id="tb_vat" type="number" step="0.01" min="0" value="25000"></div>' +
        '<div class="field" id="f_output" style="display:none"><label>销项税额（元）</label><input id="tb_output" type="number" step="0.01" min="0" value="130000"></div>' +
        '<div class="field" id="f_input" style="display:none"><label>可抵扣进项税额（元）</label><input id="tb_input" type="number" step="0.01" min="0" value="105000"></div>' +

        '<div class="field"><label>附加税费取数方式</label><select id="tb_surmode"><option value="auto" selected>自动计算（城建+教育+地方教育）</option><option value="manual">手工填写</option></select></div>' +
        '<div class="field" id="f_region"><label>城建税地区</label><select id="tb_region"><option value="city" selected>市区 7%</option><option value="county">县城/镇 5%</option><option value="other">其他 1%</option></select><label class="chk-inline" style="margin:2px 0 0"><input type="checkbox" id="tb_half" checked>六税两费减半（小规模/小微）</label></div>' +
        '<div class="field" id="f_surtax" style="display:none"><label>附加税费（元）</label><input id="tb_surtax" type="number" step="0.01" min="0" value="0"></div>' +

        '<div class="field"><label>企业所得税 / 经营所得个税（元）</label><input id="tb_cit" type="number" step="0.01" min="0" value="15000"></div>' +
        '<div class="field"><label>代扣代缴个税（元）</label><input id="tb_iit" type="number" step="0.01" min="0" value="0"><label class="chk-inline" style="margin:2px 0 0"><input type="checkbox" id="tb_inciit">计入综合税负</label></div>' +

        '<div class="field"><label>其他税费（印花/房产/土地等，元）</label><input id="tb_other" type="number" step="0.01" min="0" value="0"></div>' +
        '<div class="field"><label>利润总额（元，选填）</label><input id="tb_profit" type="number" step="0.01" value="300000" placeholder="用于算实际所得税率"></div>' +
      '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn sec sm" id="tbImport">📥 从内账带入本年数据</button>' +
        '<button class="btn ghost sm" id="tbReset">↺ 重置</button>' +
      '</div>' +
      '</div>' +
      '<div id="tbResult"></div>' +
      '<div class="card" style="margin-top:14px"><h3>计算口径说明</h3>' +
        '<table><tbody>' +
          '<tr><td>增值税税负率</td><td>应纳增值税 ÷ 不含税营业收入 × 100%<br><span class="muted">一般纳税人：应纳增值税 = 销项税额 − 进项税额；小规模：不含税销售额 × 征收率</span></td></tr>' +
          '<tr><td>流转税税负率</td><td>（应纳增值税 + 附加税费）÷ 不含税营业收入 × 100%<br><span class="muted">附加税费 = 增值税 ×（城建 7%/5%/1% + 教育 3% + 地方教育 2%），小规模及小微可减半</span></td></tr>' +
          '<tr><td>所得税税负率</td><td>应纳所得税额 ÷ 不含税营业收入 × 100%</td></tr>' +
          '<tr><td>实际所得税率</td><td>应纳所得税额 ÷ 利润总额 × 100%<br><span class="muted">小型微利企业实际约 5%；高于 25% 通常存在纳税调增</span></td></tr>' +
          '<tr><td>综合税负率</td><td>全部税费合计 ÷ 不含税营业收入 × 100%<br><span class="muted">代扣代缴个税由员工负担，默认不计入企业税负，可勾选计入</span></td></tr>' +
        '</tbody></table>' +
        '<p class="muted" style="margin:10px 0 0">行业参考区间为实务经验值（税务机关「税负率异常」预警常用口径），各地各行业标准不同，请以主管税务机关口径为准。</p>' +
      '</div>';

    ['tb_income', 'tb_vatmode', 'tb_vat', 'tb_output', 'tb_input', 'tb_surmode', 'tb_region', 'tb_half',
      'tb_surtax', 'tb_cit', 'tb_iit', 'tb_inciit', 'tb_other', 'tb_profit', 'tb_industry'].forEach(function (id) {
      var e = document.getElementById(id);
      if (!e) return;
      e.addEventListener('input', calc);
      e.addEventListener('change', calc);
    });
    var imp = document.getElementById('tbImport');
    if (imp) imp.onclick = importFromLedger;
    var rst = document.getElementById('tbReset');
    if (rst) rst.onclick = function () { render(); };
    calc();
  }

  // 暴露纯函数便于单元测试与复用
  FW.taxBurdenCalc = {
    INDUSTRY: INDUSTRY,
    calcBurden: calcBurden,
    judge: judge,
    buildWarnings: buildWarnings,
    industryOf: industryOf
  };

  FW.modules = FW.modules || {};
  FW.modules.taxburden = {
    title: '税负率计算',
    render: function () { document.getElementById('topActions').innerHTML = ''; render(); }
  };
})(window);
