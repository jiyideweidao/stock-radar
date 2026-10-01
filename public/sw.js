'use strict';
/**
 * 手机端离线外壳。
 *
 * 只做两件事：
 *   1) 缓存页面骨架（index.html / app.js / styles.css / 图标），断网或弱网时至少能打开界面，
 *      而不是甩一个浏览器报错页；
 *   2) 接口（/api/…）一律走网络，绝不缓存 —— 行情、库存这类数据一旦拿旧值冒充新值，
 *      比打不开还危险。拿不到就在界面上如实显示「取不到」。
 *
 * 策略是「网络优先 + 缓存兜底」：在线时永远用最新代码，不会出现改完代码刷新还在跑旧版的问题。
 */

const VERSION = 'stock-radar-shell-v1';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

/**
 * 服务端对 html/js/css 发了 Cache-Control: no-store（防止浏览器缓存旧代码），
 * 而 Cache API 会拒绝存放带 no-store 的响应。这里把该响应体重新包一遍、
 * 只去掉 cache-control，网络路径上的 no-store 不受影响，代码新鲜度照旧。
 */
async function storable(res) {
  if (!res || res.status !== 200 || res.type === 'opaque') return null;
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'cache-control') headers.set(key, value);
  });
  headers.set('Cache-Control', 'max-age=0');
  const body = await res.blob();
  return new Response(body, { status: 200, statusText: 'OK', headers: headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 逐个取：某个资源一时取不到，不要连累整个安装失败
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        const copy = await storable(res);
        if (copy) await cache.put(url, copy);
      } catch (err) { /* 忽略单个失败 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  // 跨站（同花顺 / 金融界的 iframe 等）不插手
  if (url.origin !== self.location.origin) return;
  // 接口：永远走网络
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200) {
        const copy = await storable(res.clone());
        if (copy) {
          const cache = await caches.open(VERSION);
          cache.put(req, copy).catch(() => {});
        }
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
