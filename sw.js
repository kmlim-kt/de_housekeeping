// =====================================================================
// 서비스 워커 — 앱 화면을 오프라인에서도 열 수 있게 파일을 기기에 보관
//   우리 파일: 네트워크 우선 (항상 최신), 안 되면 보관본
//   supabase-js(CDN, 버전 고정): 보관본 우선
//   Supabase API 요청: 건드리지 않음 (데이터는 오프라인 대기열이 담당)
// 파일을 추가·삭제하면 PRECACHE 목록과 VERSION을 함께 바꾸세요.
// (node tools/coretest.mjs 가 목록 누락을 검사합니다)
// =====================================================================

const VERSION = 'v11-1';
const CACHE = 'dh-app-' + VERSION;
const CDN_CACHE = 'dh-cdn-1';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js';   // 대시보드 그래프
const FONT_CSS = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';   // 글꼴 (글자 파일은 쓰일 때 보관)

const PRECACHE = [
  './',
  'index.html',
  'config.js',
  'manifest.json',
  'css/app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'js/app.js',
  'js/core/backup.js',
  'js/core/balance.js',
  'js/core/budget.js',
  'js/core/csv.js',
  'js/core/exports.js',
  'js/core/importer.js',
  'js/core/journal.js',
  'js/core/money.js',
  'js/core/recurring.js',
  'js/core/reports.js',
  'js/core/simple.js',
  'js/data/api.js',
  'js/data/errors.js',
  'js/data/outbox.js',
  'js/data/supabase.js',
  'js/data/sync.js',
  'js/ui/amount-input.js',
  'js/ui/auth.js',
  'js/ui/budget-view.js',
  'js/ui/charts.js',
  'js/ui/chips.js',
  'js/ui/dom.js',
  'js/ui/download.js',
  'js/ui/recurring-due.js',
  'js/ui/shell.js',
  'js/ui/state.js',
  'js/ui/statement.js',
  'js/ui/theme.js',
  'js/ui/widgets.js',
  'js/ui/screens/accounts.js',
  'js/ui/screens/data.js',
  'js/ui/screens/dashboard.js',
  'js/ui/screens/entry-advanced.js',
  'js/ui/screens/entry-simple.js',
  'js/ui/screens/entry.js',
  'js/ui/screens/favorites.js',
  'js/ui/screens/import.js',
  'js/ui/screens/ledger.js',
  'js/ui/screens/list.js',
  'js/ui/screens/opening.js',
  'js/ui/screens/recurring.js',
  'js/ui/screens/report-budget.js',
  'js/ui/screens/report-bs.js',
  'js/ui/screens/report-is.js',
  'js/ui/screens/report-ledger.js',
  'js/ui/screens/report-trial.js',
  'js/ui/screens/reports.js',
  'js/ui/screens/settings.js',
  'js/ui/screens/txn.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' })));
    await precacheCdn(SUPABASE_JS);
    await precacheCdn(CHART_JS);
    await precacheCdn(FONT_CSS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('dh-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === 'https://cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
  // 그 밖(Supabase API 등)은 브라우저 기본 동작
});

/** 네트워크 우선 (4초 넘게 걸리면 보관본) */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const isPage = req.mode === 'navigate';
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    // ?source=pwa 같은 주소 뒤 값은 무시하고 찾고, 페이지인데 보관본이 없으면 앱 첫 화면
    const hit = await cache.match(req, { ignoreSearch: true })
      ?? (isPage ? await cache.match('./') : undefined);
    if (hit) return hit;
    return new Response('오프라인이라 이 화면을 열 수 없습니다.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** 보관본 우선 (버전 고정 라이브러리) */
async function cacheFirst(req) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

/** CDN 모듈과 그 모듈이 불러오는 하위 모듈까지 미리 보관 */
async function precacheCdn(entry) {
  const cache = await caches.open(CDN_CACHE);
  const seen = new Set();
  const queue = [entry];
  while (queue.length && seen.size < 40) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      let res = await cache.match(url);
      if (!res) {
        res = await fetch(url);
        if (!res.ok) continue;
        await cache.put(url, res.clone());
      }
      const text = await res.text();
      for (const m of text.matchAll(/["'](\/npm\/[^"'\s]+)["']/g)) {
        queue.push(new URL(m[1], 'https://cdn.jsdelivr.net').href);
      }
    } catch {
      /* 일부 실패해도 설치는 계속 (다음 온라인 실행 때 채워짐) */
    }
  }
}
