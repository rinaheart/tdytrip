/**
 * TdyTripPWA2026 - Service Worker (Phase 4)
 * Phiên bản: v0.4.0
 * 
 * QUY TẮC BẤT BIẾN:
 * 1. CHỈ PRECACHE APP SHELL TĨNH (HTML, CSS, JS, ICONS).
 * 2. CẤM TUYỆT ĐỐI CACHE API (Google Apps Script, /exec, action=*): BẮT BUỘC NETWORK-ONLY.
 * 3. Hỗ trợ cập nhật tức thì (skipWaiting + clients.claim).
 */

const CACHE_NAME = 'tdytrip-shell-v0.4.2-20261021_1528';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles.css',
  './src/app.js',
  './src/version.js',
  './src/core/math.js',
  './src/storage/db.js',
  './src/sync/engine.js',
  './src/sync/outbox.js',
  './src/sync/push.js',
  './src/sync/pull.js',
  './src/sync/reconcile.js',
  './src/sync/transport.js',
  './src/ui/components.js',
  './src/ui/state.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png'
];

// 1. Cài đặt Service Worker & Precache Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 2. Kích hoạt & Dọn dẹp cache cũ
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Xử lý Fetch
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // BẮT BUỘC: Mọi request POST hoặc gọi tới API Google Apps Script phải Network-Only
  const isApiRequest = 
    req.method !== 'GET' ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.searchParams.has('action');

  if (isApiRequest) {
    // Không bao giờ can thiệp hoặc cache API call
    return;
  }

  // Đối với tài nguyên tĩnh (App Shell): Stale-While-Revalidate + Navigation Fallback
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        // Có sẵn trong cache -> Phục vụ ngay, đồng thời revalidate ngầm
        fetch(req).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
        }).catch(() => {});
        return cachedResponse;
      }

      // Request navigation (F5 / tải trang khi offline) -> fallback về index.html trong cache
      if (req.mode === 'navigate') {
        return caches.match('./index.html').then((indexRes) => {
          return indexRes || caches.match('/index.html') || fetch(req);
        }).catch(() => fetch(req));
      }

      // Chưa có trong cache -> Fetch từ network và lưu vào cache
      return fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});

// 4. Nhận thông điệp từ Client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
