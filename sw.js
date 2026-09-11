/* 财务工作台 Service Worker —— 让站点可离线打开、像 App 一样稳定
 * 策略：
 *  - 导航请求（打开页面）：network-first，联网即用最新页面，断网回退缓存首页
 *  - 静态资源（js/css/png/svg）：network-first，联网即用最新版本（带 ?v= 版本号，保证部署后立即生效）
 *  - 跨域请求（Supabase 等）一律放行，不进缓存
 */
const CACHE = 'cw-cache-v81';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(PRECACHE).catch(function () {/* 单文件失败不阻断安装 */});
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); }).then(function () {
      // 新版本激活后，主动通知当前所有页面（含未刷新过的旧页面）强制刷新一次
      return self.clients.matchAll({ includeUncontrolled: true }).then(function (cls) {
        cls.forEach(function (c) { try { c.postMessage({ type: 'SW_UPDATED', v: CACHE }); } catch (e) {} });
      });
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不拦截跨域（云同步等）

  // 导航：network-first，失败回退缓存首页（cache:'reload' 强制绕过 HTTP 缓存，保证拿到最新 index.html）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'reload' }).then(function (r) {
        var cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); });
        return r;
      }).catch(function () {
        return caches.match(req)
          .then(function (r) { return r || caches.match('./index.html'); })
          .then(function (r) { return r || caches.match('./'); });
      })
    );
    return;
  }

  // 静态资源：network-first，联网即用最新版本（带 ?v= 版本号，部署后立即生效），断网回退缓存
  // cache:'reload' 强制绕过浏览器 HTTP 缓存，避免 stale-while-revalidate 时期遗留的旧 internal.js 被反复喂给页面
  e.respondWith(
    fetch(req, { cache: 'reload' }).then(function (r) {
      if (r && r.status === 200) {
        var cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); });
      }
      return r;
    }).catch(function () {
      return caches.match(req).then(function (r) { return r || caches.match('./index.html'); });
    })
  );
});
