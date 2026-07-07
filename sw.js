// service worker — cache app shell ให้ติดตั้ง/ใช้ออฟไลน์ได้ (PWA)
// เปลี่ยนเลขเวอร์ชันเมื่อแก้ไฟล์ใน ASSETS เพื่อบังคับ refresh cache
const CACHE = 'kcebudget-v3';
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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network-first: ออนไลน์ = ได้โค้ดใหม่เสมอ (กันเสิร์ฟ app.js เก่าค้าง), ออฟไลน์ = fallback cache
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, clone)); }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
