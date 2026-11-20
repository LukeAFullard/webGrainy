import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../src/modules/zip.js';
import { readZip } from './helpers/readZip.js';

describe('buildZip', () => {
  it('writes text (deflated), binary and Blob entries that read back exactly', async () => {
    const text = 'grain_id,b_axis_mm\n' + Array.from({ length: 500 }, (_, i) => `${i},${(i * 0.37).toFixed(3)}`).join('\n');
    const bin = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7919) & 0xff);
    const big = new Blob([new Uint8Array(200_000).fill(42)]);
    const zip = await buildZip([
      { name: 'site/summary.csv', data: text },
      { name: 'photos/mask.png', data: bin },
      { name: 'project.webgrainy', data: big },
      { name: 'README – ünïcode.txt', data: 'héllo' },
    ]);
    const files = readZip(new Uint8Array(await zip.arrayBuffer()));
    expect(new TextDecoder().decode(files.get('site/summary.csv'))).toBe(text);
    expect(files.get('photos/mask.png')).toEqual(bin);
    expect(files.get('project.webgrainy')!.byteLength).toBe(200_000);
    expect(new TextDecoder().decode(files.get('README – ünïcode.txt'))).toBe('héllo');
    // Text was compressed (when the platform supports deflate-raw).
    expect(zip.size).toBeLessThan(text.length + 3000 + 200_000 + 1000);
  });
  it('rejects duplicate names', async () => {
    await expect(buildZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }])).rejects.toThrow(/Duplicate/);
  });
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
