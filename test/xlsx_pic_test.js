/*
 * xlsx_pic_test.js —— 校验向 SheetJS 输出的 xlsx 注入凭证图片的正确性
 *
 * 重点：注入后必须能被「另一套 zip 实现」（SheetJS 自带解析器）重新读出，
 * 否则 Excel 会报「文件已损坏」。
 */
var assert = require('assert');
var P = require('../js/xlsx_pic.js');
var X = require('../js/xlsx.full.min.js');

function ok(name) { console.log('  ✓ ' + name); }

// ---------- 1. CRC32 标准向量 ----------
(function () {
  var u = new TextEncoder().encode('123456789');
  assert.strictEqual(P.crc32(u), 0xCBF43926, 'CRC32 标准向量应为 0xCBF43926');
  assert.strictEqual(P.crc32(new Uint8Array(0)), 0, '空数据 CRC32 应为 0');
  ok('CRC32 与标准向量一致');
})();

// ---------- 2. zip 写→读 往返 ----------
(function () {
  var enc = new TextEncoder(), dec = new TextDecoder();
  var src = [
    { name: 'a.txt', data: enc.encode('hello') },
    { name: 'dir/b.xml', data: enc.encode('<x>中文内容</x>') },
    { name: 'empty.bin', data: new Uint8Array(0) }
  ];
  var zip = P.zipWriteStore(src);
  var back = P.zipReadStore(zip);
  assert.ok(back, '应能读回自己写的 zip');
  assert.strictEqual(back.length, 3, '条目数应一致');
  assert.strictEqual(dec.decode(back[0].data), 'hello');
  assert.strictEqual(dec.decode(back[1].data), '<x>中文内容</x>', 'UTF-8 内容应无损');
  assert.strictEqual(back[2].data.length, 0, '空条目应保持为空');
  ok('zip STORE 写入/读回往返无损（含 UTF-8 与空条目）');
})();

// ---------- 3. 压缩包应被拒绝（触发调用方回退） ----------
(function () {
  var zip = P.zipWriteStore([{ name: 'a.txt', data: new TextEncoder().encode('x') }]);
  var tampered = zip.slice();
  new DataView(tampered.buffer).setUint16(8, 8, true); // 伪造成 DEFLATE
  assert.strictEqual(P.zipReadStore(tampered), null, '非 STORE 条目应返回 null');
  ok('检测到压缩条目时返回 null（调用方可回退无图导出）');
})();

// ---------- 4. drawing XML 结构 ----------
(function () {
  var xml = P.buildDrawingXml([
    { col: 13, row: 1, colOff: 28575, rowOff: 0, cx: 952500, cy: 914400 },
    { col: 13, row: 3, colOff: 28575, rowOff: 0, cx: 800000, cy: 914400 }
  ]);
  assert.ok(xml.indexOf('<xdr:wsDr') >= 0, '根元素应为 xdr:wsDr');
  assert.strictEqual((xml.match(/<xdr:oneCellAnchor>/g) || []).length, 2, '应有 2 个锚点');
  assert.ok(xml.indexOf('r:embed="rId1"') >= 0 && xml.indexOf('r:embed="rId2"') >= 0, 'rId 应递增');
  assert.ok(xml.indexOf('id="2"') >= 0 && xml.indexOf('id="3"') >= 0, 'cNvPr id 须唯一且自 2 起');
  assert.ok(xml.indexOf('<xdr:row>1</xdr:row>') >= 0, '行锚点应落在指定行');
  ok('drawing XML 锚点 / rId / 图形 id 正确');
})();

