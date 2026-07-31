/* ============================================================
 * 通用 UI 工具：toast、modal、日期/金额格式化、SVG 图表
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW = global.FW || {};

  /* ---------- toast ---------- */
  var toastTimer = null;
  FW.toast = function (msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  };

  /* ---------- modal ---------- */
  var modalMask = function () { return document.getElementById('modalMask'); };
  FW.openModal = function (title, bodyHtml, onMount) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    modalMask().hidden = false;
    if (onMount) onMount(document.getElementById('modalBody'));
  };
  FW.closeModal = function () { modalMask().hidden = true; document.getElementById('modalBody').innerHTML = ''; var m = document.querySelector('.modal'); if (m) m.classList.remove('modal-wide'); };
  document.getElementById('modalClose').addEventListener('click', FW.closeModal);
  modalMask().addEventListener('click', function (e) { if (e.target === modalMask()) FW.closeModal(); });

  /* ---------- 格式化 ---------- */
  FW.fmtMoney = function (n) {
    var num = Number(n) || 0;
    var neg = num < 0;
    var s = Math.abs(num).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + '¥' + s;
  };
  FW.fmtDate = function (d) {
    if (!d) return '';
    var dt = new Date(d);
    if (isNaN(dt)) return d;
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  };
  FW.today = function () {
    var d = new Date(), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  // 转义 HTML，防注入
  FW.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ---------- SVG 柱状图 ---------- */
  FW.barChart = function (title, items, opts) {
    opts = opts || {};
    var w = 320, h = 220, padL = 42, padB = 28, padT = 14, padR = 10;
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    var color = opts.color || '#2f6bff';
    var n = items.length || 1;
    var bw = (w - padL - padR) / n * 0.62;
    var gap = (w - padL - padR) / n;
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">';
    // 轴
    svg += '<line x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padR) + '" y2="' + (h - padB) + '" stroke="#e6e9f0"/>';
    items.forEach(function (it, idx) {
      var x = padL + gap * idx + (gap - bw) / 2;
      var bh = (h - padB - padT) * (it.value / max);
      var y = (h - padB) - bh;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="' + color + '" opacity="0.9"/>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" font-size="9" text-anchor="middle" fill="#41506a">' + FW.shortMoney(it.value) + '</text>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - padB + 13).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="#7a869a">' + FW.esc(FW.clip(it.label, 6)) + '</text>';
    });
    svg += '</svg>';
    return '<div class="chart-box"><h4>' + FW.esc(title) + '</h4>' + svg + '</div>';
  };

  /* ---------- SVG 分组柱状图（多系列，如收入/支出按项目对比） ---------- */
  FW.groupedBarChart = function (title, series, labels, opts) {
    opts = opts || {};
    var w = opts.width || 380, h = opts.height || 240;
    var padL = 46, padB = 32, padT = 18, padR = 14;
    var n = labels.length || 1;
    var nSer = series.length || 1;
    // 收集所有值计算最大值
    var allVals = [];
    series.forEach(function (s) { s.values.forEach(function (v) { allVals.push(Math.abs(v)); }); });
    if (!allVals.length) return '<div class="chart-box"><h4>' + FW.esc(title) + '</h4><div class="empty">暂无数据</div></div>';
    var max = Math.max.apply(null, allVals.concat([1]));
    var groupW = (w - padL - padR) / n;          // 每组宽度
    var barW = Math.min(groupW * 0.7 / nSer, 22); // 每根柱宽
    var gap = (groupW - barW * nSer) / (nSer + 1); // 组内柱间距
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">';
    // Y 轴网格线
    var ticks = 4;
    for (var ti = 0; ti <= ticks; ti++) {
      var val = max * ti / ticks;
      var yy = (h - padB) - (h - padB - padT) * (val / max);
      svg += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + yy.toFixed(1) + '" stroke="#eef1f7"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1) + '" font-size="9" text-anchor="end" fill="#9aa6bd">' + FW.shortMoney(val) + '</text>';
    }
    // X ���基线
    svg += '<line x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padR) + '" y2="' + (h - padB) + '" stroke="#e6e9f0"/>';
    // 零线（当有负值时）
    if (max > 0) {
      var zeroY = (h - padB) - (h - padB - padT) * (0 / max);
      // zeroY == h-padB when min is 0, so skip
    }
    // 每组画多根柱
    labels.forEach(function (lb, idx) {
      var gx = padL + groupW * idx;
      series.forEach(function (s, si) {
        var v = s.values[idx] || 0;
        var bx = gx + gap * (si + 1) + barW * si;
        var bh = (h - padB - padT) * (Math.abs(v) / max);
        var by = v >= 0 ? (h - padB) - bh : (h - padB);
        var bhDraw = Math.max(bh, 1); // 至少 1px 高，避免零值不可见
        if (v !== 0) {
          svg += '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bhDraw.toFixed(1) + '" rx="2" fill="' + (s.color || '#888') + '" opacity="0.85"/>';
        } else {
          // 零值画个细线占位
          svg += '<rect x="' + bx.toFixed(1) + '" y="' + ((h - padB) - 1).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="2" rx="1" fill="' + (s.color || '#888') + '" opacity="0.3"/>';
        }
        // 数值标签（绝对值较大时才显示）
        if (Math.abs(v) >= max * 0.05) {
          var ty = v >= 0 ? by - 4 : by + bhDraw + 11;
          svg += '<text x="' + (bx + barW / 2).toFixed(1) + '" y="' + ty.toFixed(1) + '" font-size="8" text-anchor="middle" fill="#41506a">' + FW.shortMoney(v) + '</text>';
        }
      });
      // X 轴标签
      svg += '<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (h - padB + 13).toFixed(1) + '" font-size="9" text-anchor="middle" fill="#7a869a">' + FW.esc(FW.clip(lb, 8)) + '</text>';
    });
    svg += '</svg>';
    // 图例
    var legend = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;justify-content:center">';
    series.forEach(function (s) {
      legend += '<span style="display:flex;align-items:center;gap:4px;font-size:11px"><span style="width:10px;height:10px;border-radius:2px;background:' + (s.color || '#888') + '"></span>' + FW.esc(s.name) + '</span>';
    });
    legend += '</div>';
    return '<div class="chart-box"><h4>' + FW.esc(title) + '</h4>' + svg + legend + '</div>';
  };

  /* ---------- SVG 饼图 ---------- */
  FW.pieChart = function (title, items) {
    var total = items.reduce(function (a, b) { return a + b.value; }, 0) || 1;
    var w = 320, h = 220, cx = 110, cy = 110, r = 86;
    var colors = ['#C8102E', '#C9A227', '#E08A1E', '#A4151B', '#D9B45B', '#7A1020', '#B5651D', '#E6C200'];
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">';
    var ang = -Math.PI / 2;
    items.forEach(function (it, i) {
      var frac = it.value / total;
      var a2 = ang + frac * Math.PI * 2;
      var large = frac > 0.5 ? 1 : 0;
      var x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
      var x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      svg += '<path d="M' + cx + ' ' + cy + ' L' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' Z" fill="' + colors[i % colors.length] + '"/>';
      ang = a2;
    });
    svg += '</svg>';
    var legend = '<div style="margin-left:8px;font-size:12px">';
    items.forEach(function (it, i) {
      var pct = (it.value / total * 100).toFixed(1);
      legend += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="width:10px;height:10px;border-radius:2px;background:' + colors[i % colors.length] + '"></span><span>' + FW.esc(it.label) + '</span><span class="muted"> ' + pct + '%</span></div>';
    });
    legend += '</div>';
    return '<div class="chart-box"><h4>' + FW.esc(title) + '</h4><div style="display:flex;align-items:center">' + svg + legend + '</div></div>';
  };

  /* ---------- SVG 折线图（多系列） ---------- */
  FW.lineChart = function (title, series, opts) {
    opts = opts || {};
    var w = 340, h = 220, padL = 46, padB = 28, padT = 16, padR = 14;
    var allVals = [];
    series.forEach(function (s) { s.points.forEach(function (p) { allVals.push(p.value); }); });
    if (!allVals.length) return '<div class="chart-box"><h4>' + FW.esc(title) + '</h4><div class="empty">暂无数据</div></div>';
    var max = Math.max.apply(null, allVals);
    var min = Math.min.apply(null, allVals.concat([0]));
    var lo = min < 0 ? min : 0;
    var range = (max - lo) || 1;
    function y(v) { return (h - padB) - (h - padB - padT) * (v - lo) / range; }
    var n = Math.max.apply(null, series.map(function (s) { return s.points.length; })) || 1;
    var step = n > 1 ? (w - padL - padR) / (n - 1) : 0;
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">';
    var ticks = 4;
    for (var ti = 0; ti <= ticks; ti++) {
      var val = lo + range * ti / ticks;
      var yy = y(val);
      svg += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + yy.toFixed(1) + '" stroke="#eef1f7"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1) + '" font-size="9" text-anchor="end" fill="#9aa6bd">' + FW.shortMoney(val) + '</text>';
    }
    var labels = series[0].points.map(function (p) { return p.label; });
    var stride = Math.ceil(labels.length / 8) || 1;
    labels.forEach(function (lb, idx) {
      var x = padL + step * idx; if (n === 1) x = (padL + w - padR) / 2;
      if (idx % stride === 0 || idx === labels.length - 1)
        svg += '<text x="' + x.toFixed(1) + '" y="' + (h - padB + 14).toFixed(1) + '" font-size="9" text-anchor="middle" fill="#7a869a">' + FW.esc(FW.clip(lb, 6)) + '</text>';
    });
    series.forEach(function (s) {
      var d = '';
      s.points.forEach(function (p, idx) {
        var x = padL + step * idx; if (n === 1) x = (padL + w - padR) / 2;
        d += (idx === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y(p.value).toFixed(1) + ' ';
      });
      svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2.2" stroke-linejoin="round"/>';
      s.points.forEach(function (p, idx) {
        var x = padL + step * idx; if (n === 1) x = (padL + w - padR) / 2;
        svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="2.6" fill="' + s.color + '"/>';
      });
    });
    svg += '</svg>';
    var legend = series.map(function (s) {
      return '<span class="lg-item"><i style="background:' + s.color + '"></i>' + FW.esc(s.name) + '</span>';
    }).join('');
    return '<div class="chart-box"><h4>' + FW.esc(title) + '</h4>' + svg + '<div class="chart-legend">' + legend + '</div></div>';
  };

  FW.shortMoney = function (n) {
    var num = Number(n) || 0;
    if (Math.abs(num) >= 10000) return (num / 10000).toFixed(1) + '万';
    return Math.round(num).toString();
  };
  FW.clip = function (s, len) {
    s = String(s == null ? '' : s);
    return s.length > len ? s.slice(0, len - 1) + '…' : s;
  };

  /* ---------- 简易 DOM 帮助 ---------- */
  FW.h = function (html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  };
  FW.q = function (sel, root) { return (root || document).querySelector(sel); };
  FW.qa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- 云端同步顶栏回调（由 sync.js 驱动） ---------- */
  FW.ui = FW.ui || {};
  FW.ui.setAuth = function () {
    // 实际渲染逻辑在 sync.js（FW.sync._refreshArea），这里只做转发
    if (FW.sync && FW.sync._refreshArea) FW.sync._refreshArea();
  };
  FW.ui.setSyncTime = function (t) {
    var el = document.getElementById('authState');
    if (!el || !t) return;
    var hh = ('0' + t.getHours()).slice(-2), mm = ('0' + t.getMinutes()).slice(-2);
    el.textContent = '已同步 ' + hh + ':' + mm;
  };

})(window);
