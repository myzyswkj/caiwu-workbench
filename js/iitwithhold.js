/* ============================================================
 * 个人所得税 · 累计预扣预缴表（知识工具子模块）
 *   工资薪金所得按月累计预扣法：
 *   累计预扣预缴应纳税所得额 = 累计收入 − 累计减除费用(5000×月数)
 *        − 累计专项扣除 − 累计专项附加扣除 − 累计其他扣除
 *   本月应预扣 =（累计应纳税所得额 × 预扣率 − 速算扣除数）− 累计已预扣
 * 说明：按全年累计口径测算，每月工资相同时因跨税率档本月预扣也会跳升；
 *       次年汇算清缴时与年终奖/劳务报酬等合并多退少补。仅供内部测算参考。
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  // 个人所得税预扣率表（年度税率表，按月累计适用）
  var TABLE = [
    { up: 36000,    rate: 0.03, qd: 0 },
    { up: 144000,   rate: 0.10, qd: 2520 },
    { up: 300000,   rate: 0.20, qd: 16920 },
    { up: 420000,   rate: 0.25, qd: 25200 },
    { up: 660000,   rate: 0.30, qd: 31920 },
    { up: 960000,   rate: 0.35, qd: 52920 },
    { up: Infinity, rate: 0.45, qd: 85920 }
  ];
  var BASIC = 5000; // 每月减除费用

  function num(v) { var n = parseFloat(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
  function r2(n) { return Math.round(n * 100) / 100; }

  function bracket(t) {
    for (var i = 0; i < TABLE.length; i++) if (t <= TABLE[i].up) return TABLE[i];
    return TABLE[TABLE.length - 1];
  }

  /* ---------------- 核心纯函数 ---------------- */
  function withholding(salary, special, add, other) {
    salary = num(salary); special = num(special); add = num(add); other = num(other);
    var months = [], prevCum = 0, yearTax = 0;
    for (var m = 1; m <= 12; m++) {
      var cumIncome = salary * m;
      var cumDeduct = (BASIC + special + add + other) * m;
      var cumTaxable = Math.max(0, cumIncome - cumDeduct);
      var b = bracket(cumTaxable);
      var cumTax = r2(cumTaxable * b.rate - b.qd);
      if (cumTax < 0) cumTax = 0;
      var monthTax = r2(cumTax - prevCum);
      prevCum = cumTax;
      months.push({
        m: m,
        cumIncome: r2(cumIncome),
        cumDeduct: r2(cumDeduct),
        cumTaxable: r2(cumTaxable),
        rate: (b.rate * 100) + '%',
        qd: b.qd,
        cumTax: cumTax,
        monthTax: monthTax
      });
      yearTax = cumTax;
    }
    return { months: months, yearTax: yearTax };
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="card"><h3>个人所得税 · 累计预扣预缴表 <span class="sub">工资薪金所得，按累计预扣法（假设各月相同）</span></h3>' +
      '<div class="form-grid">' +
        '<div class="field"><label>每月工资薪金（元）</label><input id="iw_s" type="number" step="0.01" min="0" value="20000"></div>' +
        '<div class="field"><label>每月三险一金（专项扣除，元）</label><input id="iw_sp" type="number" step="0.01" min="0" value="3000"></div>' +
        '<div class="field"><label>每月专项附加扣除（元）</label><input id="iw_add" type="number" step="0.01" min="0" value="2000"></div>' +
        '<div class="field"><label>每月其他扣除（元）</label><input id="iw_ot" type="number" step="0.01" min="0" value="0"></div>' +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn sec sm" id="iwCalc">计算</button> <span class="muted">减除费用固定 5000/月；各月不同可在结论基础上核对调整</span></div>' +
      '</div>' +
      '<div id="iwResult"></div>';

    function calc() {
      var res = withholding(
        document.getElementById('iw_s').value,
        document.getElementById('iw_sp').value,
        document.getElementById('iw_add').value,
        document.getElementById('iw_ot').value
      );
      var rows = res.months.map(function (x) {
        return '<tr>' +
          '<td>' + x.m + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.cumIncome) + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.cumDeduct) + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.cumTaxable) + '</td>' +
          '<td class="num">' + x.rate + '</td>' +
          '<td class="num">' + x.qd + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.cumTax) + '</td>' +
          '<td class="num"><b>' + FW.fmtMoney(x.monthTax) + '</b></td>' +
          '</tr>';
      }).join('');
      var html =
        '<div class="card" style="margin-top:14px"><h3>全年累计预扣预缴表 <span class="sub">年度累计应预扣预缴税额 ' + FW.fmtMoney(res.yearTax) + '</span></h3>' +
        '<div style="overflow:auto"><table class="data-table"><thead><tr>' +
        '<th>月份</th><th>累计收入</th><th>累计减除</th><th>累计应纳税所得额</th><th>预扣率</th><th>速算扣除数</th><th>累计应缴税</th><th>本月预扣</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="muted" style="margin:10px 0 0">说明：每月工资相同时，因累计应纳税所得额跨档，<b>本月预扣税额会在年中某月跳升</b>（如由 3% 升至 10%）。次年 3–6 月汇算清缴时，与全年一次性奖金、劳务报酬等合并按综合所得年度税率多退少补。</p>' +
        '</div>';
      document.getElementById('iwResult').innerHTML = html;
    }

    document.getElementById('iwCalc').onclick = calc;
    ['iw_s', 'iw_sp', 'iw_add', 'iw_ot'].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.addEventListener('input', calc);
    });
    calc();
  }

  FW.iitWithholdCalc = { withholding: withholding, bracket: bracket, TABLE: TABLE, BASIC: BASIC };
  FW.modules = FW.modules || {};
  FW.modules.iitwithhold = {
    title: '个税累计预扣表',
    render: function () { document.getElementById('topActions').innerHTML = ''; render(); }
  };
})(window);
