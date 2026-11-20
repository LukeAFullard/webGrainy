// webGrainy service worker.
//
// The placeholders below are replaced by esbuild.config.mjs at build time:
//   - BUILD_HASH:  SHA-256 over every shell asset, so ANY code change yields a new
//                  cache name and therefore a new service worker (no hand-bumping).
//   - SHELL_ASSETS / ORT_ASSETS: generated precache lists.
//   - ORT_VERSION: onnxruntime-web version; the ~30 MB runtime lives in its own cache
//                  so UI-only releases do not re-download it.
const BUILD_HASH = '__WEBGRAINY_BUILD_HASH__';
const ORT_VERSION = '__WEBGRAINY_ORT_VERSION__';
const SHELL_ASSETS = __WEBGRAINY_SHELL_ASSETS__;
const ORT_ASSETS = __WEBGRAINY_ORT_ASSETS__;

const SHELL_CACHE = `webgrainy-shell-${BUILD_HASH}`;
const ORT_CACHE = `webgrainy-ort-${ORT_VERSION}`;
const KEEP = new Set([SHELL_CACHE, ORT_CACHE]);

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
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
      caches.open(ORT_CACHE).then(async (cache) => {
        // Only fetch runtime files that are not already cached for this ORT version.
        const missing = [];
        for (const url of ORT_ASSETS) {
          if (!(await cache.match(url))) missing.push(url);
        }
        await cache.addAll(missing);
      }),
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

  // Navigations: network-first so a new deployment is discovered, falling back to the
  // precached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .catch(() =>
          caches
            .match(req, { cacheName: SHELL_CACHE })
            .then((cached) => cached || caches.match('./index.html', { cacheName: SHELL_CACHE })),
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
      .match(req, { ignoreSearch: true })
      .then((cached) => cached || fetch(req))
      .then(withIsolationHeaders),
  );
});
