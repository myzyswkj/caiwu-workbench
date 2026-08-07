/* ============================================================
 * 印花税计算（知识工具子模块）
 *   按《印花税法》税目与比例税率逐项计算并累加
 *   支持"六税两费"减半（小规模纳税人/小型微利企业/个体工商户，证券交易除外）
 * 说明：税目税率以《印花税法》及最新优惠为准，仅供内部测算参考
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  // 印花税税目与比例税率（2022-07-01《印花税法》施行）
  var STAMP = [
    { key: 'purchase',        name: '买卖合同（购销）',            rate: 0.0003 },
    { key: 'processing',      name: '承揽合同',                  rate: 0.0005 },
    { key: 'construction',    name: '建设工程合同',               rate: 0.0003 },
    { key: 'transport',       name: '运输合同',                  rate: 0.0005 },
    { key: 'tech',            name: '技术合同',                  rate: 0.0003 },
    { key: 'lease',           name: '租赁合同',                  rate: 0.001 },
    { key: 'storage',         name: '仓储合同',                  rate: 0.001 },
    { key: 'safekeeping',     name: '保管合同',                  rate: 0.001 },
    { key: 'property_ins',    name: '财产保险合同',               rate: 0.001 },
    { key: 'loan',            name: '借款合同',                  rate: 0.00005 },
    { key: 'property_transfer', name: '产权转移书据（股权/不动产/资产）', rate: 0.0005 },
    { key: 'ip_transfer',     name: '产权转移书据（商标/专利/著作权/专有技术）', rate: 0.0003 },
    { key: 'books',           name: '营业账簿（实收资本+资本公积）',   rate: 0.00025 },
    { key: 'securities',      name: '证券交易（出让方·成交金额）',    rate: 0.001 }
  ];

  function byKey(k) { for (var i = 0; i < STAMP.length; i++) if (STAMP[i].key === k) return STAMP[i]; return null; }
  function num(v) { var n = parseFloat(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function r4(n) { return Math.round(n * 10000) / 10000; }

  /* ---------------- 核心纯函数 ---------------- */
  // rows: [{key, amount}]；half: 是否享受六税两费减半（证券交易除外）
  function calcStamp(rows, half) {
    rows = rows || [];
    var total = 0, lines = [];
    rows.forEach(function (r) {
      var it = byKey(r.key);
      if (!it) return; // 未知税目忽略
      var amt = num(r.amount);
      var apply = (half && it.key !== 'securities') ? 0.5 : 1; // 证券交易不减半
      var tax = amt * it.rate * apply;
      total += tax;
      lines.push({ name: it.name, ratePct: r4(it.rate * 100), amount: amt, half: apply < 1, tax: r2(tax) });
    });
    return { lines: lines, total: r2(total) };
  }

  /* ---------------- 渲染 ---------------- */
  function optionHtml(selKey) {
    return STAMP.map(function (g) {
      return '<option value="' + g.key + '"' + (g.key === selKey ? ' selected' : '') + '>' + FW.esc(g.name) + '（' + r4(g.rate * 100) + '%）</option>';
    }).join('');
  }

  function render() {
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="card"><h3>印花税计算 <span class="sub">按《印花税法》税目与税率 · 结果仅供内部测算参考</span></h3>' +
      '<label class="chk-inline" style="margin:2px 0 10px"><input type="checkbox" id="st_half"> 享受"六税两费"减半（小规模/小微/个体户，证券交易除外）</label>' +
      '<table class="data-table" style="margin-bottom:8px"><thead><tr><th>税目</th><th>计税金额（元）</th><th>税率</th><th>应纳税额（元）</th><th></th></tr></thead>' +
      '<tbody id="stRows"></tbody></table>' +
      '<button class="btn ghost sm" id="stAdd">＋ 添加一行</button>' +
      '<div class="stat-row" style="margin-top:12px"><div class="stat"><div class="label">印花税合计</div><div class="value" id="stTotal" style="color:var(--sidebar-bg)">¥0.00</div></div></div>' +
      '</div>' +
      '<div class="card" style="margin-top:14px"><h3>计算说明</h3>' +
      '<table><tbody>' +
      '<tr><td>计税公式</td><td>应纳税额 = 计税金额 × 适用税率（按比例税率的税目）</td></tr>' +
      '<tr><td>常见税率</td><td>借款合同 <b>0.005%</b>、买卖/建设工程/技术合同 <b>0.03%</b>、承揽/运输/产权转移(股权·不动产) <b>0.05%</b>、租赁/仓储/保管/财产保险合同/证券交易 <b>0.1%</b>、营业账簿(实收资本+资本公积) <b>0.025%</b></td></tr>' +
      '<tr><td>减半优惠</td><td>小规模纳税人、小型微利企业、个体工商户可享"六税两费"减半（证券交易印花税除外）。营业账簿、权利许可证照等另有免征规定，以最新政策为准。</td></tr>' +
      '</tbody></table></div>';

    var state = { rows: [ { key: 'purchase', amount: 1000000 }, { key: 'loan', amount: 500000 } ] };

    function syncFromDom() {
      state.rows.forEach(function (r, idx) {
        var k = document.querySelector('.st-key[data-i="' + idx + '"]');
        var a = document.querySelector('.st-amt[data-i="' + idx + '"]');
        if (k) r.key = k.value;
        if (a) r.amount = a.value;
      });
    }

    function recalc() {
      syncFromDom();
      var half = document.getElementById('st_half').checked;
      var res = calcStamp(state.rows, half);
      var trs = document.querySelectorAll('#stRows tr');
      res.lines.forEach(function (ln, i) {
        var rateCell = trs[i] && trs[i].querySelector('.st-rate');
        var taxCell = trs[i] && trs[i].querySelector('.st-tax');
        if (rateCell) rateCell.textContent = ln.ratePct + '%' + (ln.half ? '（减半）' : '');
        if (taxCell) taxCell.textContent = FW.fmtMoney(ln.tax);
      });
      var totalEl = document.getElementById('stTotal');
      if (totalEl) totalEl.textContent = FW.fmtMoney(res.total);
    }

    function draw() {
      var tb = document.getElementById('stRows');
      tb.innerHTML = state.rows.map(function (r, idx) {
        return '<tr>' +
          '<td><select class="st-key" data-i="' + idx + '">' + optionHtml(r.key) + '</select></td>' +
          '<td><input class="st-amt" data-i="' + idx + '" type="number" step="0.01" min="0" value="' + num(r.amount) + '"></td>' +
          '<td class="st-rate num"></td>' +
          '<td class="st-tax num"></td>' +
          '<td><button class="st-del btn ghost sm" data-i="' + idx + '">✕</button></td>' +
          '</tr>';
      }).join('');
      recalc();
    }

    var stRows = document.getElementById('stRows');
    stRows.addEventListener('change', function (e) { if (e.target.classList.contains('st-key')) recalc(); });
    stRows.addEventListener('input', function (e) { if (e.target.classList.contains('st-amt')) recalc(); });
    stRows.addEventListener('click', function (e) {
      if (!e.target.classList.contains('st-del')) return;
      var i = parseInt(e.target.getAttribute('data-i'), 10);
      if (!isNaN(i) && state.rows.length > 1) { state.rows.splice(i, 1); draw(); }
    });
    document.getElementById('stAdd').addEventListener('click', function () { state.rows.push({ key: 'purchase', amount: 0 }); draw(); });
    document.getElementById('st_half').addEventListener('change', recalc);

    draw();
  }

  FW.stampTaxCalc = { STAMP: STAMP, calcStamp: calcStamp };
  FW.modules = FW.modules || {};
  FW.modules.stamptax = {
    title: '印花税计算',
    render: function () { document.getElementById('topActions').innerHTML = ''; render(); }
  };
})(window);
