/**
 * FWTableImg —— 把表格（内账流水明细）手绘成一张 PNG 图片，用于「给老板看 / 分享」。
 *
 * 设计要点：
 *  - 纯原生 Canvas 2D，不引入任何第三方库（html2canvas 等），保持项目「纯静态离线」架构。
 *  - 凭证图用 dataURL 直接 drawImage，不会污染（taint）canvas，toDataURL 可正常导出。
 *  - 配色对齐当前主题：深墨绿表头 #14342B、收入红 #C8102E、支出绿 #1F9D55。
 *  - 关键布局算法（wrapText / _compute）是纯函数，可在 node 中桩 measureText 做单测。
 *
 * 对外 API：
 *  - FWTableImg.render(config) -> Promise<HTMLCanvasElement>
 *  - FWTableImg.downloadPNG(canvas, filename)
 *  - FWTableImg.wrapText(measure, text, maxWidth)  // 纯函数，便于测试
 *  - FWTableImg._compute(config, measure)          // 纯布局算法，便于测试
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FWTableImg = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var C = {
    headerBg: '#0B1A2E',
    headerFg: '#FFFFFF',
    title: '#1B2733',
    muted: '#5B6A7A',
    text: '#1B2733',
    border: '#DCE4EC',
    rowAlt: '#F2F5F9',
    panel: '#FFFFFF',
    income: '#C8102E',   // 收入=红（A股约定）
    expense: '#1F9D55',  // 支出=绿（A股约定）
    gold: '#C9A227',
    // —— 仪表盘风视觉 ——
    pageBg: '#F4F6F2',       // 浅灰页面底（悬浮白卡之外）
    cardBorder: '#E2E6E2',   // 白卡细边框
    goldText: '#C9A227',     // 金色眉标
    kpiGoldBg: '#FBF6E8',    // KPI 笔数/净额 淡金底
    kpiIncomeBg: '#FCEDEE',  // KPI 收入 淡红底
    kpiExpenseBg: '#EAF6EF', // KPI 支出 淡绿底
    amtIncomeBg: '#FCEDEE',  // 收入列底纹
    amtExpenseBg: '#EAF6EF'  // 支出列底纹
  };

  var FONT = '17px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var FONT_BOLD = '600 17px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var TITLE_FONT = '700 28px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var SUB_FONT = '16px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var KPI_LABEL_FONT = '16px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var KPI_VALUE_FONT = '700 22px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var PANEL_TITLE_FONT = '700 20px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var EYEBROW_FONT = '500 13px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var FOOTER_FONT = '13px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';

  // 按「字号缩放系数 fs」生成整套字体串（fs=1 即上面的基准值）。
  // 凭证大小(用户旋钮) → fontScale → 字号随凭证一起变大，但只有「凭证」列宽随 fs 放大，
  // 其余文本列宽不变，于是「字号 / 表格框」比例变好，解决「框大字体小」。
  function scaleFonts(fs) {
    function px(n) { return Math.round(n * fs) + 'px'; }
    var fam = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
    return {
      FONT: px(17) + ' ' + fam,
      FONT_BOLD: '600 ' + px(17) + ' ' + fam,
      FONT_BIG: px(20) + ' ' + fam,
      FONT_BIG_BOLD: '600 ' + px(20) + ' ' + fam,
      TITLE: '700 ' + px(28) + ' ' + fam,
      SUB: px(16) + ' ' + fam,
      KPI_LABEL: px(16) + ' ' + fam,
      KPI_VALUE: '700 ' + px(22) + ' ' + fam,
      PANEL: '700 ' + px(20) + ' ' + fam,
      EYEBROW: '500 ' + px(13) + ' ' + fam,
      FOOTER: px(13) + ' ' + fam
    };
  }

  // ---------- 纯函数：文本折行（按字符，兼容中英文混排） ----------
  function wrapText(measure, text, maxWidth) {
    if (text == null) text = '';
    text = String(text);
    var lines = [];
    var paras = text.split(/\r?\n/);
    paras.forEach(function (para) {
      if (para === '') { lines.push(''); return; }
      var cur = '';
      for (var i = 0; i < para.length; i++) {
        var ch = para[i];
        var test = cur + ch;
        if (cur && measure(test).width > maxWidth) {
          lines.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
    });
    return lines;
  }

  // ---------- 纯函数：凭证图在「凭证」列内的横向布局 ----------
  // pics: [{w, h, img?, src?}]（w/h 为图片自然像素）
  // cellW: 凭证列宽；返回 { imgs:[{w,h,...}], rowH }（rowH 含上下内边距）
  function layoutImages(pics, cellW, picMaxW, picMaxH, gap, padY) {
    var n = pics.length;
    if (!n) return { imgs: [], rowH: 0, gap: gap };
    var availW = Math.max(10, cellW - 16); // 左右各 8px 内边距
    var aspects = [];
    var totalW = 0;
    for (var i = 0; i < n; i++) {
      var ar = (pics[i].h > 0) ? (pics[i].w / pics[i].h) : 1;
      aspects.push(ar);
      totalW += ar * picMaxH;
    }
    totalW += gap * (n - 1);
    var s = totalW > availW ? availW / totalW : 1;
    var h = picMaxH * s;
    var g = gap * s; // 间距同步缩放，保证图片+间距整体恰好等于可用宽
    var widths = aspects.map(function (ar) { return ar * h; });
    // 单张超宽时再整体压一次（图片与间距都按 s2 缩放）
    var maxW = 0;
    for (var j = 0; j < widths.length; j++) if (widths[j] > maxW) maxW = widths[j];
    if (maxW > picMaxW && h > 0) {
      var s2 = picMaxW / maxW;
      h = h * s2;
      g = g * s2;
      for (var k = 0; k < widths.length; k++) widths[k] = widths[k] * s2;
    }
    var imgs = widths.map(function (w, idx) {
      var p = pics[idx];
      return { w: w, h: h, img: p.img, src: p.src };
    });
    return { imgs: imgs, rowH: h + 2 * padY, gap: g };
  }

  function defaultWidths(n) {
    var d = [124, 84, 144, 114, 156, 148, 184, 106, 224, 268];
    var out = [];
    var total = 0;
    for (var i = 0; i < n; i++) {
      var w = d[i] != null ? d[i] : 140;
      out.push(w);
      total += w;
    }
    return { colWidths: out, totalColW: total };
  }

  // ---------- 纯函数：整套几何布局（不碰 DOM，可单测） ----------
  // config: { head, rows:[{cells, amountCls}], colWidths?, pics:{rowIdx:[{w,h}]},
  //           amountCol, imgCol, kpis, title, subtitle, picMaxW, picMaxH, gap, ... }
  // measure(s) -> { width }
  function _compute(cfg, measure) {
    cfg = cfg || {};
    var head = cfg.head || [];
    var rows = cfg.rows || [];
    var nCol = head.length;
    var amountCol = (cfg.amountCol != null) ? cfg.amountCol : -1;
    var imgCol = (cfg.imgCol != null) ? cfg.imgCol : (nCol - 1);
    var fs = cfg.fontScale || 1;                 // 凭证大小旋钮：1=标准；>1 字号/凭证变大，框比例更协调
    var F = scaleFonts(fs);
    // 明细加大列（如界面：日期/类型/项目/分类/账户）与「类型」列索引，用于导出字号/加粗同步界面
    var bigCols = cfg.bigCols || null;
    var typeCol = (cfg.typeCol != null) ? cfg.typeCol : -1;
    var measureBig = cfg.measureBig || measure;
    var colW = (cfg.colWidths && cfg.colWidths.length === nCol) ? cfg.colWidths : defaultWidths(nCol).colWidths;
    var padX = (cfg.padX != null ? cfg.padX : 10) * fs;
    var padY = (cfg.padY != null ? cfg.padY : 11) * fs;
    var lineH = (cfg.lineH != null ? cfg.lineH : 26) * fs;
    var picMaxW = (cfg.picMaxW != null ? cfg.picMaxW : 220) * fs;
    var picMaxH = (cfg.picMaxH != null ? cfg.picMaxH : 130) * fs;
    var gap = (cfg.gap != null ? cfg.gap : 8) * fs;
    var marginX = (cfg.marginX != null ? cfg.marginX : 18) * fs;
    var marginY = (cfg.marginY != null ? cfg.marginY : 18) * fs;
    var headerH = (cfg.headerH != null ? cfg.headerH : 50) * fs;

    // 仅「凭证」列宽随 fs 放大（其余文本列不变），让「字号 / 框」比例变好
    if (fs !== 1) { colW = colW.slice(); colW[imgCol] = Math.round(colW[imgCol] * fs); }

    var tableW = colW.reduce(function (s, w) { return s + w; }, 0);
    var totalW = tableW + marginX * 2;
    var cardH = 66 * fs;
    var kpiPadX = 14 * fs;
    var kpiLabelDY = 12 * fs;
    var kpiValueDY = 34 * fs;
    var noteLineH = 19 * fs;

    // 顶部区块高度预算（随 fs 放大，保持与放大后的字号协调）
    var eyebrowH = cfg.eyebrow ? 20 * fs : 0;
    var titleH = cfg.title ? 36 * fs : 0;
    var subtitleH = cfg.subtitle ? 24 * fs : 0;
    var kpiH = (cfg.kpis && cfg.kpis.length) ? 70 * fs : 0;
    var cursorY = marginY + eyebrowH + (cfg.eyebrow ? 4 * fs : 0) + titleH + (cfg.title ? 8 * fs : 0) + subtitleH + (cfg.subtitle ? 6 * fs : 0) + kpiH + (kpiH ? 10 * fs : 0);

    // 副表（按账户收支等小表）：放在 KPI 与主表之间，左对齐、宽度与主表一致
    var subtable = null;
    if (cfg.subtable && cfg.subtable.head && cfg.subtable.head.length) {
      subtable = computeSubTable(cfg.subtable, measure, { padX: padX, lineH: lineH, padY: padY, availW: tableW, fs: fs });
      subtable.top = cursorY;
      cursorY += subtable.totalH + (subtable.noteLines.length ? 8 * fs : 14 * fs);
    }

    var tableTop = cursorY;

    var rowGeom = [];
    var y = tableTop + headerH;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var cells = row.cells || [];
      var maxLines = 1;
      var cellLines = [];
      for (var c = 0; c < nCol; c++) {
        var txt = (c === imgCol) ? '' : (cells[c] == null ? '' : cells[c]);
        var m = (bigCols && bigCols.indexOf(c) >= 0) ? measureBig : measure;
        var lines = wrapText(m, String(txt), colW[c] - padX * 2);
        if (!lines.length) lines = [''];
        cellLines.push(lines);
        if (lines.length > maxLines) maxLines = lines.length;
      }
      var textH = maxLines * lineH + 2 * padY;
      var pics = (cfg.pics && cfg.pics[r]) || [];
      var imgL = layoutImages(pics, colW[imgCol], picMaxW, picMaxH, gap, padY);
      var rowH = Math.max(textH, imgL.rowH);
      rowGeom.push({ top: y, height: rowH, cellLines: cellLines, amountCls: row.amountCls, imgs: imgL.imgs, imgGap: imgL.gap });
      y += rowH;
    }

    var totalH = y + marginY;
    // 底部页脚（仪表盘风：导出署名），仅当传入 footer 时占高
    var footerH = cfg.footer ? Math.round(34 * fs) : 0;
    if (footerH) totalH = y + footerH + marginY;
    return {
      totalW: totalW, totalH: totalH,
      marginX: marginX, marginY: marginY,
      titleH: titleH, subtitleH: subtitleH, kpiH: kpiH, eyebrowH: eyebrowH, footerH: footerH,
      tableTop: tableTop, headerH: headerH,
      colW: colW, padX: padX, padY: padY, lineH: lineH, gap: gap,
      amountCol: amountCol, imgCol: imgCol,
      nCol: nCol, head: head, rows: rowGeom,
      bigCols: bigCols, typeCol: typeCol,
      subtable: subtable,
      fonts: F, cardH: cardH, kpiPadX: kpiPadX, kpiLabelDY: kpiLabelDY, kpiValueDY: kpiValueDY, noteLineH: noteLineH,
      fs: fs
    };
  }

  // ---------- 纯函数：副表（按账户收支等小表）布局 ----------
  // cfg: { title?, note?, head, rows:[[cell,...]], colWidths?, headerH?, rightCols?, colCls?,
  //         totalRow? }  colCls 每项: 'neutral'|'income'|'expense'|'signed'
  // opt: { padX, lineH, padY, availW }
  function computeSubTable(cfg, measure, opt) {
    var head = cfg.head || [];
    var rows = cfg.rows || [];
    var nCol = head.length;
    var fs = opt.fs || 1;
    var colW = (cfg.colWidths && cfg.colWidths.length === nCol) ? cfg.colWidths : head.map(function () { return 120; });
    var padX = opt.padX, lineH = opt.lineH, padY = opt.padY;
    var headerH = (cfg.headerH != null ? cfg.headerH : 42) * fs;
    var rightCols = cfg.rightCols || [];
    var titleH = cfg.title ? 24 * fs : 0;
    var rowGeom = [];
    var y = 0;
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r] || [];
      var maxLines = 1, cellLines = [];
      for (var c = 0; c < nCol; c++) {
        var txt = (cells[c] == null) ? '' : cells[c];
        var lines = wrapText(measure, String(txt), colW[c] - padX * 2);
        if (!lines.length) lines = [''];
        cellLines.push(lines);
        if (lines.length > maxLines) maxLines = lines.length;
      }
      var rowH = maxLines * lineH + 2 * padY;
      rowGeom.push({ top: y, height: rowH, cellLines: cellLines, isTotal: !!cfg.totalRow && (r === rows.length - 1) });
      y += rowH;
    }
    var tableH = y;
    var noteLines = cfg.note ? wrapText(measure, cfg.note, opt.availW) : [];
    var noteH = noteLines.length * 19 * fs;
    var gapNote = noteLines.length ? 6 * fs : 0;
    var totalH = titleH + (cfg.title ? 6 : 0) + tableH + gapNote + noteH;
    var tableW = colW.reduce(function (s, w) { return s + w; }, 0);
    return {
      title: cfg.title || '', note: cfg.note || '', noteLines: noteLines,
      head: head, rows: rowGeom, colW: colW, nCol: nCol,
      headerH: headerH, lineH: lineH, padX: padX, padY: padY,
      rightCols: rightCols, colCls: cfg.colCls || [], totalRow: !!cfg.totalRow,
      tableW: tableW, totalH: totalH, titleH: titleH, noteH: noteH, noteLineH: 19 * fs
    };
  }

  // ---------- 圆角矩形（兼容老浏览器） ----------
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 主渲染 ----------
  function render(config) {
    return new Promise(function (resolve, reject) {
      try {
        config = config || {};
        var scale = config.scale || 2;   // 仅控制位图清晰度（devicePixelRatio）
        var fs = config.fontScale || 1;  // 控制字号/凭证大小（用户旋钮）
        // 跟随当前主题：读取 CSS 变量覆盖默认色（主题改了图片导出也跟着变，避免写死错位）
        try {
          if (typeof document !== 'undefined' && document.documentElement) {
            var cs = getComputedStyle(document.documentElement);
            if (cs) {
              var pick = function (name, fb) { var val = (cs.getPropertyValue(name) || '').trim(); return val || fb; };
              C.headerBg = pick('--sidebar-bg', C.headerBg);
              C.income = pick('--income', C.income);
              C.expense = pick('--expense', C.expense);
              C.border = pick('--border', C.border);
              C.muted = pick('--muted', C.muted);
              C.text = pick('--text', C.text);
              C.rowAlt = pick('--bg', C.rowAlt);
            }
          }
        } catch (e) { /* 取色失败则用默认色 */ }
        // 预加载凭证图（dataURL / blobURL），得到带自然尺寸的图片对象
        var picsCfg = config.pics || {};
        var rowIdxs = Object.keys(picsCfg);
        Promise.all(rowIdxs.map(function (ri) {
          var list = picsCfg[ri] || [];
          return Promise.all(list.map(preload)).then(function (imgs) {
            return { ri: ri, imgs: imgs.filter(Boolean).map(function (im, i) {
              return { img: im, w: im.naturalWidth || im.width || 1, h: im.naturalHeight || im.height || 1 };
            }) };
          });
        })).then(function (loaded) {
          var picsModel = {};
          loaded.forEach(function (o) { picsModel[o.ri] = o.imgs; });

            // 用真实 ctx 做测量（measureText 依赖字体，须用缩放后的字号串）
          var measCanvas = document.createElement('canvas');
          var mctx = measCanvas.getContext('2d');
          var _F = scaleFonts(fs);
          var measureFont = _F.FONT;
          var measureFontBig = _F.FONT_BIG;
          mctx.font = measureFont;
          function measure(s) { mctx.font = measureFont; return mctx.measureText(s); }
          function measureBig(s) { mctx.font = measureFontBig; return mctx.measureText(s); }

          var geo = _compute({
            head: config.head, rows: config.rows, colWidths: config.colWidths,
            pics: picsModel, amountCol: config.amountCol, imgCol: config.imgCol,
            kpis: config.kpis, title: config.title, subtitle: config.subtitle,
            picMaxW: config.picMaxW, picMaxH: config.picMaxH, gap: config.gap, fontScale: fs,
            subtable: config.subtable,
            measureBig: measureBig,
            bigCols: config.bigCols,
            typeCol: config.typeCol
          }, measure);

          var canvas = document.createElement('canvas');
          canvas.width = Math.round(geo.totalW * scale);
          canvas.height = Math.round(geo.totalH * scale);
          var ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.textBaseline = 'top';
          draw(ctx, geo, config);
          resolve(canvas);
        }).catch(reject);
      } catch (e) { reject(e); }
    });
  }

  function draw(ctx, geo, config) {
    var mx = geo.marginX, my = geo.marginY;
    var F = geo.fonts, fs = geo.fs;
    // 仪表盘风：浅灰页面底 + 悬浮白色圆角卡片
    var pagePad = Math.round(14 * fs);
    ctx.fillStyle = C.pageBg;
    ctx.fillRect(0, 0, geo.totalW, geo.totalH);
    ctx.fillStyle = C.panel;
    rr(ctx, pagePad, pagePad, geo.totalW - 2 * pagePad, geo.totalH - 2 * pagePad, Math.round(16 * fs));
    ctx.fill();
    ctx.strokeStyle = C.cardBorder; ctx.lineWidth = 1; ctx.stroke();

    // 标题区（眉标 → 标题 → 副标题），统一在白卡内
    var cy = my;
    if (config.eyebrow) {
      ctx.fillStyle = C.goldText;
      ctx.font = F.EYEBROW;
      ctx.fillText(config.eyebrow, mx, cy);
      cy += geo.eyebrowH + 4 * fs;
    }
    if (config.title) {
      ctx.fillStyle = C.title;
      ctx.font = F.TITLE;
      ctx.fillText(config.title, mx, cy);
      cy += geo.titleH + 8 * fs;
    }
    // 副标题
    if (config.subtitle) {
      ctx.fillStyle = C.muted;
      ctx.font = F.SUB;
      ctx.fillText(config.subtitle, mx, cy);
      cy += geo.subtitleH + 6 * fs;
    }
    // KPI 卡片（品牌色底：笔数/净额淡金、收入淡红、支出淡绿）
    if (config.kpis && config.kpis.length) {
      var kpiY = cy;
      var kx = mx;
      config.kpis.forEach(function (k) {
        ctx.font = F.KPI_LABEL;
        var labelW = ctx.measureText(k.label).width;
        ctx.font = F.KPI_VALUE;
        var valW = ctx.measureText(k.value).width;
        var cardW = Math.max(Math.round(140 * fs), labelW + valW + geo.kpiPadX * 2);
        var cardH = geo.cardH;
        var bg = k.cls === 'income' ? C.kpiIncomeBg : (k.cls === 'expense' ? C.kpiExpenseBg : C.kpiGoldBg);
        ctx.fillStyle = bg;
        rr(ctx, kx, kpiY, cardW, cardH, Math.round(10 * fs)); ctx.fill();
        ctx.strokeStyle = C.cardBorder; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.muted; ctx.font = F.KPI_LABEL;
        ctx.fillText(k.label, kx + geo.kpiPadX, kpiY + geo.kpiLabelDY);
        ctx.fillStyle = k.cls === 'income' ? C.income : (k.cls === 'expense' ? C.expense : C.text);
        ctx.font = F.KPI_VALUE;
        ctx.fillText(k.value, kx + geo.kpiPadX, kpiY + geo.kpiValueDY);
        kx += cardW + Math.round(16 * fs);
      });
      cy += geo.kpiH + 10 * fs;
    }

    // 副表（按账户收支等）：KPI 之后、主表之前
    if (geo.subtable) {
      var st = geo.subtable;
      var sx = mx, sy = st.top;
      if (st.title) {
        ctx.fillStyle = C.title;
        ctx.font = F.PANEL;
        ctx.fillText(st.title, sx, sy);
        sy += st.titleH + 6 * fs;
      }
      // 表头
      ctx.fillStyle = C.headerBg;
      ctx.fillRect(sx, sy, st.tableW, st.headerH);
      ctx.fillStyle = C.headerFg;
      ctx.font = F.FONT_BOLD;
      var shx = sx;
      for (var sc = 0; sc < st.nCol; sc++) {
        var shw = st.colW[sc];
        var sht = String(st.head[sc] == null ? '' : st.head[sc]);
        if (st.rightCols.indexOf(sc) >= 0) {
          var stw = ctx.measureText(sht).width;
          ctx.fillText(sht, shx + shw - st.padX - stw, sy + (st.headerH - st.lineH) / 2);
        } else {
          ctx.fillText(sht, shx + st.padX, sy + (st.headerH - st.lineH) / 2);
        }
        shx += shw;
      }
      // 表体
      var sry = sy + st.headerH;
      for (var sr = 0; sr < st.rows.length; sr++) {
        var srg = st.rows[sr];
        if (srg.isTotal || sr % 2 === 1) {
          ctx.fillStyle = C.rowAlt;
          ctx.fillRect(sx, sry, st.tableW, srg.height);
        }
        var scl = sx;
        for (var scc = 0; scc < st.nCol; scc++) {
          var scw = st.colW[scc];
          var slines = srg.cellLines[scc] || [''];
          var scls = st.colCls[scc] || 'neutral';
          var colColor = C.text;
          if (scls === 'income') colColor = C.income;
          else if (scls === 'expense') colColor = C.expense;
          else if (scls === 'signed') {
            var raw = String(slines.join('')).replace(/[^0-9.\-−]/g, '').replace(/−/g, '-');
            var num = parseFloat(raw);
            if (!isNaN(num)) colColor = num < 0 ? C.expense : (num > 0 ? C.income : C.text);
          }
          ctx.fillStyle = colColor;
          ctx.font = srg.isTotal ? F.FONT_BOLD : F.FONT;
          for (var sli = 0; sli < slines.length; sli++) {
            var sline = slines[sli];
            if (st.rightCols.indexOf(scc) >= 0) {
              var slw = ctx.measureText(sline).width;
              ctx.fillText(sline, scl + scw - st.padX - slw, sry + st.padY + sli * st.lineH);
            } else {
              ctx.fillText(sline, scl + st.padX, sry + st.padY + sli * st.lineH);
            }
          }
          scl += scw;
        }
        ctx.strokeStyle = C.border; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, sry + srg.height + 0.5);
        ctx.lineTo(sx + st.tableW, sry + srg.height + 0.5);
        ctx.stroke();
        sry += srg.height;
      }
      // 外边框
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, st.tableW - 1, (sry - sy) + 0.5);
      // 注脚（折行）
      if (st.noteLines && st.noteLines.length) {
        ctx.fillStyle = C.muted;
        ctx.font = F.SUB;
        for (var ni = 0; ni < st.noteLines.length; ni++) {
          ctx.fillText(st.noteLines[ni], sx, sry + 6 * fs + ni * st.noteLineH);
        }
      }
    }

    var tableLeft = mx;
    var tableTop = geo.tableTop;
    // 表头
    ctx.fillStyle = C.headerBg;
    ctx.fillRect(tableLeft, tableTop, geo.totalW - mx * 2, geo.headerH);
    ctx.fillStyle = C.headerFg;
    ctx.font = F.FONT_BOLD;
    var hx = tableLeft;
    for (var c = 0; c < geo.nCol; c++) {
      var hw = geo.colW[c];
      var ht = String(geo.head[c] == null ? '' : geo.head[c]);
      // 金额列对齐：默认右对齐（数字常态），显式 amountAlign:'left' 时左对齐（与屏幕流水表一致）
      if (c === geo.amountCol && config.amountAlign !== 'left') {
        var tw = ctx.measureText(ht).width;
        ctx.fillText(ht, hx + hw - geo.padX - tw, tableTop + (geo.headerH - geo.lineH) / 2);
      } else {
        ctx.fillText(ht, hx + geo.padX, tableTop + (geo.headerH - geo.lineH) / 2);
      }
      hx += hw;
    }

    // 数据行
    var cellLeft = tableLeft;
    for (var r = 0; r < geo.rows.length; r++) {
      var rg = geo.rows[r];
      var rowTop = rg.top;
      // 行背景（交替）
      if (r % 2 === 1) {
        ctx.fillStyle = C.rowAlt;
        ctx.fillRect(tableLeft, rowTop, geo.totalW - mx * 2, rg.height);
      }
      // 行底边
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tableLeft, rowTop + rg.height + 0.5);
      ctx.lineTo(tableLeft + geo.totalW - mx * 2, rowTop + rg.height + 0.5);
      ctx.stroke();

      var cl = cellLeft;
      for (var cc = 0; cc < geo.nCol; cc++) {
        var cw = geo.colW[cc];
        // 金额列底纹（收入淡红 / 支出淡绿），仅作为背景，文字随后覆盖
        if (cc === geo.amountCol) {
          var amtTint = rg.amountCls === 'income' ? C.amtIncomeBg : (rg.amountCls === 'expense' ? C.amtExpenseBg : null);
          if (amtTint) { ctx.fillStyle = amtTint; ctx.fillRect(cl, rowTop, cw, rg.height); }
        }
        if (cc === geo.imgCol) {
          // 凭证图：横向居中铺在凭证列
          if (rg.imgs && rg.imgs.length) {
            var imgRowH = rg.imgs[0].h + 2 * geo.padY;
            var iy = rowTop + (rg.height - imgRowH) / 2 + geo.padY;
            var ix = cl + geo.padX;
            for (var p = 0; p < rg.imgs.length; p++) {
              var im = rg.imgs[p];
              if (im.img) ctx.drawImage(im.img, ix, iy, im.w, im.h);
              ix += im.w + (rg.imgGap != null ? rg.imgGap : geo.gap);
            }
          }
        } else {
          var lines = rg.cellLines[cc] || [''];
          var txtColor = C.text;
          if (cc === geo.amountCol && rg.amountCls === 'income') txtColor = C.income;
          else if (cc === geo.amountCol && rg.amountCls === 'expense') txtColor = C.expense;
          ctx.fillStyle = txtColor;
          // 字体：金额列恒加粗（与屏幕 td.num 一致）；明细加大列用大字号，其中「类型」列收入/支出再加粗
          var cellFont = F.FONT;
          if (cc === geo.amountCol) cellFont = F.FONT_BOLD;
          else if (geo.bigCols && geo.bigCols.indexOf(cc) >= 0) {
            cellFont = (cc === geo.typeCol && (rg.amountCls === 'income' || rg.amountCls === 'expense')) ? F.FONT_BIG_BOLD : F.FONT_BIG;
          }
          ctx.font = cellFont;
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            // 金额列对齐：默认右对齐，显式 amountAlign:'left' 时左对齐（与屏幕流水表一致）
            if (cc === geo.amountCol && config.amountAlign !== 'left') {
              var lw = ctx.measureText(line).width;
              ctx.fillText(line, cl + cw - geo.padX - lw, rowTop + geo.padY + li * geo.lineH);
            } else {
              ctx.fillText(line, cl + geo.padX, rowTop + geo.padY + li * geo.lineH);
            }
          }
        }
        cl += cw;
      }
    }

    // 外边框
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.strokeRect(tableLeft + 0.5, tableTop + 0.5, geo.totalW - mx * 2 - 1, (geo.rows.length ? (geo.rows[geo.rows.length - 1].top + geo.rows[geo.rows.length - 1].height - tableTop) : geo.headerH) + 0.5);

    // 底部页脚（仪表盘风：导出署名）
    if (config.footer && geo.footerH) {
      var lastRow = geo.rows.length ? geo.rows[geo.rows.length - 1] : null;
      var fy = lastRow ? (lastRow.top + lastRow.height) : (tableTop + geo.headerH);
      ctx.fillStyle = C.muted;
      ctx.font = F.FOOTER;
      ctx.fillText(config.footer, mx, fy + (geo.footerH - 16 * fs) / 2);
    }
  }

  // 单张凭证图加载：加超时（部分 JPEG/PNG 在某些浏览器上 onload/onerror 都不触发，会让 Promise 永远 pending）
  function preload(src) {
    return new Promise(function (resolve) {
      if (!src) { resolve(null); return; }
      var img = new Image();
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(tmo);
        resolve(v);
      }
      var tmo = setTimeout(function () {
        console.warn('[table_image.preload] 凭证图加载超时 8s,跳过; dataURL 长度=', (src || '').length);
        finish(null);
      }, 8000);
      img.onload = function () { finish(img); };
      img.onerror = function (e) {
        console.warn('[table_image.preload] 凭证图加载失败:', e, 'dataURL 长度=', (src || '').length);
        finish(null);
      };
      try { img.src = src; } catch (e) {
        console.warn('[table_image.preload] 赋值 src 抛异常:', e);
        finish(null);
      }
    });
  }

  function downloadPNG(canvas, filename) {
    filename = filename || ('export_' + Date.now() + '.png');
    // 优先用 toBlob + ObjectURL：比 toDataURL 的 data: URL 更可靠，
    // 避免浏览器（尤其 Chrome）因 data: URL 过大而静默拦截下载。
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) { fallbackDataURL(canvas, filename); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }, 'image/png');
    } else {
      fallbackDataURL(canvas, filename);
    }
  }
  function fallbackDataURL(canvas, filename) {
    try {
      var url = canvas.toDataURL('image/png');
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (e) {
      console.error('[导出图片] 下载失败：', e);
      try { window.open(canvas.toDataURL('image/png'), '_blank'); } catch (e2) {}
    }
  }

  return {
    render: render,
    downloadPNG: downloadPNG,
    wrapText: wrapText,
    layoutImages: layoutImages,
    _compute: _compute,
    _draw: draw,
    _colors: C
  };
});
