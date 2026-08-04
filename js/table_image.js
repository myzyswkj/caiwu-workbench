/**
 * FWTableImg —— 把表格（内账流水明细）手绘成一张 PNG 图片，用于「给老板看 / 分享」。
 *
 * 设计要点：
 *  - 纯原生 Canvas 2D，不引入任何第三方库（html2canvas 等），保持项目「纯静态离线」架构。
 *  - 凭证图用 dataURL 直接 drawImage，不会污染（taint）canvas，toDataURL 可正常导出。
 *  - 配色对齐当前主题：深墨蓝表头 #0B1A2E、收入红 #C8102E、支出绿 #1F9D55。
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
    gold: '#C9A227'
  };

  var FONT = '13px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var FONT_BOLD = '600 13px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var TITLE_FONT = '700 20px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var SUB_FONT = '12px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var KPI_LABEL_FONT = '12px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var KPI_VALUE_FONT = '700 16px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  var PANEL_TITLE_FONT = '700 15px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';

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
    var d = [92, 60, 110, 84, 120, 116, 140, 76, 180, 220];
    var out = [];
    for (var i = 0; i < n; i++) out.push(d[i] != null ? d[i] : 120);
    return out;
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
    var colW = (cfg.colWidths && cfg.colWidths.length === nCol) ? cfg.colWidths : defaultWidths(nCol);
    var padX = cfg.padX != null ? cfg.padX : 8;
    var padY = cfg.padY != null ? cfg.padY : 7;
    var lineH = cfg.lineH != null ? cfg.lineH : 18;
    var picMaxW = cfg.picMaxW != null ? cfg.picMaxW : 200;
    var picMaxH = cfg.picMaxH != null ? cfg.picMaxH : 120;
    var gap = cfg.gap != null ? cfg.gap : 6;
    var marginX = cfg.marginX != null ? cfg.marginX : 16;
    var marginY = cfg.marginY != null ? cfg.marginY : 16;
    var headerH = cfg.headerH != null ? cfg.headerH : 34;

    var tableW = colW.reduce(function (s, w) { return s + w; }, 0);
    var totalW = tableW + marginX * 2;

    // 顶部区块高度预算
    var titleH = cfg.title ? 26 : 0;
    var subtitleH = cfg.subtitle ? 20 : 0;
    var kpiH = (cfg.kpis && cfg.kpis.length) ? 52 : 0;
    var cursorY = marginY + titleH + (cfg.title ? 8 : 0) + subtitleH + (cfg.subtitle ? 6 : 0) + kpiH + (kpiH ? 10 : 0);

    // 副表（按账户收支等小表）：放在 KPI 与主表之间，左对齐、宽度与主表一致
    var subtable = null;
    if (cfg.subtable && cfg.subtable.head && cfg.subtable.head.length) {
      subtable = computeSubTable(cfg.subtable, measure, { padX: padX, lineH: lineH, padY: padY, availW: tableW });
      subtable.top = cursorY;
      cursorY += subtable.totalH + (subtable.noteLines.length ? 8 : 14);
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
        var lines = wrapText(measure, String(txt), colW[c] - padX * 2);
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
    return {
      totalW: totalW, totalH: totalH,
      marginX: marginX, marginY: marginY,
      titleH: titleH, subtitleH: subtitleH, kpiH: kpiH,
      tableTop: tableTop, headerH: headerH,
      colW: colW, padX: padX, padY: padY, lineH: lineH, gap: gap,
      amountCol: amountCol, imgCol: imgCol,
      nCol: nCol, head: head, rows: rowGeom,
      subtable: subtable
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
    var colW = (cfg.colWidths && cfg.colWidths.length === nCol) ? cfg.colWidths : head.map(function () { return 120; });
    var padX = opt.padX, lineH = opt.lineH, padY = opt.padY;
    var headerH = cfg.headerH != null ? cfg.headerH : 30;
    var rightCols = cfg.rightCols || [];
    var titleH = cfg.title ? 22 : 0;
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
    var noteH = noteLines.length * 15;
    var gapNote = noteLines.length ? 6 : 0;
    var totalH = titleH + (cfg.title ? 6 : 0) + tableH + gapNote + noteH;
    var tableW = colW.reduce(function (s, w) { return s + w; }, 0);
    return {
      title: cfg.title || '', note: cfg.note || '', noteLines: noteLines,
      head: head, rows: rowGeom, colW: colW, nCol: nCol,
      headerH: headerH, lineH: lineH, padX: padX, padY: padY,
      rightCols: rightCols, colCls: cfg.colCls || [], totalRow: !!cfg.totalRow,
      tableW: tableW, totalH: totalH, titleH: titleH, noteH: noteH
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
        var scale = config.scale || 2;
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

          // 用真实 ctx 做测量（measureText 依赖字体）
          var measCanvas = document.createElement('canvas');
          var mctx = measCanvas.getContext('2d');
          mctx.font = FONT;
          function measure(s) { mctx.font = FONT; return mctx.measureText(s); }

          var geo = _compute({
            head: config.head, rows: config.rows, colWidths: config.colWidths,
            pics: picsModel, amountCol: config.amountCol, imgCol: config.imgCol,
            kpis: config.kpis, title: config.title, subtitle: config.subtitle,
            picMaxW: config.picMaxW, picMaxH: config.picMaxH, gap: config.gap, scale: scale
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
    // 背景
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, geo.totalW, geo.totalH);

    // 标题
    var cy = my;
    if (config.title) {
      ctx.fillStyle = C.title;
      ctx.font = TITLE_FONT;
      ctx.fillText(config.title, mx, cy);
      cy += geo.titleH + 8;
    }
    // 副标题
    if (config.subtitle) {
      ctx.fillStyle = C.muted;
      ctx.font = SUB_FONT;
      ctx.fillText(config.subtitle, mx, cy);
      cy += geo.subtitleH + 6;
    }
    // KPI 卡片
    if (config.kpis && config.kpis.length) {
      var kpiY = cy;
      var kx = mx;
      config.kpis.forEach(function (k) {
        ctx.font = KPI_LABEL_FONT;
        var labelW = ctx.measureText(k.label).width;
        ctx.font = KPI_VALUE_FONT;
        var valW = ctx.measureText(k.value).width;
        var cardW = Math.max(120, labelW + valW + 24);
        var cardH = 44;
        ctx.fillStyle = '#F2F5F9';
        rr(ctx, kx, kpiY, cardW, cardH, 8); ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.muted; ctx.font = KPI_LABEL_FONT;
        ctx.fillText(k.label, kx + 12, kpiY + 8);
        ctx.fillStyle = k.cls === 'income' ? C.income : (k.cls === 'expense' ? C.expense : C.text);
        ctx.font = KPI_VALUE_FONT;
        ctx.fillText(k.value, kx + 12, kpiY + 24);
        kx += cardW + 14;
      });
      cy += geo.kpiH + 10;
    }

    // 副表（按账户收支等）：KPI 之后、主表之前
    if (geo.subtable) {
      var st = geo.subtable;
      var sx = mx, sy = st.top;
      if (st.title) {
        ctx.fillStyle = C.title;
        ctx.font = PANEL_TITLE_FONT;
        ctx.fillText(st.title, sx, sy);
        sy += st.titleH + 6;
      }
      // 表头
      ctx.fillStyle = C.headerBg;
      ctx.fillRect(sx, sy, st.tableW, st.headerH);
      ctx.fillStyle = C.headerFg;
      ctx.font = FONT_BOLD;
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
          ctx.font = srg.isTotal ? FONT_BOLD : FONT;
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
        ctx.font = SUB_FONT;
        for (var ni = 0; ni < st.noteLines.length; ni++) {
          ctx.fillText(st.noteLines[ni], sx, sry + 6 + ni * 15);
        }
      }
    }

    var tableLeft = mx;
    var tableTop = geo.tableTop;
    // 表头
    ctx.fillStyle = C.headerBg;
    ctx.fillRect(tableLeft, tableTop, geo.totalW - mx * 2, geo.headerH);
    ctx.fillStyle = C.headerFg;
    ctx.font = FONT_BOLD;
    var hx = tableLeft;
    for (var c = 0; c < geo.nCol; c++) {
      var hw = geo.colW[c];
      var ht = String(geo.head[c] == null ? '' : geo.head[c]);
      if (c === geo.amountCol) {
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
          ctx.font = FONT;
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            if (cc === geo.amountCol) {
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
  }

  function preload(src) {
    return new Promise(function (resolve) {
      if (!src) { resolve(null); return; }
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function downloadPNG(canvas, filename) {
    var url = canvas.toDataURL('image/png');
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || ('export_' + Date.now() + '.png');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
