/* PWA 静态断言：manifest / 图标 / service worker / index.html 接线齐全
 * 不依赖浏览器环境，纯文件检查，确保「添加到主屏」链路完整。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifestRaw = fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8');
const swRaw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

// 容错属性匹配：允许属性间空格、标签以 " />" 自闭合
const tag = (attr) => new RegExp('<[a-zA-Z]+[^>]*' + attr + '[^>]*>', 'i');

console.log('PWA 接线检查:');

// index.html
ok('index.html 引用 manifest', tag('rel="manifest"[^>]+href="manifest\\.webmanifest"').test(indexHtml));
ok('apple-touch-icon 使用 PNG(180)', tag('rel="apple-touch-icon"[^>]+sizes="180x180"[^>]+href="icons/icon-180\\.png"').test(indexHtml));
ok('注册 service worker (sw.js)', /navigator\.serviceWorker\.register\(['"]sw\.js['"]\)/.test(indexHtml));
ok('theme-color 已设置', tag('name="theme-color"[^>]+content="#0B1A2E"').test(indexHtml));
ok('apple-mobile-web-app-capable 已设置', tag('name="apple-mobile-web-app-capable"[^>]+content="yes"').test(indexHtml));

// manifest
let m;
try { m = JSON.parse(manifestRaw); ok('manifest 是合法 JSON', true); }
catch (e) { m = null; ok('manifest 是合法 JSON', false); }
if (m) {
  ok('display = standalone', m.display === 'standalone');
  ok('含 512 PNG 图标', m.icons.some(i => /512.*\.png$/.test(i.src) && i.type === 'image/png'));
  ok('含 maskable 图标', m.icons.some(i => i.purpose === 'maskable' && /maskable-512\.png$/.test(i.src)));
  ok('含 any 图标(192)', m.icons.some(i => i.sizes === '192x192' && i.purpose === 'any'));
}

// service worker
ok('sw.js 含缓存版本号', /cw-cache-v1/.test(swRaw));
ok('sw.js 导航 network-first 逻辑', /req\.mode === 'navigate'/.test(swRaw));
ok('sw.js 预缓存图标清单', /icons\/icon-512\.png/.test(swRaw) && /icons\/icon-180\.png/.test(swRaw));

// 图标文件存在
['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png', 'icons/icon-maskable-512.png'].forEach(f => {
  const p = path.join(root, f);
  ok('图标文件存在且非空: ' + f, fs.existsSync(p) && fs.statSync(p).size > 0);
});

console.log('\nPWA 测试: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
