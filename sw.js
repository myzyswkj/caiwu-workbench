/* 财务工作台 Service Worker —— 让站点可离线打开、像 App 一样稳定
 * 策略：
 *  - 导航请求（打开页面）：network-first，联网即用最新页面，断网回退缓存首页
 *  - 静态资源（js/css/png/svg）：stale-while-revalidate，先秒开再后台更新
 *  - 跨域请求（Supabase 等）一律放行，不进缓存
 */
const CACHE = 'cw-cache-v20';
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
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不拦截跨域（云同步等）

  // 导航：network-first，失败回退缓存首页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (r) {
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

  // 静态资源：stale-while-revalidate
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (r) {
        if (r && r.status === 200) {
          var cp = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return r;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
