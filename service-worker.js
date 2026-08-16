'use strict';

/* ============================================================
 成长冒险岛 · 自律成长 APP v8.9.0 — Service Worker
 GitHub Pages / PWA 离线缓存
 ============================================================ */

const CACHE_PREFIX = 'gracie-pwa-';
const CACHE_VERSION = 'v8.9.0-20260815-child-sync-4';
const STATIC_CACHE = `${CACHE_PREFIX}${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_PREFIX}${CACHE_VERSION}-runtime`;

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
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* 激活：仅清理本应用的旧缓存，不影响同域其他应用 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX) &&
                key !== STATIC_CACHE &&
                key !== RUNTIME_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* 导航请求：网络优先，离线回退 index.html */
async function handleNavigation(request) {
  try {
    const response = await fetch(request, {
      cache: 'no-store'
    });

    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    return (
      (await caches.match(request)) ||
      (await caches.match('./index.html')) ||
      (await caches.match('./')) ||
      new Response('应用当前处于离线状态，且尚未完成离线缓存。', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        }
      })
    );
  }
}

/* 静态资源：缓存优先，未命中时请求网络并回填 */
async function handleStaticAsset(request) {
  const cached = await caches.match(request);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);

    if (
      response &&
      response.ok &&
      response.type === 'basic'
    ) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    return new Response('', {
      status: 504,
      statusText: 'Gateway Timeout'
    });
  }
}

/* 请求拦截 */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  /* 仅处理 GET */
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  /* Supabase、CDN 等跨域请求直接交给浏览器 */
  if (url.origin !== self.location.origin) {
    return;
  }

  const acceptsHTML = (
    request.headers.get('accept') || ''
  ).includes('text/html');

  if (request.mode === 'navigate' || acceptsHTML) {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleStaticAsset(request));
});

/*
 * 与 index.html 的更新逻辑兼容：
 * index.html 发送：
 * worker.postMessage({ type: 'SKIP_WAITING' })
 *
 * 同时兼容旧版字符串消息。
 */
self.addEventListener('message', (event) => {
  const data = event.data;

  if (
    data === 'SKIP_WAITING' ||
    (data && data.type === 'SKIP_WAITING')
  ) {
    self.skipWaiting();
  }
});