// ---------- 5. 端到端：注入后仍可被 SheetJS 读回 ----------
(function () {
  var wb = X.utils.book_new();
  var aoa = [['日期', '金额', '凭证图'], ['2026-08-03', 100, ''], ['2026-08-04', 200, '']];
  var ws = X.utils.aoa_to_sheet(aoa);
  ws['!rows'] = [{}, { hpt: 78 }, { hpt: 78 }];
  X.utils.book_append_sheet(wb, ws, '内账流水');
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['账户', '余额']]), '按账户收支');
  var base = new Uint8Array(X.write(wb, { bookType: 'xlsx', type: 'array' }));

  // 1x1 png
  var pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  var bytes = Uint8Array.from(Buffer.from(pngB64, 'base64'));
  var pics = [
    { bytes: bytes, ext: 'png', col: 2, row: 1, colOff: 28575, rowOff: 28575, cx: 952500, cy: 914400 },
    { bytes: bytes, ext: 'png', col: 2, row: 2, colOff: 28575, rowOff: 28575, cx: 952500, cy: 914400 }
  ];
  var outU8 = P.injectPics(base, 'xl/worksheets/sheet1.xml', pics);
  assert.ok(outU8 && outU8.length > base.length, '注入后应返回更大的包');

  // 5a. 用 SheetJS（另一套 zip 实现）读回 —— 这是「Excel 不报损坏」的关键代理验证
  var wb2 = X.read(outU8, { type: 'array' });
  assert.deepStrictEqual(wb2.SheetNames, ['内账流水', '按账户收支'], '工作表名与顺序应保持不变');
  var back = X.utils.sheet_to_json(wb2.Sheets['内账流水'], { header: 1 });
  assert.strictEqual(back[1][0], '2026-08-03', '原有数据不应被破坏');
  assert.strictEqual(back[2][1], 200, '数值单元格应仍为数值');
  ok('注入后可被 SheetJS 完整读回，数据与表顺序无损');

  // 5b. 部件齐全性
  var ent = P.zipReadStore(outU8);
  var names = ent.map(function (e) { return e.name; });
  ['xl/media/image1.png', 'xl/media/image2.png', 'xl/drawings/drawing1.xml',
    'xl/drawings/_rels/drawing1.xml.rels', 'xl/worksheets/_rels/sheet1.xml.rels'
  ].forEach(function (n) {
    assert.ok(names.indexOf(n) >= 0, '缺少部件 ' + n);
  });
  var dec = new TextDecoder();
  function get(n) { return dec.decode(ent[names.indexOf(n)].data); }

  var sheet1 = get('xl/worksheets/sheet1.xml');
  assert.ok(/<drawing r:id="[^"]+"\/><\/worksheet>/.test(sheet1), '<drawing> 须紧邻 </worksheet>（元素顺序要求）');
  assert.ok(sheet1.indexOf('xmlns:r=') >= 0, 'worksheet 须声明 xmlns:r 才能用 r:id');
  assert.ok(sheet1.indexOf('ht="78"') >= 0, '行高应写入，图片才不会被行挤压');

  var srels = get('xl/worksheets/_rels/sheet1.xml.rels');
  var ridMatch = sheet1.match(/<drawing r:id="([^"]+)"\/>/);
  assert.ok(srels.indexOf('Id="' + ridMatch[1] + '"') >= 0, 'sheet rels 中须存在 worksheet 引用的 rId');
  assert.ok(srels.indexOf('Target="../drawings/drawing1.xml"') >= 0, 'rels 应指向 drawing1.xml');

  var drels = get('xl/drawings/_rels/drawing1.xml.rels');
  assert.ok(drels.indexOf('Target="../media/image1.png"') >= 0 &&
    drels.indexOf('Target="../media/image2.png"') >= 0, 'drawing rels 应指向两张图');

  var ct = get('[Content_Types].xml');
  assert.ok(ct.indexOf('/xl/drawings/drawing1.xml') >= 0, 'Content_Types 须为 drawing 声明 Override');
  assert.ok(ct.indexOf('Extension="png"') >= 0, 'png 扩展名须有 Default 声明');
  assert.strictEqual((ct.match(/PartName="\/xl\/drawings\/drawing1\.xml"/g) || []).length, 1, 'Override 不应重复');
  ok('drawing / media / rels / Content_Types 部件齐全且互相引用正确');

  // 5c. 图片字节未被破坏
  var img = ent[names.indexOf('xl/media/image1.png')].data;
  assert.strictEqual(img.length, bytes.length, '图片长度应一致');
  assert.strictEqual(img[0], 0x89, 'PNG magic 首字节应保留');
  assert.strictEqual(img[1], 0x50, 'PNG magic 次字节应保留');
  ok('图片二进制在打包后逐字节无损');
})();

// ---------- 6. 无图 / 异常输入应安全返回 null ----------
(function () {
  var wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['a']]), 'S1');
  var base = new Uint8Array(X.write(wb, { bookType: 'xlsx', type: 'array' }));
  assert.strictEqual(P.injectPics(base, 'xl/worksheets/sheet1.xml', []), null, '无图片时应返回 null');
  assert.strictEqual(P.injectPics(base, 'xl/worksheets/sheet9.xml',
    [{ bytes: new Uint8Array([1]), ext: 'png', col: 0, row: 0, cx: 1, cy: 1 }]), null, '目标 sheet 不存在应返回 null');
  ok('无图片 / sheet 路径不存在时安全返回 null');
})();

