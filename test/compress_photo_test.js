// compressPhoto 单测：缩放数学 + 各种回退（非位图 / 无 Image / 已是小JPEG / 压缩更大保留原图 / onerror）
var assert = require('assert');
var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// 在 require 之前准备全局桩：db.js 在调用时读取 window/Image/document
var nextImg = { w: 0, h: 0, fail: false };
global.window = global.window || {};
global.Image = function () {};
Object.defineProperty(global.Image.prototype, 'src', {
  set: function (v) {
    var self = this;
    this._src = v;
    setTimeout(function () {
      if (nextImg.fail) { if (self.onerror) self.onerror(new Error('bad img')); return; }
      self.naturalWidth = nextImg.w; self.naturalHeight = nextImg.h;
      self.width = nextImg.w; self.height = nextImg.h;
      if (self.onload) self.onload();
    }, 0);
  },
  get: function () { return this._src; }
});
var canvasLog = {};
global.document = {
  createElement: function (tag) {
    if (tag !== 'canvas') return {};
    var cv = {
      width: 0, height: 0,
      getContext: function () {
        return {
          set fillStyle(v) { canvasLog.fillStyle = v; },
          fillRect: function () { canvasLog.fillRect = (canvasLog.fillRect || 0) + 1; },
          drawImage: function () { canvasLog.drawImage = (canvasLog.drawImage || 0) + 1; }
        };
      },
      toDataURL: function (mime, q) {
        canvasLog.toDataURL = { mime: mime, q: q, w: this.width, h: this.height };
        return canvasLog.forceBig ? ('data:image/jpeg;base64,' + 'X'.repeat(5000)) : 'data:image/jpeg;base64,SMALL';
      }
    };
    return cv;
  }
};

require('../js/db.js');
var db = (global.window.FW && global.window.FW.db) ? global.window.FW.db : null;
ok('db 模块加载并暴露 compressPhoto', !!(db && typeof db.compressPhoto === 'function'));

var bigPng = 'data:image/png;base64,' + 'A'.repeat(3000000); // ~3MB 字符串模拟大图
var seq = Promise.resolve();

seq = seq.then(function () {
  // 1) 大横图压缩：长边缩到 1000、短边等比、白底、JPEG0.7、采用更短的压缩结果
  nextImg = { w: 2000, h: 1500, fail: false }; canvasLog = {};
  return db.compressPhoto(bigPng, 1000, 0.7).then(function (out) {
    ok('大图返回 JPEG dataURL', out.indexOf('data:image/jpeg') === 0);
    ok('长边缩到 1000', canvasLog.toDataURL && canvasLog.toDataURL.w === 1000);
    ok('短边等比 750', canvasLog.toDataURL && canvasLog.toDataURL.h === 750);
    ok('铺白底(fillRect=1)', canvasLog.fillRect === 1);
    ok('转 JPEG 质量 0.7', canvasLog.toDataURL.mime === 'image/jpeg' && canvasLog.toDataURL.q === 0.7);
    ok('采用更短的压缩结果', out === 'data:image/jpeg;base64,SMALL');
  });
}).then(function () {
  // 2) 非位图原样返回
  return db.compressPhoto('hello-world', 1000, 0.7).then(function (out) {
    ok('非 data:image 原样返回', out === 'hello-world');
    return db.compressPhoto('data:application/pdf;base64,AAA', 1000, 0.7);
  }).then(function (out) {
    ok('PDF 等非位图原样返回', out === 'data:application/pdf;base64,AAA');
  });
}).then(function () {
  // 3) 已是小 JPEG（s>=1）不重压
  nextImg = { w: 800, h: 600, fail: false }; canvasLog = {};
  return db.compressPhoto('data:image/jpeg;base64,ORIG', 1000, 0.7).then(function (out) {
    ok('已是小 JPEG 不重压，返回原图', out === 'data:image/jpeg;base64,ORIG');
    ok('未触碰 canvas', !canvasLog.toDataURL);
  });
}).then(function () {
  // 4) 加载失败回退原图
  nextImg = { w: 0, h: 0, fail: true };
  return db.compressPhoto('data:image/png;base64,AAA', 1000, 0.7).then(function (out) {
    ok('加载失败回退原图', out === 'data:image/png;base64,AAA');
  });
}).then(function () {
  // 5) 压缩后反而更大则保留原图
  nextImg = { w: 2000, h: 1500, fail: false }; canvasLog = { forceBig: true };
  return db.compressPhoto('data:image/png;base64,TINY', 1000, 0.7).then(function (out) {
    ok('压缩后更大则保留原图', out === 'data:image/png;base64,TINY');
  });
}).then(function () {
  // 6) 无 Image（node/老环境）原样返回
  var saved = global.Image; delete global.Image;
  return db.compressPhoto('data:image/png;base64,AAA', 1000, 0.7).then(function (out) {
    ok('无 Image 环境原样返回', out === 'data:image/png;base64,AAA');
    global.Image = saved;
  });
}).then(function () {
  console.log('');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fail) process.exit(1);
}).catch(function (e) {
  console.log('  ✗ 测试异常: ' + (e && e.message));
  console.log('PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
});
