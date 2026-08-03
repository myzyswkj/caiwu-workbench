/* ============================================================
 * 小规模升一般纳税人预警（知识工具子模块）
 * 政策口径：年应征增值税销售额（连续不超过12个月）超过 500 万元，
 *           应当办理一般纳税人登记（财税〔2018〕33号等）。
 * 说明：本工具仅作阈值预警与筹划提示，具体认定以主管税务机关规定为准。
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  // 强制登记阈值（年应征增值税销售额，不含税），可编辑
  var DEFAULT_THRESHOLD = 5000000;

  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function fmt(d) {
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // 滚动12个月窗口：从 12 个月前当月 1 号 到 今天
  function rollingRange() {
    var d = new Date();
    var start = new Date(d.getFullYear(), d.getMonth() - 11, 1);
    return { from: fmt(start), to: fmt(d) };
  }

  // 从发票台账取「销项不含税销售额」（滚动12个月）
  function salesFromInvoices() {
    try {
      var r = rollingRange();
      var rows = (FW.db.getList('invoices') || []).filter(function (t) { return t.date >= r.from && t.date <= r.to; });
      var sum = rows.filter(function (t) { return t.direction === 'out'; })
        .reduce(function (a, t) { return a + Number(t.amount || 0); }, 0);
      return Math.round(sum);
    } catch (e) { return null; }
  }
  // 从内账取「收入」（滚动12个月，近似，含未开票）
  function salesFromInternal() {
    try {
      var r = rollingRange();
      var rows = (FW.db.getList('internal') || []).filter(function (t) { return t.date >= r.from && t.date <= r.to; });
      var sum = rows.filter(function (t) { return t.type === 'income'; })
        .reduce(function (a, t) { return a + Number(t.amount || 0); }, 0);
      return Math.round(sum);
    } catch (e) { return null; }
  }

  function compute() {
    var sales = num(document.getElementById('sg_sales').value);
    var month = num(document.getElementById('sg_month').value);
    var threshold = num(document.getElementById('sg_threshold').value) || DEFAULT_THRESHOLD;
    var ratio = threshold > 0 ? sales / threshold : 0;
    var level = ratio >= 1 ? 'danger' : (ratio >= 0.8 ? 'warn' : 'safe');

    var pct = (ratio * 100).toFixed(1);
    var barPct = Math.min(ratio, 1) * 100;
    var diff = threshold - sales; // 正=还差多少触线；负=已超
    var gapTxt;
    if (diff > 0) gapTxt = '距强制登记阈值还差 <b>' + FW.fmtMoney(diff) + '</b>';
    else gapTxt = '已超阈值 <b>' + FW.fmtMoney(-diff) + '</b>，应办理一般纳税人登记';

    // 预计触线月数
    var monthsTxt = '';
    if (ratio < 1 && month > 0) {
      var m = Math.ceil((threshold - sales) / month);
      monthsTxt = '若此后月均销售额维持 ' + FW.fmtMoney(month) + '，预计约 <b>' + m + ' 个月</b>后达到强制登记标准。';
    } else if (ratio < 1 && month <= 0) {
      monthsTxt = '填写「当前月销售额」可估算预计触线时间。';
    }

    var advice = [];
    if (level === 'safe') {
      advice.push({ cls: 'tcout-ok', text: '✅ 当前滚动12个月销售额占阈值 ' + pct + '%，距强制登记标准较远，仍可享受小规模纳税人免税等优惠。' });
    } else if (level === 'warn') {
      advice.push({ cls: 'tcout-warn', text: '⚠️ 已占强制登记阈值 ' + pct + '%（≥80%），进入「关注区」。注意：连续12个月口径滚动计算，临近标准时应提前规划开票与业务节奏（但不得通过不开票、少开票隐瞒销售）。' });
    } else {
      advice.push({ cls: 'tcout-danger', text: '🚨 滚动12个月销售额已达 ' + pct + '%（超过 500 万元），按政策应当办理一般纳税人登记。登记后：可抵扣进项、可开专票；但不再享受小规模免税、按税率（13%/9%/6%）计税、核算要求提高、一般不可随意转回。' });
    }

    var html =
      '<div class="card"><h3>预警结论</h3>' +
        '<div class="sg-bar ' + level + '"><span style="width:' + barPct.toFixed(1) + '%"></span></div>' +
        '<div class="sg-progress-tip">已占强制登记阈值 <b>' + pct + '%</b> · ' + gapTxt + '</div>' +
        '<div class="sg-stat-row">' +
          '<div class="sg-stat"><div class="v">' + FW.fmtMoney(sales) + '</div><div class="l">滚动12个月不含税销售额</div></div>' +
          '<div class="sg-stat"><div class="v">' + FW.fmtMoney(threshold) + '</div><div class="l">强制登记阈值</div></div>' +
          '<div class="sg-stat"><div class="v">' + pct + '%</div><div class="l">占比</div></div>' +
        '</div>' +
        (monthsTxt ? '<div class="sg-progress-tip">' + monthsTxt + '</div>' : '') +
      '</div>' +
      '<div class="card" style="margin-top:14px"><h3>筹划与应对提示</h3>' +
        advice.map(function (a) { return '<div class="tcout ' + a.cls + '">' + a.text + '</div>'; }).join('') +
        '<div class="tcout tcout-info">💡 即使未达 500 万，若会计核算健全、能准确提供税务资料，也可<b>主动申请</b>转为一般纳税人（常见于需要向大客户开专票的情形）。反之，一般纳税人除国家另有规定外，不得转为小规模纳税人。</div>' +
      '</div>';

    document.getElementById('sgResult').innerHTML = html;
  }

  function render() {
    var ta = document.getElementById('topActions');
    if (ta) ta.innerHTML = '';

    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="card"><h3>小规模纳税人升一般纳税人预警 <span class="sub">连续12个月不含税销售额 · 阈值 500 万</span></h3>' +
        '<p class="muted" style="margin:0 0 12px">依据政策：年应征增值税销售额（连续不超过12个月）超过 <b>500 万元</b>，应当办理一般纳税人登记。填下方销售额即可实时预警；也可一键从发票台账或内账取数。</p>' +
        '<div class="form-grid">' +
          '<div class="field"><label>滚动12个月不含税销售额（元）</label><input id="sg_sales" type="number" step="0.01" min="0" value="3800000" placeholder="如：3800000"></div>' +
          '<div class="field"><label>当前月销售额（元，估算触线用）</label><input id="sg_month" type="number" step="0.01" min="0" value="360000" placeholder="如：360000"></div>' +
          '<div class="field"><label>强制登记阈值（元）</label><input id="sg_threshold" type="number" step="0.01" min="0" value="' + DEFAULT_THRESHOLD + '"></div>' +
        '</div>' +
        '<div class="sg-quick">' +
          '<button class="btn ghost sm" id="sgFromInv">📥 从发票销项取数</button>' +
          '<button class="btn ghost sm" id="sgFromInt">📥 从内账收入取数</button>' +
        '</div>' +
      '</div>' +
      '<div id="sgResult"></div>';

    ['sg_sales', 'sg_month', 'sg_threshold'].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener('input', compute);
      el.addEventListener('change', compute);
    });
    document.getElementById('sgFromInv').onclick = function () {
      var v = salesFromInvoices();
      if (v == null) { FW.toast('取数失败：未找到发票台账数据'); return; }
      document.getElementById('sg_sales').value = v; compute();
      FW.toast('已从发票台账(销项)取滚动12个月不含税销售额 ' + FW.fmtMoney(v));
    };
    document.getElementById('sgFromInt').onclick = function () {
      var v = salesFromInternal();
      if (v == null) { FW.toast('取数失败：未找到内账数据'); return; }
      document.getElementById('sg_sales').value = v; compute();
      FW.toast('已从内账(收入)取滚动12个月销售额 ' + FW.fmtMoney(v));
    };
    compute();
  }

  FW.modules = FW.modules || {};
  FW.modules.sme2gen = { title: '升一般纳税人预警', render: render };
})(window);
