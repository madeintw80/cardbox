// 名片盒 Service Worker：讓 App 可以加到主畫面、沒網路也打得開
// 策略：自己網站的檔案「先上網拿最新、失敗才用快取」（network-first）
//      Google／中繼站的請求一律不攔（登入、雲端、AI 都要即時）
// 升版：CACHE 的數字要跟 js/config.js 的 VERSION 一起改

const CACHE = 'cardbox-v0.1.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css?v=1',
  './js/app.js?v=1',
  './js/config.js',
  './js/auth.js',
  './js/google.js',
  './js/cards.js',
  './js/image.js',
  './js/localdb.js',
  './js/ocr.js',
  './js/demo.js',
  './js/store.js',
  './js/queue.js',
  './js/camera.js',
  './js/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('cardbox-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google、中繼站都不攔

  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      // 404／500 不是「沒網路」，不能拿來蓋掉好的快取
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
