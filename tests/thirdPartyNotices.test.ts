/**
 * The ONNX Runtime WebAssembly binary shipped in dist/ort/ contains compiled third-party code
 * (Protocol Buffers, Abseil, RE2, ONNX, ...) whose licences require their notices to travel with
 * it (production readiness review M2). The notices are vendored per ONNX Runtime version.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderAboutModalHtml } from '../src/ui/modals.js';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ortVersion = (JSON.parse(read('node_modules/onnxruntime-web/package.json')) as { version: string }).version;
const vendored = `licenses/onnxruntime-${ortVersion}-ThirdPartyNotices.txt`;

describe('ONNX Runtime third-party notices', () => {
  it('are vendored for the installed onnxruntime-web version', () => {
    const text = read(vendored);
    expect(text.startsWith('THIRD PARTY SOFTWARE NOTICES AND INFORMATION')).toBe(true);
    // Components whose code is compiled into the shipped .wasm.
    for (const component of ['protobuf', 'abseil', 're2', 'onnx/onnx', 'Eigen']) {
      expect(text.toLowerCase(), component).toContain(component.toLowerCase());
    }
  });

  it('THIRD_PARTY_NOTICES.md names the vendored file and its SHA-256', () => {
    const notices = read('THIRD_PARTY_NOTICES.md');
    expect(notices).toContain(vendored);
    expect(notices).toContain(`ONNX Runtime **${ortVersion}**`);
    const sha = createHash('sha256').update(readFileSync(new URL(`../${vendored}`, import.meta.url))).digest('hex');
    expect(notices).toContain(sha);
    expect(notices).not.toContain('onnxruntime/blob/main/ThirdPartyNotices.txt');
  });

  it('ship with the app: copied next to the runtime, precached, and linked from About', () => {
    const build = read('esbuild.config.mjs');
    expect(build).toContain("'./ort/ThirdPartyNotices.txt'");
    expect(build).toContain("path.join(ortDistDir, 'ThirdPartyNotices.txt')");
    expect(renderAboutModalHtml()).toContain('href="./ort/ThirdPartyNotices.txt"');
  });
});
