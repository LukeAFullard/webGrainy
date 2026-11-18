// In-app settings help and the newly exposed settings.
import { readdirSync, readFileSync } from 'node:fs';

/** Source of every UI module (main.ts and the panel renderers). */
function uiSource(): string {
  const files = ['src/ui/main.ts', ...readdirSync('src/ui/panels').map((f) => `src/ui/panels/${f}`)];
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}
import { describe, expect, it } from 'vitest';
import { HELP_GROUP_ORDER, HELP_TOPICS, helpButton, isHelpKey, renderHelpModalHtml } from '../src/ui/help.js';
import { defaultAnalysisParams, toAnalysisConfig } from '../src/ui/state.js';
import { DEFAULT_POSTPROCESS_OPTIONS } from '../src/modules/postprocessCore.js';

describe('settings help content', () => {
  it('every topic has a title, a known group, what / default / when text', () => {
    for (const [key, t] of Object.entries(HELP_TOPICS)) {
      expect(t.title.length, key).toBeGreaterThan(0);
      expect(HELP_GROUP_ORDER).toContain(t.group);
      expect(t.what.length, key).toBeGreaterThan(20);
      expect(t.default.length, key).toBeGreaterThan(0);
      expect(t.when.length, key).toBeGreaterThan(10);
    }
  });

  it('every help button used in the UI refers to an existing topic', () => {
    const src = uiSource();
    const used = [...src.matchAll(/helpButton\('([A-Za-z0-9]+)'\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    for (const k of used) expect(isHelpKey(k), k).toBe(true);
  });

  it('every user-facing setting control has a help button next to it', () => {
    const src = uiSource();
    const params = [...src.matchAll(/data-(?:param|site-opt)="([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
    const helped = new Set([...src.matchAll(/helpButton\('([A-Za-z0-9]+)'\)/g)].map((m) => m[1]!));
    for (const p of new Set(params)) expect(helped.has(p), `missing help for ${p}`).toBe(true);
  });

  it('documented defaults match the engine defaults', () => {
    expect(HELP_TOPICS.flowThreshold.default).toBe(String(DEFAULT_POSTPROCESS_OPTIONS.flowThreshold));
    expect(HELP_TOPICS.cellprobThreshold.default).toBe(String(DEFAULT_POSTPROCESS_OPTIONS.cellprobThreshold));
    expect(HELP_TOPICS.minSize.default).toContain(String(DEFAULT_POSTPROCESS_OPTIONS.minSize));
    expect(HELP_TOPICS.maxGrainAreaFraction.default).toContain(DEFAULT_POSTPROCESS_OPTIONS.maxGrainAreaFraction.toFixed(2));
    expect(HELP_TOPICS.niter.default).toBe(String(DEFAULT_POSTPROCESS_OPTIONS.niter));
    expect(HELP_TOPICS.minSeedDensity.default).toBe(String(DEFAULT_POSTPROCESS_OPTIONS.minSeedDensity));
    expect(HELP_TOPICS.excludeBorderMargin.default).toContain(String(DEFAULT_POSTPROCESS_OPTIONS.excludeBorderMargin));
  });

  it('help button is accessible and escapes its tooltip', () => {
    const html = helpButton('flowThreshold');
    expect(html).toContain('data-help="flowThreshold"');
    expect(html).toContain('aria-label="Help: Flow threshold"');
    expect(html).toMatch(/^<button type="button"/);
    const quoted = helpButton('maxGrainAreaFraction'); // its text contains "grain" in quotes
    expect(quoted).toContain('&quot;grain&quot;');
    expect(quoted).not.toContain('"grain"');
  });

  it('help dialog opens on the chosen topic and still lists all others', () => {
    const html = renderHelpModalHtml('maxGrainAreaFraction');
    expect(html).toContain('Help: Max area fraction');
    expect(html.indexOf('id="help-maxGrainAreaFraction" open')).toBeGreaterThan(0);
    expect(html.match(/class="help-topic"/g)!.length).toBe(Object.keys(HELP_TOPICS).length);
    expect(renderHelpModalHtml(null)).toContain('Settings help');
  });
});

describe('newly configurable analysis settings', () => {
  it('defaults equal the tested engine configuration and are passed to the engine', () => {
    const p = defaultAnalysisParams();
    expect(p.excludeBorder).toBe(true);
    expect(p.excludeBorderMargin).toBe(DEFAULT_POSTPROCESS_OPTIONS.excludeBorderMargin);
    expect(p.niter).toBe(DEFAULT_POSTPROCESS_OPTIONS.niter);
    expect(p.minSeedDensity).toBe(DEFAULT_POSTPROCESS_OPTIONS.minSeedDensity);
    const cfg = toAnalysisConfig({ ...p, excludeBorderMargin: 7, niter: 400, minSeedDensity: 4 });
    expect(cfg.postProcess).toMatchObject({ excludeBorderMargin: 7, niter: 400, minSeedDensity: 4 });
  });
});
