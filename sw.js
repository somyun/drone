// 오프라인 지원: 앱 파일은 네트워크 우선, 실패 시 캐시 (현장 통신 불량 대비)
const CACHE = 'field-wp-v3';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/wpml.js', 'js/zip.js', 'manifest.webmanifest', 'icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isTile = /tile\.openstreetmap|arcgisonline/.test(url.host);
  if (isTile) {
    // 지도 타일: 캐시 우선 (한 번 본 지역은 오프라인에서도 표시)
    e.respondWith(caches.open(CACHE + '-tiles').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; } catch { return hit || Response.error(); }
    }));
    return;
  }
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (url.origin === location.origin || url.host === 'unpkg.com')) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
