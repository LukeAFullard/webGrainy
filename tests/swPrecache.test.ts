/**
 * The service worker's install step (production readiness review M1).
 *
 * GitHub Pages sends `Cache-Control: max-age=600`. When the precache read through the browser's
 * HTTP cache, a deploy within those 10 minutes stored the previous build's files under the new
 * build's cache name ("Reload to update" kept the old code), and a stale ONNX Runtime stored in
 * the shared runtime cache outlived later deploys. These tests run the real src/sw.js handlers
 * against in-memory caches and a recording fetch.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SW_URL = 'https://example.org/app/sw.js';
const abs = (u: string): string => new URL(u, SW_URL).href;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const SHELL = ['./', './index.html', './ui/main.js'];
const ORT = ['./ort/rt.mjs', './ort/rt.wasm'];
const ORT_BODY: Record<string, string> = { './ort/rt.mjs': 'runtime glue v2', './ort/rt.wasm': 'runtime wasm v2' };

class MemCache {
  readonly entries = new Map<string, Response>();
  readonly addAllRequests: Request[] = [];
  constructor(private readonly fetchFn: (r: Request) => Promise<Response>) {}
  async match(req: string | Request): Promise<Response | undefined> {
    const r = this.entries.get(typeof req === 'string' ? abs(req) : req.url);
    return r?.clone();
  }
  async put(req: string | Request, res: Response): Promise<void> {
    this.entries.set(typeof req === 'string' ? abs(req) : req.url, res);
  }
  async addAll(reqs: Request[]): Promise<void> {
    this.addAllRequests.push(...reqs);
    const got = await Promise.all(reqs.map((r) => this.fetchFn(r)));
    if (got.some((r) => !r.ok)) throw new TypeError('addAll: bad response');
    got.forEach((r, i) => this.entries.set(reqs[i]!.url, r));
  }
}

interface Harness {
  install(): Promise<void>;
  activate(): Promise<void>;
  caches: Map<string, MemCache>;
  fetched: Request[];
}

/** Runs src/sw.js with its build placeholders filled in, against in-memory caches. */
function loadSw(opts: { served?: Record<string, string>; missing?: string[]; expected?: Record<string, string>; preexisting?: string[] } = {}): Harness {
  const served: Record<string, string> = { './': '<html>', './index.html': '<html>', './ui/main.js': 'main v2', ...ORT_BODY, ...opts.served };
  for (const m of opts.missing ?? []) delete served[m];
  const expected = opts.expected ?? Object.fromEntries(ORT.map((u) => [u, sha(ORT_BODY[u]!)]));
  const src = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8')
    .replace('__WEBGRAINY_BUILD_HASH__', 'build2')
    .replace('__WEBGRAINY_ORT_VERSION__', '9.9.9')
    .replace('__WEBGRAINY_SHELL_ASSETS__', JSON.stringify(SHELL))
    .replace('__WEBGRAINY_ORT_ASSETS__', JSON.stringify(ORT))
    .replace('__WEBGRAINY_ORT_SHA256__', JSON.stringify(expected))
    .replace('__WEBGRAINY_ORT_FILES_ID__', 'ortid2');
  expect(src).not.toContain('__WEBGRAINY_');

  const fetched: Request[] = [];
  const fetchFn = async (r: Request): Promise<Response> => {
    fetched.push(r);
    const key = Object.keys(served).find((k) => abs(k) === r.url);
    return key === undefined
      ? new Response('missing', { status: 404 })
      : new Response(served[key as keyof typeof served], { status: 200, headers: { 'Content-Type': key.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
  };
  const store = new Map<string, MemCache>();
  for (const name of opts.preexisting ?? []) store.set(name, new MemCache(fetchFn));
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new MemCache(fetchFn));
      return store.get(name)!;
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    match: async () => undefined,
  };
  const handlers = new Map<string, (e: unknown) => void>();
  const self = {
    location: new URL(SW_URL),
    addEventListener: (type: string, cb: (e: unknown) => void) => handlers.set(type, cb),
    clients: { claim: async () => undefined, matchAll: async () => [] },
    skipWaiting: async () => undefined,
  };
  class SwRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, SW_URL) : input, init);
    }
  }
  new Function('self', 'caches', 'fetch', 'Request', 'Response', 'crypto', src)(self, caches, fetchFn, SwRequest, Response, globalThis.crypto);

  const run = async (type: string): Promise<void> => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { install: () => run('install'), activate: () => run('activate'), caches: store, fetched };
}

describe('service worker precache', () => {
  it('every precache request bypasses the browser HTTP cache', async () => {
    const sw = loadSw();
    await sw.install();
    const urls = sw.fetched.map((r) => r.url).sort();
    expect(urls).toEqual([...SHELL, ...ORT].map(abs).sort());
    for (const r of sw.fetched) expect(r.cache, r.url).toBe('reload');
  });

  it('stores the runtime files in a cache named by their hashes, with their content type', async () => {
    const sw = loadSw();
    await sw.install();
    const ort = sw.caches.get('webgrainy-ort-9.9.9-ortid2')!;
    expect(await (await ort.match('./ort/rt.wasm'))!.text()).toBe('runtime wasm v2');
    expect((await ort.match('./ort/rt.wasm'))!.headers.get('Content-Type')).toBe('application/wasm');
    expect(await (await sw.caches.get('webgrainy-shell-build2')!.match('./ui/main.js'))!.text()).toBe('main v2');
  });

  it('refuses a runtime file that is not this build’s (e.g. a stale copy) and fails the install', async () => {
    const sw = loadSw({ served: { './ort/rt.wasm': 'runtime wasm v1 (stale)' } });
    await expect(sw.install()).rejects.toThrow(/rt\.wasm: SHA-256 .* does not match this build/);
    const ort = sw.caches.get('webgrainy-ort-9.9.9-ortid2')!;
    expect(await ort.match('./ort/rt.wasm')).toBeUndefined();
  });

  it('fails the install on an HTTP error instead of caching the error page', async () => {
    const sw = loadSw({ missing: ['./ort/rt.wasm'] });
    await expect(sw.install()).rejects.toThrow(/rt\.wasm: HTTP 404/);
    expect(await sw.caches.get('webgrainy-ort-9.9.9-ortid2')!.match('./ort/rt.wasm')).toBeUndefined();
  });

  it('does not download runtime files already verified into the cache (UI-only release)', async () => {
    const first = loadSw();
    await first.install();
    const second = loadSw({ preexisting: [] });
    second.caches.set('webgrainy-ort-9.9.9-ortid2', first.caches.get('webgrainy-ort-9.9.9-ortid2')!);
    await second.install();
    expect(second.fetched.map((r) => r.url).filter((u) => u.includes('/ort/'))).toEqual([]);
  });

  it('activation removes earlier caches, including the version-only runtime cache of older builds', async () => {
    const sw = loadSw({ preexisting: ['webgrainy-shell-build1', 'webgrainy-ort-9.9.9', 'other-app-cache'] });
    await sw.install();
    await sw.activate();
    expect([...sw.caches.keys()].sort()).toEqual(['other-app-cache', 'webgrainy-ort-9.9.9-ortid2', 'webgrainy-shell-build2']);
  });
});
