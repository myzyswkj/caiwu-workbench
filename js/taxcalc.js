/* ============================================================
 * 小规模税负测算 / 预警小工具
 * 借鉴：各财税软件「税负测算」「纳税筹划」模块
 * 适用：增值税小规模纳税人（季报）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  // 预设政策常量（截至 2027 年底的优惠口径，实际以当年政策为准）
  var EXEMPT_QUARTER = 300000;   // 季度不含税销售额 ≤ 30万免征增值税
  var ADD_RATES = { city: 0.07, county: 0.05, other: 0.01 }; // 城建税（市区/县城/其他）
  var EDU = 0.03, LOCAL_EDU = 0.02; // 教育费附加 / 地方教育附加
  var HALF = 0.5; // 小规模纳税人六税两费减半

  // 个体户经营所得五级超额累进（年应纳税所得额）
  var INDIV_TABLE = [
    [30000, 0.05, 0], [90000, 0.10, 1500], [300000, 0.20, 10500],
    [500000, 0.30, 40500], [Infinity, 0.35, 65500]
  ];

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function calcCorp(annualProfit) {
    // 小型微利企业：应纳税所得额 ≤300万，实际税负 5%（2023–2027）
    if (annualProfit <= 3000000) return annualProfit * 0.05;
    return annualProfit * 0.25; // 超出优惠门槛，按 25% 简化
  }
  function calcIndiv(annualProfit) {
    var tax = 0;
    for (var i = 0; i < INDIV_TABLE.length; i++) {
      if (annualProfit <= INDIV_TABLE[i][0]) { tax = annualProfit * INDIV_TABLE[i][1] - INDIV_TABLE[i][2]; break; }
    }
    if (tax < 0) tax = 0;
    if (annualProfit <= 2000000) tax *= HALF; // 2023–2027 减半
    return tax;
  }

  function calc() {
    var incSales = num(document.getElementById('tc_sales').value); // 季度含税销售额
    var rate = num(document.getElementById('tc_rate').value) / 100; // 征收率
    var region = document.getElementById('tc_region').value;
    var subject = document.getElementById('tc_subject').value; // corp / indiv
    var quarterProfit = num(document.getElementById('tc_profit').value); // 季度利润（应纳税所得额）

    var salesEx = incSales / (1 + rate); // 不含税销售额
    var exempt = salesEx <= EXEMPT_QUARTER + 0.0001; // 是否免征增值税

    var vat = exempt ? 0 : salesEx * rate;
    var addRate = (ADD_RATES[region] + EDU + LOCAL_EDU);
    var addTax = vat * addRate * HALF; // 附加税（减半）

    var annualProfit = quarterProfit * 4; // 利润按季度×4 估算年额
    var incomeTax = subject === 'corp' ? calcCorp(annualProfit) : calcIndiv(annualProfit);
    incomeTax = incomeTax / 4; // 还原回季度

    var totalTax = vat + addTax + incomeTax;
    var burden = incSales > 0 ? totalTax / incSales * 100 : 0;

    var warnings = [];
    if (salesEx > EXEMPT_QUARTER - 30000 && salesEx <= EXEMPT_QUARTER + 0.0001) {
      warnings.push({ level: 'warn', text: '⚠️ 临近增值税免税起征点（季度不含税 ' + FW.fmtMoney(EXEMPT_QUARTER) + '）：再开票将失去免税资格，本季增值税全额按 ' + (rate * 100) + '% 缴纳，建议合理规划开票节奏。' });
    }
    if (!exempt) {
      warnings.push({ level: 'info', text: 'ℹ️ 本季不含税销售额已超 ' + FW.fmtMoney(EXEMPT_QUARTER) + '，不享受增值税免征，增值税与附加税按全额计。' });
    } else if (vat === 0) {
      warnings.push({ level: 'ok', text: '✅ 本季享受小规模纳税人增值税及附加税免征优惠。' });
    }
    if (burden > 5) {
      warnings.push({ level: 'warn', text: '⚠️ 综合税负率约 ' + burden.toFixed(2) + '%，相对偏高，可关注成本费用归集（如取得合规发票、固定资产折旧等）以降低税负。' });
    }
    if (subject === 'corp' && quarterProfit * 4 > 3000000) {
      warnings.push({ level: 'warn', text: '⚠️ 年化利润超 300 万，将不再符合小型微利企业优惠（税负升至 25%），可考虑合理分流。' });
    }

    var rows = [
      ['季度含税销售额', FW.fmtMoney(incSales)],
      ['征收率', (rate * 100).toFixed(0) + '%'],
      ['不含税销售额', FW.fmtMoney(salesEx)],
      ['增值税' + (exempt ? '（免征）' : ''), FW.fmtMoney(vat)],
      ['附加税费（减半）', FW.fmtMoney(addTax)],
      [subject === 'corp' ? '企业所得税（小型微利 5%）' : '经营所得个税（个体户）', FW.fmtMoney(incomeTax)],
      ['本季税费合计', FW.fmtMoney(totalTax)],
      ['综合税负率', burden.toFixed(2) + '%']
    ];
    var html =
      '<div class="card"><table><tbody>' +
        rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td class="num"><b>' + r[1] + '</b></td></tr>'; }).join('') +
      '</tbody></table></div>';

    html += '<div class="card" style="margin-top:14px"><h3>测算结论与预警</h3>';
    if (!warnings.length) html += '<div class="empty">填写数据后将给出测算结论与预警。</div>';
    else html += warnings.map(function (w) {
      var cls = w.level === 'ok' ? 'tcout-ok' : w.level === 'warn' ? 'tcout-warn' : 'tcout-info';
      return '<div class="tcout ' + cls + '">' + w.text + '</div>';
    }).join('');
    html += '</div>';

    document.getElementById('tcResult').innerHTML = html;
  }

  function render() {
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="card"><h3>小规模纳税人税负测算 <span class="sub">季报口径 · 数据仅供测算参考，以当年实际政策为准</span></h3>' +
      '<div class="form-grid">' +
        '<div class="field"><label>季度含税销售额（元）</label><input id="tc_sales" type="number" step="0.01" min="0" value="280000" placeholder="如：280000"></div>' +
        '<div class="field"><label>增值税征收率</label><select id="tc_rate"><option value="1" selected>1%（2023–2027 优惠）</option><option value="3">3%（法定）</option></select></div>' +
        '<div class="field"><label>城建税地区</label><select id="tc_region"><option value="city" selected>市区 7%</option><option value="county">县城/镇 5%</option><option value="other">其他 1%</option></select></div>' +
        '<div class="field"><label>主体类型</label><select id="tc_subject"><option value="corp" selected>有限公司（小型微利）</option><option value="indiv">个体工商户</option></select></div>' +
        '<div class="field full"><label>季度利润（应纳税所得额，元）</label><input id="tc_profit" type="number" step="0.01" value="50000" placeholder="用于估算所得税"></div>' +
      '</div>' +
      '<p class="muted" style="margin:4px 0 0">提示：免税起征点为「季度不含税销售额 ≤ ' + FW.fmtMoney(EXEMPT_QUARTER) + '」。不含税销售额 = 含税销售额 ÷ (1 + 征收率)。</p>' +
      '</div>' +
      '<div id="tcResult"></div>';

    ['tc_sales', 'tc_rate', 'tc_region', 'tc_subject', 'tc_profit'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', calc);
      document.getElementById(id).addEventListener('change', calc);
    });
    calc();
  }

  FW.modules = FW.modules || {};
  FW.modules.taxcalc = { title: '税负测算', render: render };
})(window);
