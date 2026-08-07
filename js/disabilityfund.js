/* ============================================================
 * 残疾人就业保障金测算（知识工具子模块）
 *   保障金 =（上年在职职工人数 × 1.5% − 上年安排残疾人数）× 上年职工年平均工资 × 分档系数
 *   分档减缴（2023–2027）：安排比例≥1%(含)且<1.5% → ×50%；<1% → ×90%；
 *   安排比例≥1.5% 或 在职职工≤30人 → 免征；年平均工资超社平2倍按上限计征
 * 说明：依据财税[2015]72号及2023–2027延续优惠，仅供内部测算参考
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  var RATIO = 0.015; // 安排残疾人就业比例 1.5%

  function num(v) { var n = parseFloat(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
  function r2(n) { return Math.round(n * 100) / 100; }

  /* ---------------- 核心纯函数 ---------------- */
  function calcFund(N, D, W, capEnabled, cap) {
    N = num(N); D = num(D); W = num(W); cap = num(cap);
    var ratio = N > 0 ? D / N : 0;
    var required = r2(N * RATIO);

    if (N <= 0) return { exempt: true, reason: '在职职工人数应为正数', payable: 0, cappedW: W, base: 0, band: '0%', required: required, ratio: ratio, gap: 0 };
    if (N <= 30) return { exempt: true, reason: '在职职工 ≤ 30 人，2023–2027 免征残保金', payable: 0, cappedW: W, base: 0, band: '0%', required: required, ratio: ratio, gap: 0 };

    var cappedW = (capEnabled && cap > 0 && W > cap) ? cap : W;
    var gap = N * RATIO - D; // 应安排 − 实际安排
    if (gap <= 0) return { exempt: true, reason: '已安排残疾人就业达到 1.5% 比例，免征', payable: 0, cappedW: cappedW, base: 0, band: '0%', required: required, ratio: ratio, gap: 0 };

    var base = gap * cappedW;
    var band, coef;
    if (ratio >= 0.01) { band = '50%'; coef = 0.5; }   // 1% ≤ 比例 < 1.5%
    else { band = '90%'; coef = 0.9; }                  // 比例 < 1%
    var payable = base * coef;

    return { exempt: false, reason: '', payable: r2(payable), base: r2(base), band: band, coef: coef, cappedW: cappedW, required: required, ratio: ratio, gap: r2(gap) };
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="card"><h3>残疾人就业保障金测算 <span class="sub">依据财税[2015]72号及 2023–2027 延续优惠</span></h3>' +
      '<div class="form-grid">' +
        '<div class="field"><label>上年在职职工人数（人）</label><input id="df_N" type="number" step="1" min="0" value="50"></div>' +
        '<div class="field"><label>上年实际安排残疾人就业人数（人）</label><input id="df_D" type="number" step="1" min="0" value="0"></div>' +
        '<div class="field"><label>上年在职职工年平均工资（元）</label><input id="df_W" type="number" step="0.01" min="0" value="80000"></div>' +
        '<div class="field"><label>社平工资 2 倍上限（元，留空=不封顶）</label><input id="df_cap" type="number" step="0.01" min="0" placeholder="如：160000"></div>' +
      '</div>' +
      '<label class="chk-inline" style="margin:6px 0 0"><input type="checkbox" id="df_capOn"> 启用年平均工资封顶（超社平 2 倍按上限计）</label>' +
      '<div style="margin-top:12px"><button class="btn sec sm" id="dfCalc">计算</button></div>' +
      '</div>' +
      '<div id="dfResult"></div>' +
      '<div class="card" style="margin-top:14px"><h3>政策要点</h3>' +
      '<table><tbody>' +
      '<tr><td>分档减缴（2023–2027）</td><td>残疾人就业比例 ≥1%(含) 且 <1.5% → 应缴费额 ×50%；<1% → ×90%；≥1.5% 或 在职职工 ≤30 人 → 免征。</td></tr>' +
      '<tr><td>工资封顶</td><td>在职职工年平均工资超过当地社会平均工资 2 倍的，按社平工资 2 倍计征。</td></tr>' +
      '<tr><td>计征公式</td><td>保障金 =（上年职工人数 × 1.5% − 上年安排残疾人数）× 上年职工年平均工资 × 分档系数。</td></tr>' +
      '</tbody></table></div>';

    function calc() {
      var r = calcFund(
        document.getElementById('df_N').value,
        document.getElementById('df_D').value,
        document.getElementById('df_W').value,
        document.getElementById('df_capOn').checked,
        document.getElementById('df_cap').value
      );
      var cls = r.exempt ? ' style="color:var(--income)"' : ' style="color:var(--expense)"';
      var extra = r.exempt ? '' :
        '<tr><td>计征工资基数（封顶后）</td><td class="num">' + FW.fmtMoney(r.cappedW) + '</td></tr>' +
        '<tr><td>分档系数</td><td class="num">× ' + r.band + '</td></tr>' +
        '<tr><td>分档前应缴</td><td class="num">' + FW.fmtMoney(r.base) + '</td></tr>';
      var html =
        '<div class="card"><h3>测算结果</h3>' +
        '<div class="stat-row">' +
          '<div class="stat"><div class="label">应安排残疾人数</div><div class="value">' + r.required + ' 人</div></div>' +
          '<div class="stat"><div class="label">实际安排</div><div class="value">' + num(document.getElementById('df_D').value) + ' 人</div></div>' +
          '<div class="stat"><div class="label">安排比例</div><div class="value">' + (r.ratio * 100).toFixed(2) + '%</div></div>' +
          '<div class="stat"><div class="label">应缴保障金</div><div class="value"' + cls + '>' + FW.fmtMoney(r.payable) + '</div></div>' +
        '</div>' +
        '<table style="margin-top:10px"><tbody>' + extra +
          '<tr><td>结论</td><td>' + FW.esc(r.reason || ('应缴保障金 ' + FW.fmtMoney(r.payable))) + '</td></tr>' +
        '</tbody></table></div>';
      document.getElementById('dfResult').innerHTML = html;
    }

    document.getElementById('dfCalc').onclick = calc;
    ['df_N', 'df_D', 'df_W', 'df_cap'].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.addEventListener('input', calc);
    });
    document.getElementById('df_capOn').addEventListener('change', calc);
    calc();
  }

  FW.disabilityFundCalc = { calcFund: calcFund, RATIO: RATIO };
  FW.modules = FW.modules || {};
  FW.modules.disabilityfund = {
    title: '残保金测算',
    render: function () { document.getElementById('topActions').innerHTML = ''; render(); }
  };
})(window);
