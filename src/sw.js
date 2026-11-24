// webGrainy service worker.
//
// The placeholders below are replaced by esbuild.config.mjs at build time:
//   - BUILD_HASH:  SHA-256 over every shell asset, so ANY code change yields a new
//                  cache name and therefore a new service worker (no hand-bumping).
//   - SHELL_ASSETS / ORT_ASSETS: generated precache lists.
//   - ORT_VERSION: onnxruntime-web version; the ~30 MB runtime lives in its own cache
//                  so UI-only releases do not re-download it.
//   - ORT_SHA256 / ORT_FILES_ID: SHA-256 of each runtime file, and an id derived from them
//                  that names the runtime cache (see precacheOrt).
const BUILD_HASH = '__WEBGRAINY_BUILD_HASH__';
const ORT_VERSION = '__WEBGRAINY_ORT_VERSION__';
const SHELL_ASSETS = __WEBGRAINY_SHELL_ASSETS__;
const ORT_ASSETS = __WEBGRAINY_ORT_ASSETS__;
const ORT_SHA256 = __WEBGRAINY_ORT_SHA256__;
const ORT_FILES_ID = '__WEBGRAINY_ORT_FILES_ID__';

const SHELL_CACHE = `webgrainy-shell-${BUILD_HASH}`;
// Named by the runtime files' hashes, not only the version, so a cache filled by an earlier
// service worker without the checks below (possibly with stale files) is never reused.
const ORT_CACHE = `webgrainy-ort-${ORT_VERSION}-${ORT_FILES_ID}`;
const KEEP = new Set([SHELL_CACHE, ORT_CACHE]);

// Precache requests bypass the browser's HTTP cache. Hosts such as GitHub Pages send
// `Cache-Control: max-age=600`: a plain fetch soon after a deploy returns the previous build's
// files from the HTTP cache, which would then be stored under the NEW build's cache name, so
// "Reload to update" would keep running the old code (until the next deploy).
const fresh = (url) => new Request(url, { cache: 'reload' });

async function sha256Hex(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// The runtime cache is shared by every build with the same runtime and only missing files are
// fetched, so a wrong file stored here would outlive later deploys. Each file is therefore
// stored only after its SHA-256 matched this build. On a mismatch (e.g. a CDN still serving
// the previous deploy) the install fails and the browser retries the update on a later visit.
async function precacheOrt() {
  const cache = await caches.open(ORT_CACHE);
  for (const url of ORT_ASSETS) {
    if (await cache.match(url)) continue;
    const res = await fetch(fresh(url));
    if (!res.ok) throw new Error(`Precache ${url}: HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    const actual = await sha256Hex(body);
    if (actual !== ORT_SHA256[url]) {
      throw new Error(`Precache ${url}: SHA-256 ${actual} does not match this build (${ORT_SHA256[url]})`);
    }
    await cache.put(url, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }));
  }
}

// Cross-origin isolation (COOP/COEP) lets onnxruntime-web use WASM threads (about 2-3x
// faster CPU inference; see DEPLOYMENT.md). Many static hosts (e.g. GitHub Pages) cannot
// set these headers, so the service worker adds them to every same-origin response it
// serves. Headers the server already sends are kept. Cross-origin requests (the model
// download) are fetched in CORS mode by the page, which COEP require-corp allows.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function withIsolationHeaders(response) {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS.map(fresh))),
      precacheOrt(),
    ]),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    // The user chose "Reload to update".
    self.skipWaiting();
  } else if (type === 'SKIP_WAITING_IF_ALONE') {
    // Automatic switch at page start-up: only when the asking page is the app's only tab.
    // Otherwise other open tabs would be taken over and load this build's workers under
    // their old code (and this activation would delete their cache).
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
        if (windows.length <= 1) return self.skipWaiting();
        if (event.source) event.source.postMessage({ type: 'SKIP_WAITING_DEFERRED' });
        return undefined;
      }),
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('webgrainy-') && !KEEP.has(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin requests (Hugging Face model weights) are not intercepted: weights are
  // integrity-verified and cached in IndexedDB by modelCache.ts.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigations: the page from this build's cache, so the HTML always matches the cached
  // scripts (a newer index.html from the network with this build's main.js could break).
  // New deployments are still found: the browser re-checks sw.js on every navigation, and the
  // app offers "Reload to update" once the new worker is waiting. Pages not precached go to the
  // network, falling back to the shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches
        .match(req, { ignoreSearch: true, cacheName: SHELL_CACHE })
        .then((cached) =>
          cached ||
          fetch(req).catch(() => caches.match('./index.html', { cacheName: SHELL_CACHE })),
        )
        .then(withIsolationHeaders),
    );
    return;
  }

  // Versioned assets: serve only from this build's caches so code always matches the
  // shell it was precached with. Unknown same-origin requests go to the network and are
  // never written into the versioned caches.
  event.respondWith(
    caches
      .match(req, { ignoreSearch: true, cacheName: SHELL_CACHE })
      .then((cached) => cached || caches.match(req, { ignoreSearch: true, cacheName: ORT_CACHE }))
      .then((cached) => cached || fetch(req))
      .then(withIsolationHeaders),
  );
});
