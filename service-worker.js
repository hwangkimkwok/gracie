'use strict';

/* ============================================================
 成长冒险岛 v9.0.0 Service Worker
 ============================================================ */

const CACHE_PREFIX = 'gracie-pwa-';

const CACHE_VERSION =
  'v9.0.0-20260816-sync-final-1';

const STATIC_CACHE =
  CACHE_PREFIX +
  CACHE_VERSION +
  '-static';

const RUNTIME_CACHE =
  CACHE_PREFIX +
  CACHE_VERSION +
  '-runtime';

const CORE_ASSETS = [
  './',
  './index.html',
  './v9-sync-patch.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

/* 安装并缓存核心文件 */
self.addEventListener(
  'install',
  function (event) {
    event.waitUntil(
      caches
        .open(STATIC_CACHE)
        .then(function (cache) {
          return cache.addAll(
            CORE_ASSETS
          );
        })
        .then(function () {
          return self.skipWaiting();
        })
    );
  }
);

/* 删除本应用旧缓存 */
self.addEventListener(
  'activate',
  function (event) {
    event.waitUntil(
      caches
        .keys()
        .then(function (keys) {
          return Promise.all(
            keys
              .filter(function (key) {
                return (
                  key.startsWith(
                    CACHE_PREFIX
                  ) &&
                  key !== STATIC_CACHE &&
                  key !== RUNTIME_CACHE
                );
              })
              .map(function (key) {
                return caches.delete(key);
              })
          );
        })
        .then(function () {
          return self.clients.claim();
        })
    );
  }
);

/* 页面导航：网络优先 */
async function handleNavigation(
  request
) {
  try {
    const response =
      await fetch(request, {
        cache: 'no-store'
      });

    if (
      response &&
      response.ok
    ) {
      const cache =
        await caches.open(
          RUNTIME_CACHE
        );

      await cache.put(
        request,
        response.clone()
      );
    }

    return response;
  } catch (error) {
    return (
      await caches.match(request)
    ) || (
      await caches.match(
        './index.html'
      )
    ) || (
      await caches.match('./')
    ) || new Response(
      '应用当前处于离线状态，且尚未完成离线缓存。',
      {
        status: 503,
        headers: {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      }
    );
  }
}

/* 本地静态资源：网络优先，失败再用缓存 */
async function handleStaticAsset(
  request
) {
  try {
    const response =
      await fetch(request, {
        cache: 'no-cache'
      });

    if (
      response &&
      response.ok &&
      response.type === 'basic'
    ) {
      const cache =
        await caches.open(
          RUNTIME_CACHE
        );

      await cache.put(
        request,
        response.clone()
      );
    }

    return response;
  } catch (error) {
    const cached =
      await caches.match(request);

    if (cached) {
      return cached;
    }

    return new Response('', {
      status: 504,
      statusText:
        'Gateway Timeout'
    });
  }
}

/* 拦截请求 */
self.addEventListener(
  'fetch',
  function (event) {
    const request = event.request;

    if (request.method !== 'GET') {
      return;
    }

    const url =
      new URL(request.url);

    /*
     * Supabase 和 CDN 请求不缓存，
     * 直接交给浏览器处理。
     */
    if (
      url.origin !==
      self.location.origin
    ) {
      return;
    }

    const acceptsHTML =
      (
        request.headers.get(
          'accept'
        ) || ''
      ).includes('text/html');

    if (
      request.mode === 'navigate' ||
      acceptsHTML
    ) {
      event.respondWith(
        handleNavigation(request)
      );
      return;
    }

    event.respondWith(
      handleStaticAsset(request)
    );
  }
);

/* 接收前端主动更新指令 */
self.addEventListener(
  'message',
  function (event) {
    const data = event.data;

    if (
      data === 'SKIP_WAITING' ||
      (
        data &&
        data.type ===
          'SKIP_WAITING'
      )
    ) {
      self.skipWaiting();
    }
  }
);
