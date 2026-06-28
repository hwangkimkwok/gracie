/* ============================================================
 成长冒险岛 · 自律成长 APP — Service Worker
 作用：缓存核心静态资源，实现断网 / 添加到主屏幕后仍可正常打开使用。
 缓存策略：
   - 安装(install)：预缓存核心资源（index.html、manifest、图标）。
   - 激活(activate)：清理旧版本缓存（缓存名带版本号，更新版本即自动失效旧缓存）。
   - 拦截(fetch)：
       · 导航请求(HTML 页面) 用「网络优先、失败回退缓存」——保证有网时拿到最新版，没网时用缓存。
       · 其它静态资源用「缓存优先、回退网络并回填」——加快二次加载、离线可用。
 注意：本应用数据保存在 localStorage（键 gracie_v3），不经过 Service Worker，
       因此清理本 SW 缓存不会影响用户数据，但卸载/清理网站数据仍会清空 localStorage。
 ============================================================ */

/* 每次发布如改动核心资源，请提升此版本号以触发缓存更新 */
const CACHE_VERSION = 'gracie-pwa-v8.2.0';
const CACHE_NAME = CACHE_VERSION;

/* 预缓存的核心资源（相对 SW 所在目录） */
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

/* 安装：预缓存核心资源 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()) /* 立即激活新 SW */
  );
});

/* 激活：删除非当前版本的旧缓存 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim()) /* 立即接管已打开页面 */
  );
});

/* 拦截请求 */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* 仅处理 GET 请求；其它（POST 等）直接走网络 */
  if (req.method !== 'GET') return;

  /* 跨域请求不缓存，直接走网络 */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* HTML 导航：网络优先，失败回退缓存（保证更新及时 + 离线可用） */
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return resp;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  /* 其它静态资源：缓存优先，回退网络并回填缓存 */
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        /* 只缓存正常的同源响应 */
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});

/* 支持页面主动触发跳过等待（可选） */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