// ---------- 7. 显示尺寸换算 ----------
(function () {
  var a = P.fitDisplay(1200, 1600, 96, 220); // 竖图：按高度封顶
  assert.strictEqual(a.h, 96);
  assert.strictEqual(a.w, 72);
  var b = P.fitDisplay(4000, 1000, 96, 220); // 极宽图：改按宽度封顶
  assert.strictEqual(b.w, 220);
  assert.strictEqual(b.h, 55);
  assert.ok(b.h <= 96, '超宽图缩放后高度不得超过行高上限');
  var c = P.fitDisplay(0, 0, 96, 220);       // 尺寸未知时回退
  assert.strictEqual(c.h, 96);
  ok('图片显示尺寸换算正确（竖图按高、宽图按宽、异常回退）');
})();

// ---------- 8. 多图布局：横向排开且互不重叠 ----------
(function () {
  var b = new Uint8Array([1, 2, 3]);
  var picMap = {
    0: [{ bytes: b, w: 1200, h: 1600 }, { bytes: b, w: 1600, h: 1200 }, { bytes: b, w: 1000, h: 1000 }],
    4: [{ bytes: b, w: 800, h: 600 }]
  };
  var pics = P.layoutRowPics(picMap, { col: 13, rowBase: 1, dispH: 96, maxW: 220 });
  assert.strictEqual(pics.length, 4, '总图数应一致');

  // 行锚点：行下标 0 → 第 1 行（第 0 行是表头）
  assert.strictEqual(pics[0].row, 1, '首行数据应锚定在第 1 行');
  assert.strictEqual(pics[3].row, 5, '行下标 4 应锚定在第 5 行');
  pics.forEach(function (p) { assert.strictEqual(p.col, 13, '所有图应锚定在凭证图列'); });

  // 同一行三张图必须依次右移且不重叠
  var rowFirst = pics.slice(0, 3);
  for (var i = 1; i < rowFirst.length; i++) {
    var prevRight = rowFirst[i - 1].colOff + rowFirst[i - 1].cx;
    assert.ok(rowFirst[i].colOff >= prevRight,
      '第 ' + (i + 1) + ' 张图左边缘(' + rowFirst[i].colOff + ') 不得越过前一张右边缘(' + prevRight + ')');
  }
  // 换行后偏移必须重新从头开始，不能延续上一行
  assert.strictEqual(pics[3].colOff, pics[0].colOff, '新的一行应重置横向偏移');

  // 高度统一对齐行高，宽度按比例
  assert.strictEqual(pics[0].hPx, 96, '竖图高度应对齐显示高度');
  assert.strictEqual(pics[2].wPx, 96, '正方形图宽高应相等');
  pics.forEach(function (p) {
    assert.ok(p.hPx <= 96, '任何图的显示高度都不得超过行高上限');
    assert.ok(p.cx > 0 && p.cy > 0, 'EMU 尺寸须为正');
    assert.strictEqual(p.cx, p.wPx * P.EMU_PER_PX, 'cx 应为像素宽 × 9525');
  });
  ok('多图横向布局不重叠、换行重置偏移、高度对齐行高');
})();

// ---------- 9. 布局结果可直接用于注入（端到端串联） ----------
(function () {
  var wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['日期', '凭证图'], ['2026-08-03', '']]), '内账流水');
  var base = new Uint8Array(X.write(wb, { bookType: 'xlsx', type: 'array' }));
  var jpg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
  var pics = P.layoutRowPics({ 0: [{ bytes: jpg, w: 640, h: 480 }] }, { col: 1, rowBase: 1 });
  var out = P.injectPics(base, 'xl/worksheets/sheet1.xml', pics);
  assert.ok(out, '布局结果应能直接注入');
  var wb2 = X.read(out, { type: 'array' });
  assert.strictEqual(X.utils.sheet_to_json(wb2.Sheets['内账流水'], { header: 1 })[1][0], '2026-08-03');
  var ent = P.zipReadStore(out);
  var media = ent.filter(function (e) { return e.name.indexOf('xl/media/') === 0; });
  assert.strictEqual(media.length, 1, '应写入 1 张图');
  assert.strictEqual(media[0].name, 'xl/media/image1.jpeg', '默认扩展名应为 jpeg');
  ok('layoutRowPics → injectPics 端到端串联可用');
})();

console.log('\nALL_OK');
