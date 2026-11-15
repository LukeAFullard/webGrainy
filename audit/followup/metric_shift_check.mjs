/**
 * Compares D16 / D50 / D84 across `bAxis`, `minFeret`, and `dEq` on synthetic
 * grain shapes and a realistic multi-grain gravel mixture, using the built
 * webGrainy engine (`dist/` or `src/` via vitest/esbuild).
 *
 * Usage:
 *   node audit/followup/metric_shift_check.mjs
 */
import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'wg-metric-shift-'));
try {
  const outfile = join(tmp, 'engine.mjs');
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  const wg = await import(pathToFileURL(outfile).href);

  const W = 400;
  const H = 400;

  function makeSingleShape(name, fillFn) {
    const masks = new Int32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (fillFn(x, y)) masks[y * W + x] = 1;
      }
    }
    const grains = wg.computeAllGrainMorphometrics(masks, W, H, 2);
    const ext = wg.computeExtendedMorphometrics(masks, grains, W, H, 1, 1.0)[0];
    return { name, g: grains[0], ext };
  }

  const shapes = [
    makeSingleShape('circle_r30', (x, y) => (x - 200) ** 2 + (y - 200) ** 2 <= 30 ** 2),
    makeSingleShape('ellipse_60x20', (x, y) => ((x - 200) / 60) ** 2 + ((y - 200) / 20) ** 2 <= 1),
    makeSingleShape('rect_80x20', (x, y) => x >= 160 && x < 240 && y >= 190 && y < 210),
    makeSingleShape('rot_rect_45deg', (x, y) => {
      const dx = x - 200;
      const dy = y - 200;
      const u = (dx + dy) / Math.SQRT2;
      const v = (-dx + dy) / Math.SQRT2;
      return Math.abs(u) <= 40 && Math.abs(v) <= 10;
    }),
    makeSingleShape('L_shape_concave', (x, y) => {
      const inVert = x >= 160 && x < 185 && y >= 150 && y < 250;
      const inHoriz = x >= 160 && x < 240 && y >= 225 && y < 250;
      return inVert || inHoriz;
    }),
  ];

  console.log('=== Per-Shape Comparison (1 px = 1 mm) ===');
  console.log(
    'shape               | minFeret |   bAxis  |    dEq   | b/minF | dEq/minF',
  );
  for (const s of shapes) {
    const mf = s.ext.minFeretPx;
    const b = s.g.bAxisPx;
    const d = s.g.dEqPx;
    console.log(
      `${s.name.padEnd(19)} | ${mf.toFixed(2).padStart(8)} | ${b.toFixed(2).padStart(8)} | ${d.toFixed(2).padStart(8)} | ${(b / mf).toFixed(3).padStart(6)} | ${(d / mf).toFixed(3).padStart(8)}`,
    );
  }

  // Multi-grain mixture: 24 elongated ellipses (aspect 2:1 to 3:1) across 2 photos
  function makeMixtureSession(seedOffset, mmPerPx) {
    const MW = 600;
    const MH = 600;
    const masks = new Int32Array(MW * MH);
    let id = 1;
    const cols = 4;
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = 75 + c * 150;
        const cy = 90 + r * 180;
        const b = 14 + ((id + seedOffset) % 5) * 4;
        const a = Math.round(b * (1.8 + ((id + seedOffset) % 3) * 0.5));
        const theta = ((id * 37) % 180) * (Math.PI / 180);
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        for (let y = Math.max(0, cy - a - 2); y <= Math.min(MH - 1, cy + a + 2); y++) {
          for (let x = Math.max(0, cx - a - 2); x <= Math.min(MW - 1, cx + a + 2); x++) {
            const dx = x - cx;
            const dy = y - cy;
            const u = dx * cos + dy * sin;
            const v = -dx * sin + dy * cos;
            if ((u / a) ** 2 + (v / b) ** 2 <= 1) {
              masks[y * MW + x] = id;
            }
          }
        }
        id++;
      }
    }
    const workingGrains = wg.computeAllGrainMorphometrics(masks, MW, MH, 2);
    return new wg.AnalysisSession({
      workingImage: {
        data: new Uint8ClampedArray(MW * MH * 4),
        width: MW,
        height: MH,
        originalWidth: MW,
        originalHeight: MH,
        effectiveScaleFactor: 1,
        scaleModeApplied: '1.0x',
      },
      recommendation: {
        model: 'unet',
        confidence: 0.9,
        rationale: 'metric-shift-check',
        metrics: {
          sobelEntropy: 1,
          multiScaleContrastVar: 1,
          shadowGlareRange: 1,
          hasWebGPU: false,
          deviceMemoryGB: 8,
          elapsedMs: 1,
        },
      },
      masks,
      workingGrains,
      calibration: {
        mmPerPx,
        pointA: { x: 0, y: 0 },
        pointB: { x: 100, y: 0 },
        physicalLengthMm: 100 * mmPerPx,
        pixelDistance: 100,
      },
      excludeBorder: true,
      borderMargin: 2,
    });
  }

  const photos = [
    { photoId: 'mix-1', label: 'Mix 1', included: true, session: makeMixtureSession(0, 0.5) },
    { photoId: 'mix-2', label: 'Mix 2', included: true, session: makeMixtureSession(2, 0.5) },
  ];

  console.log('\n=== Site-Level PSD Shift (24-grain elongated gravel mixture, physical-area, mm) ===');
  const results = {};
  for (const metric of ['minFeret', 'bAxis', 'dEq']) {
    const rep = wg.analyzeSite(photos, {
      poolingMode: 'physical-area',
      sizeMetric: metric,
      minBaxisPx: 15,
      bootstrapReplicates: 100,
    });
    results[metric] = rep.psd;
    console.log(
      `${metric.padEnd(9)} | D16=${rep.psd.D16.toFixed(2)} | D50=${rep.psd.D50.toFixed(2)} | D84=${rep.psd.D84.toFixed(2)} | n=${rep.validGrainCount}`,
    );
  }
  const fD50 = results.minFeret.D50;
  console.log(
    `D50 shift vs minFeret: bAxis=${(((results.bAxis.D50 - fD50) / fD50) * 100).toFixed(2)}%, dEq=${(((results.dEq.D50 - fD50) / fD50) * 100).toFixed(2)}%`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
