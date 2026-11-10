'use strict';

// データ更新・画面変更のたびに番号を上げる（全体を入れ替えるため）
const CACHE = 'smokingmap-v7';
const SHELL = [
  './',
  './index.html',
  './credits.html',
  './credits.js',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './data/smoking-jp.json', // 全国の喫煙所。圏外でも探せるよう端末に持つ
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        for (const path of SHELL) {
          try {
            await cache.add(new Request(path, { cache: 'reload' }));
          } catch {
            // 1ファイル失敗しても install 全体を中止しない
          }
        }
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('smokingmap-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// 同一オリジンの GET だけ。キャッシュがあれば即返し、裏で更新する（次回起動で反映）。地図タイルは対象外。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request, { signal: AbortSignal.timeout(8000) }).then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      });
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network.catch(() => new Response('オフラインです', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    }),
  );
});
