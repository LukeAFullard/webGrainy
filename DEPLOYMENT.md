# Deploying webGrainy

webGrainy is a static site: deploy the contents of `dist/` after `npm ci && npm run build`.
The app has no server-side component.

## GitHub Pages (this repository)

`.github/workflows/pages.yml` builds the app and publishes `dist/` on every push to `main`
(or on demand via *Actions → Deploy app to GitHub Pages → Run workflow*).

**One-time setup:** go to *Settings → Pages → Build and deployment → Source*, and choose
**GitHub Actions** (instead of "Deploy from a branch"). The app is then served at
`https://<owner>.github.io/<repo>/`, and the GPU check page at `…/gpucheck.html`.
GitHub Pages can't set COOP/COEP headers; the app's service worker adds them (see below).

## Requirements

| Requirement | Why |
|---|---|
| **HTTPS** (or `http://localhost` for development) | Service workers, `crypto.subtle` (the model SHA-256 check) and WebGPU all require a secure context. Over plain HTTP the model integrity check fails, and the model is refused. |
| `.wasm` served as **`application/wasm`** | Needed for streaming WebAssembly compilation of `ort/ort-wasm-simd-threaded.jsep.wasm` (~29 MB). |
| `.mjs` / `.js` served as **`text/javascript`** | ORT loads `ort/*.mjs` with dynamic `import()`. Strict MIME checking rejects other types. |
| `.webmanifest` as `application/manifest+json` | PWA install. |
| Outbound access to `https://huggingface.co` and `https://*.hf.co` | One-time model download (pinned revision, SHA-256 verified, then cached in IndexedDB). |

### Base path

All URLs are relative to `index.html`. You can host from a sub-path such as
`https://example.org/tools/webgrainy/`. Keep the directory layout of `dist/` intact:
`ui/`, `workers/` and `ort/` must sit next to `index.html`. The ORT runtime path is
resolved against the page URL (`document.baseURI`), not the script URL.

## Recommended HTTP headers

`index.html` ships a CSP `<meta>` tag. Sending the policy as a header is stronger, because
it can also set `frame-ancestors`:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

### Recommended: multi-threaded WASM (cross-origin isolation)

**Automatic on any host:** the app's service worker adds the COOP/COEP headers to every
same-origin response, so the page becomes cross-origin isolated even where you cannot
configure headers (e.g. GitHub Pages). On the first visit the page reloads once,
automatically, after the service worker installs. This happens at most once per tab
session and never during a batch. The top bar shows the thread count
(e.g. "WASM SIMD · 4 CPU threads"). Sending the headers from your server as well (below)
makes the very first load isolated too and avoids that reload. Verified in Chromium with
the real Hugging Face model download (`audit/review/sw_isolation_check.cjs`).

Without cross-origin isolation, the WASM backend (the fallback when no WebGPU adapter is
available) runs **single-threaded**. When the page is isolated, the app uses all logical
cores (capped at 8). Measured in headless Chromium on a 4-core machine (`audit/perf/`):

| Workload (CPU / WASM) | Not isolated (1 thread) | Isolated, ORT default (2 threads) | Isolated, all cores (4 threads) |
|---|---|---|---|
| U-Net inference, 1024×768 photo | 18.4 s | 11.0 s | **6.7 s** |
| Whole analysis incl. ~1.2 s post-processing | 19.7 s | 12.4 s | **7.9 s** |
| Cellpose-SAM, one 256×256 tile (Node, same runtime) | 32.3 s | 16.8 s | **9.5 s** |

A 1024×768 photo needs about 20 Cellpose-SAM tiles, so on CPU it takes roughly 11 minutes
single-threaded and roughly 3 minutes isolated on 4 cores (these are FP16 timings; the INT8
weights, used automatically on the CPU since this release, are about 2× faster). Prefer U-Net when no FP16-capable GPU is
available. To enable WASM threads, send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

With COEP `require-corp`, the cross-origin model download must be CORS-enabled.
Hugging Face sends `Access-Control-Allow-Origin: *`, and the app fetches in CORS mode,
so it works. Verify after deploying that `self.crossOriginIsolated === true` in the
console and that a model download still succeeds.

## Caching

- `sw.js` must **not** be cached by the HTTP layer (`Cache-Control: no-cache`). The app
  registers it with `updateViaCache: 'none'`, but CDN caching can still delay updates.
- Each build stamps `sw.js` with a content hash of the app shell. Any code change
  produces a new service worker, which precaches the new shell. The app then activates
  it and prompts the user to reload. The ~30 MB ORT runtime is cached separately, keyed
  by ORT version, so UI-only releases do not re-download it.
- Other files can be cached normally. The service worker serves them from its
  versioned cache.

## Example: nginx

```nginx
location /webgrainy/ {
  alias /srv/webgrainy/dist/;
  types { application/wasm wasm; text/javascript mjs js; application/manifest+json webmanifest; }
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'" always;
  location ~ /sw\.js$ { add_header Cache-Control "no-cache" always; }
}
```

## Post-deployment checklist

1. Open the site and check the DevTools console for errors, failed requests or CSP violations.
2. Analyse a photo with U-Net. "Models (1 cached)" should appear, and the photo should finish `done`.
3. Go offline (DevTools → Network → Offline), reload, and analyse again. It must work
   without network access once the model and runtime are cached.
4. Export a summary JSON and confirm that `metadata.analysis.modelSha256` matches the
   pinned hash in `src/modules/modelCache.ts`.

Run `npm run test:e2e:browser` locally against the exact `dist/` you deploy. It checks
steps 1–2 headlessly.

## Browser support (expected; not exhaustively tested)

| Browser | U-Net (26 MB) | Cellpose-SAM (FP16 617 MB / INT8 316 MB / FP4 183 MB) | Notes |
|---|---|---|---|
| Chrome / Edge ≥ 121 desktop | WebGPU or WASM | WebGPU (needs `shader-f16` adapter) | Primary target |
| Firefox desktop | WASM (WebGPU where enabled) | Not recommended | |
| Safari ≥ 17.4 macOS | WebGPU/WASM | Memory-limited | |
| iOS / Android | WASM | **Not supported** (memory) | Use U-Net and downscaled images |

Headless or blocklisted GPUs report no WebGPU adapter. The app detects this and uses
WASM, and the top bar shows "WASM SIMD".
