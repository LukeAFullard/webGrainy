import { describe, expect, it } from 'vitest';
import { guideSteps, renderGuideHtml } from '../src/ui/onboarding.js';

const base = { photoCount: 0, calibratedCount: 0, exclusionCount: 0, analysedCount: 0, exported: false, isMobile: false, batchRunning: false };

describe('getting-started guide', () => {
  it('starts with adding photos', () => {
    const html = renderGuideHtml(guideSteps(base));
    expect(html).toContain('0 of 5');
    expect(html).toMatch(/class="guide-step  next"[\s\S]*Add gravel photos/);
    expect(html).toContain('data-action="add-photos"');
  });
  it('points to Analyse next once photos exist (scale and exclusions are optional)', () => {
    const steps = guideSteps({ ...base, photoCount: 2 });
    const html = renderGuideHtml(steps);
    expect(html).toContain('data-action="run-batch"');
    expect(html).not.toContain('data-action="add-photos"');
  });
  it('then to export, and ticks optional steps when done', () => {
    const steps = guideSteps({ ...base, photoCount: 2, analysedCount: 2, calibratedCount: 1 });
    expect(steps.find((s) => s.id === 'scale')?.done).toBe(true);
    expect(renderGuideHtml(steps)).toContain('data-open-modal="export"');
  });
  it('mentions U-Net on phones', () => {
    expect(guideSteps({ ...base, isMobile: true, photoCount: 1 }).find((s) => s.id === 'analyse')?.text).toMatch(/U-Net/);
  });
});
