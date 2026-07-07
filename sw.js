// service worker — cache app shell ให้ติดตั้ง/ใช้ออฟไลน์ได้ (PWA)
// เปลี่ยนเลขเวอร์ชันเมื่อแก้ไฟล์ใน ASSETS เพื่อบังคับ refresh cache
const CACHE = 'kcebudget-v2';
const ASSETS = [
  './', './index.html', './app.js', './config.js', './api.js', './parser.js',
  './manifest.webmanifest', './icon.svg',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // GAS backend ต้อง online เสมอ — อย่าแตะ/อย่า cache
  if (url.hostname.includes('script.google.com')) return;
  if (e.request.method !== 'GET') return;
  // cache-first + เติม cache ไฟล์ same-origin ที่โหลดสำเร็จ, ออฟไลน์ fallback = index
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && url.origin === location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
