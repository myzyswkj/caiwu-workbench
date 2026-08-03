/*
 * xlsx_pic.js —— 向 SheetJS（社区版）生成的 .xlsx 中注入图片
 *
 * 背景：SheetJS 社区版不支持写入图片（属 Pro 功能），但它输出的 xlsx 是
 * 「STORE 模式（不压缩）」的 zip。因此可以自行解包 → 追加 drawing/media 部件
 * → 重新打包，从而把凭证图片真正嵌进 Excel 单元格位置上。
 *
 * 仅支持 STORE 模式；若检测到压缩条目会返回 null，由调用方回退为「不带图导出」。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FWXlsxPic = api;
})(this, function () {
  'use strict';

  var EMU_PER_PX = 9525;
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  var _crcTab = null;
  function crc32(u8) {
    if (!_crcTab) {
      _crcTab = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTab[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ _crcTab[(crc ^ u8[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }

  // 解包 STORE 模式 zip；遇到压缩条目 / data descriptor 返回 null
  function zipReadStore(u8) {
    try {
      if (!u8 || !u8.length) return null;
      var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      var off = 0, out = [];
      while (off + 30 <= u8.length && dv.getUint32(off, true) === 0x04034b50) {
        var flag = dv.getUint16(off + 6, true);
        var method = dv.getUint16(off + 8, true);
        var csize = dv.getUint32(off + 18, true);
        var nlen = dv.getUint16(off + 26, true);
        var elen = dv.getUint16(off + 28, true);
        if (method !== 0 || (flag & 8)) return null;
        var name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nlen));
        var start = off + 30 + nlen + elen;
        if (start + csize > u8.length) return null;
        out.push({ name: name, data: u8.subarray(start, start + csize) });
        off = start + csize;
      }
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  // 重新打包为 STORE 模式 zip
  function zipWriteStore(entries) {
    var enc = new TextEncoder();
    var locals = [], centrals = [], offset = 0;
    entries.forEach(function (f) {
      var nameB = enc.encode(f.name);
      var data = f.data;
      var crc = crc32(data);
      var lh = new Uint8Array(30 + nameB.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // 文件名 UTF-8
      lv.setUint16(8, 0, true);      // STORE
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameB.length, true);
      lh.set(nameB, 30);

      var cd = new Uint8Array(46 + nameB.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameB, 46);

      locals.push(lh, data);
      centrals.push(cd);
      offset += lh.length + data.length;
    });
    var cdSize = centrals.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var out = new Uint8Array(offset + cdSize + 22), p = 0;
    locals.forEach(function (b) { out.set(b, p); p += b.length; });
    centrals.forEach(function (b) { out.set(b, p); p += b.length; });
    out.set(eocd, p);
    return out;
  }

  // pics: [{ col, row, colOff, rowOff, cx, cy }]（EMU）
  function buildDrawingXml(pics) {
    var body = pics.map(function (p, i) {
      var id = i + 2;
      return '<xdr:oneCellAnchor>' +
        '<xdr:from>' +
          '<xdr:col>' + p.col + '</xdr:col><xdr:colOff>' + (p.colOff || 0) + '</xdr:colOff>' +
          '<xdr:row>' + p.row + '</xdr:row><xdr:rowOff>' + (p.rowOff || 0) + '</xdr:rowOff>' +
        '</xdr:from>' +
        '<xdr:ext cx="' + p.cx + '" cy="' + p.cy + '"/>' +
        '<xdr:pic>' +
          '<xdr:nvPicPr><xdr:cNvPr id="' + id + '" name="Picture ' + id + '"/>' +
          '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
          '<xdr:blipFill><a:blip r:embed="rId' + (i + 1) + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
          '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + p.cx + '" cy="' + p.cy + '"/></a:xfrm>' +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
        '</xdr:pic>' +
        '<xdr:clientData/>' +
      '</xdr:oneCellAnchor>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' xmlns:r="' + NS_R + '">' + body + '</xdr:wsDr>';
  }

  function buildDrawingRels(pics) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      pics.map(function (p, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_R + '/image"' +
          ' Target="../media/image' + (i + 1) + '.' + (p.ext || 'jpeg') + '"/>';
      }).join('') + '</Relationships>';
  }

  /**
   * 把图片注入 xlsx。
   * @param {Uint8Array} zipBytes  SheetJS 输出（type:'array'）
   * @param {string} sheetPath     如 'xl/worksheets/sheet1.xml'
   * @param {Array} pics           [{bytes,ext,col,row,colOff,rowOff,cx,cy}]
   * @returns {Uint8Array|null}    失败返回 null，调用方应回退为无图导出
   */
  function injectPics(zipBytes, sheetPath, pics) {
    if (!pics || !pics.length) return null;
    var entries = zipReadStore(zipBytes);
    if (!entries) return null;
    var byName = {};
    entries.forEach(function (e) { byName[e.name] = e; });
    if (!byName[sheetPath] || !byName['[Content_Types].xml']) return null;

    var enc = new TextEncoder(), dec = new TextDecoder();
    var drawingPath = 'xl/drawings/drawing1.xml';
    var relId = 'rIdFwDrawing1';

    // 1) 图片二进制
    pics.forEach(function (p, i) {
      entries.push({ name: 'xl/media/image' + (i + 1) + '.' + (p.ext || 'jpeg'), data: p.bytes });
    });
    // 2) drawing 及其 rels
    entries.push({ name: drawingPath, data: enc.encode(buildDrawingXml(pics)) });
    entries.push({ name: 'xl/drawings/_rels/drawing1.xml.rels', data: enc.encode(buildDrawingRels(pics)) });

    // 3) worksheet 挂 <drawing/>（须位于 </worksheet> 前，符合 CT_Worksheet 元素顺序）
    var sheetXml = dec.decode(byName[sheetPath].data);
    if (sheetXml.indexOf('<drawing ') >= 0) return null;
    if (sheetXml.indexOf('</worksheet>') < 0) return null;
    sheetXml = sheetXml.replace('</worksheet>', '<drawing r:id="' + relId + '"/></worksheet>');
    byName[sheetPath].data = enc.encode(sheetXml);

    // 4) worksheet 的 rels（SheetJS 无超链接时不生成该文件，需新建）
    var srPath = sheetPath.replace(/^(.*\/)([^/]+)$/, '$1_rels/$2.rels');
    var srRel = '<Relationship Id="' + relId + '" Type="' + NS_R + '/drawing" Target="../drawings/drawing1.xml"/>';
    if (byName[srPath]) {
      var srXml = dec.decode(byName[srPath].data);
      if (srXml.indexOf('</Relationships>') < 0) return null;
      byName[srPath].data = enc.encode(srXml.replace('</Relationships>', srRel + '</Relationships>'));
    } else {
      entries.push({
        name: srPath,
        data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          srRel + '</Relationships>')
      });
    }

    // 5) [Content_Types].xml 补 drawing 的 Override（png/jpeg 的 Default 由 SheetJS 已写入）
    var ctXml = dec.decode(byName['[Content_Types].xml'].data);
    if (ctXml.indexOf('</Types>') < 0) return null;
    if (ctXml.indexOf('/xl/drawings/drawing1.xml') < 0) {
      ctXml = ctXml.replace('</Types>', '<Override PartName="/' + drawingPath +
        '" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
    }
    var exts = {};
    pics.forEach(function (p) { exts[p.ext || 'jpeg'] = 1; });
    Object.keys(exts).forEach(function (e) {
      if (ctXml.indexOf('Extension="' + e + '"') < 0) {
        var mime = (e === 'png') ? 'image/png' : (e === 'gif' ? 'image/gif' : 'image/jpeg');
        ctXml = ctXml.replace('<Types ', '<Types ').replace('</Types>',
          '<Default Extension="' + e + '" ContentType="' + mime + '"/></Types>');
      }
    });
    byName['[Content_Types].xml'].data = enc.encode(ctXml);

    return zipWriteStore(entries);
  }

  // 依据原始像素尺寸算出「显示尺寸」：高度对齐行高，超宽则以宽度封顶
  function fitDisplay(w, h, maxH, maxW) {
    if (!w || !h) return { w: maxW, h: maxH };
    var dh = maxH, dw = Math.round(maxH * w / h);
    if (dw > maxW) { dw = maxW; dh = Math.round(maxW * h / w); }
    return { w: Math.max(1, dw), h: Math.max(1, dh) };
  }

  /**
   * 把「行下标 → 图片列表」布局为 drawing 锚点：同一行多张图沿列向右依次排开，互不重叠。
   * @param {Object} picMap  { 行下标: [{bytes,w,h,ext}] }
   * @param {Object} opts    { col, rowBase=1, dispH=96, maxW=220, gap=6, pad=3 }
   */
  function layoutRowPics(picMap, opts) {
    opts = opts || {};
    var col = opts.col || 0;
    var rowBase = opts.rowBase == null ? 1 : opts.rowBase;
    var dispH = opts.dispH || 96;
    var maxW = opts.maxW || 220;
    var gap = opts.gap == null ? 6 : opts.gap;
    var pad = opts.pad == null ? 3 : opts.pad;
    var out = [];
    Object.keys(picMap).map(Number).sort(function (a, b) { return a - b; }).forEach(function (ri) {
      var offPx = pad;
      (picMap[ri] || []).forEach(function (p) {
        var d = fitDisplay(p.w, p.h, dispH, maxW);
        out.push({
          bytes: p.bytes,
          ext: p.ext || 'jpeg',
          col: col,
          row: ri + rowBase,
          colOff: offPx * EMU_PER_PX,
          rowOff: pad * EMU_PER_PX,
          cx: d.w * EMU_PER_PX,
          cy: d.h * EMU_PER_PX,
          wPx: d.w,
          hPx: d.h
        });
        offPx += d.w + gap;
      });
    });
    return out;
  }

  return {
    EMU_PER_PX: EMU_PER_PX,
    layoutRowPics: layoutRowPics,
    crc32: crc32,
    zipReadStore: zipReadStore,
    zipWriteStore: zipWriteStore,
    buildDrawingXml: buildDrawingXml,
    buildDrawingRels: buildDrawingRels,
    injectPics: injectPics,
    fitDisplay: fitDisplay
  };
});
