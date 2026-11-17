import { describe, expect, it } from 'vitest';
import {
  AnalysisSession,
  analyzeSite,
  computeAllGrainMorphometrics,
  computeSedimentStats,
  exportPooledGrainsCsv,
  exportSiteSummaryCsv,
  exportSiteSummaryJson,
  validateSiteCalibration,
  withExclusionTolerance,
  type CalibrationResult,
  type ModelRecommendation,
  type SitePhotoInput,
  type WorkingImageResult,
} from '../src/index.js';

function makeDummyRecommendation(): ModelRecommendation {
  return {
    model: 'unet',
    confidence: 0.9,
    rationale: 'test',
    metrics: {
      sobelEntropy: 1,
      multiScaleContrastVar: 1,
      shadowGlareRange: 1,
      hasWebGPU: false,
      deviceMemoryGB: 8,
      elapsedMs: 1,
    },
  };
}

function makeCalibration(mmPerPx: number): CalibrationResult {
  return {
    mmPerPx,
    pointA: { x: 0, y: 0 },
    pointB: { x: 100, y: 0 },
    physicalLengthMm: 100 * mmPerPx,
    pixelDistance: 100,
  };
}

function makeSyntheticSession(params: {
  width: number;
  height: number;
  circles: ReadonlyArray<{ cx: number; cy: number; r: number }>;
  mmPerPx?: number;
  excludeBorder?: boolean;
}): AnalysisSession {
  const { width, height, circles, mmPerPx, excludeBorder = true } = params;
  const masks = new Int32Array(width * height);
  let id = 1;
  for (const c of circles) {
    const rSq = c.r * c.r;
    const x0 = Math.max(0, Math.floor(c.cx - c.r));
    const x1 = Math.min(width - 1, Math.ceil(c.cx + c.r));
    const y0 = Math.max(0, Math.floor(c.cy - c.r));
    const y1 = Math.min(height - 1, Math.ceil(c.cy + c.r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - c.cx;
        const dy = y - c.cy;
        if (dx * dx + dy * dy <= rSq) {
          masks[y * width + x] = id;
        }
      }
    }
    id++;
  }

  const workingImage: WorkingImageResult = {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
    originalWidth: width,
    originalHeight: height,
    effectiveScaleFactor: 1,
    scaleModeApplied: '1.0x',
  };

  const workingGrains = computeAllGrainMorphometrics(masks, width, height, 2);
  return new AnalysisSession({
    workingImage,
    recommendation: makeDummyRecommendation(),
    masks,
    workingGrains,
    calibration: mmPerPx !== undefined ? makeCalibration(mmPerPx) : undefined,
    excludeBorder,
    borderMargin: 2,
  });
}

function makeGridCircles(
  radii: readonly number[],
  cols = 5,
  spacing = 60,
  offset = 40,
): Array<{ cx: number; cy: number; r: number }> {
  return radii.map((r, idx) => ({
    cx: offset + (idx % cols) * spacing,
    cy: offset + Math.floor(idx / cols) * spacing,
    r,
  }));
}

describe('siteAnalysis', () => {
  it('validates mixed calibration and blocks physical mm pooling unless px fallback is chosen', () => {
    const s1 = makeSyntheticSession({
      width: 240,
      height: 240,
      circles: makeGridCircles([12, 14, 16]),
      mmPerPx: 0.5,
    });
    const s2 = makeSyntheticSession({
      width: 240,
      height: 240,
      circles: makeGridCircles([12, 14, 16]),
    });

    const photos: SitePhotoInput[] = [
      { photoId: 'p1', label: 'Photo 1', included: true, session: s1 },
      { photoId: 'p2', label: 'Photo 2', included: true, session: s2 },
    ];

    const blocked = validateSiteCalibration(photos, { poolingMode: 'physical-area' });
    expect(blocked.valid).toBe(false);
    expect(blocked.unit).toBe('mixed');
    expect(blocked.uncalibratedPhotoIds).toEqual(['p2']);
    expect(() =>
      analyzeSite(photos, { poolingMode: 'physical-area', bootstrapReplicates: 20 }),
    ).toThrow(/Mixed calibration/i);

    const allowedPx = validateSiteCalibration(photos, {
      poolingMode: 'equal-photo',
      unit: 'px',
    });
    expect(allowedPx.valid).toBe(true);
    expect(allowedPx.unit).toBe('px');
    expect(allowedPx.warnings.length).toBeGreaterThan(0);

    const allowedFallback = validateSiteCalibration(photos, {
      poolingMode: 'equal-photo',
      allowEqualPhotoFallback: true,
    });
    expect(allowedFallback.valid).toBe(true);
    expect(allowedFallback.unit).toBe('px');
  });

  it('achieves physical-area pooling parity with concatenated grains and distinguishes equal-photo, facies-weighted, and number-weighted modes', () => {
    const c1 = makeGridCircles([10, 12, 14, 16], 2, 70, 50);
    const c2 = makeGridCircles([18, 20, 22, 24], 2, 70, 50);
    const s1 = makeSyntheticSession({ width: 220, height: 220, circles: c1, mmPerPx: 0.5 });
    const s2 = makeSyntheticSession({ width: 220, height: 220, circles: c2, mmPerPx: 0.5 });

    const photos: SitePhotoInput[] = [
      { photoId: 'p1', label: 'Fine', included: true, session: s1, faciesWeight: 3 },
      { photoId: 'p2', label: 'Coarse', included: true, session: s2, faciesWeight: 1 },
    ];

    const physReport = analyzeSite(photos, {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });
    const concatGrains = [...s1.getResult().grains, ...s2.getResult().grains];
    const singleReport = computeSedimentStats(concatGrains, { excludeBorder: true });

    expect(physReport.psd.D50).toBeCloseTo(singleReport.areaWeightedB.D50, 6);
    expect(physReport.psd.D84).toBeCloseTo(singleReport.areaWeightedB.D84, 6);
    expect(physReport.statisticalBasisLabel).toContain('Kellerhals & Bray 1971');

    const eqReport = analyzeSite(photos, {
      poolingMode: 'equal-photo',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });
    expect(eqReport.perPhoto[0]?.weightContributionPct).toBeCloseTo(50, 6);
    expect(eqReport.perPhoto[1]?.weightContributionPct).toBeCloseTo(50, 6);

    const faciesReport = analyzeSite(photos, {
      poolingMode: 'facies-weighted',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });
    expect(faciesReport.perPhoto[0]?.weightContributionPct).toBeCloseTo(75, 6);
    expect(faciesReport.perPhoto[1]?.weightContributionPct).toBeCloseTo(25, 6);
    expect(faciesReport.psd.D50).toBeLessThan(eqReport.psd.D50);

    const numReport = analyzeSite(photos, {
      poolingMode: 'number-weighted',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });
    expect(numReport.statisticalBasisLabel).toContain('NOT Sieve-Equivalent');
    expect(numReport.binomialCi.isKishApproximation).toBe(false);
  });

  it('virtual-wolman-grid tracks matrix hits and converges toward physical-area as grid spacing decreases', () => {
    const circles = makeGridCircles([10, 14, 18, 22], 2, 80, 55);
    const s1 = makeSyntheticSession({ width: 240, height: 240, circles, mmPerPx: 1.0 });
    const s2 = makeSyntheticSession({ width: 240, height: 240, circles, mmPerPx: 1.0 });

    const photos: SitePhotoInput[] = [
      { photoId: 'p1', label: 'P1', included: true, session: s1 },
      { photoId: 'p2', label: 'P2', included: true, session: s2 },
    ];

    const areaReport = analyzeSite(photos, {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 30,
    });

    const wolmanFine = analyzeSite(photos, {
      poolingMode: 'virtual-wolman-grid',
      wolmanGridSpacingMm: 2,
      minBaxisPx: 0,
      bootstrapReplicates: 30,
    });

    expect(wolmanFine.gridMatrixHitsTotal).toBeGreaterThan(0);
    expect(wolmanFine.binomialCi.isKishApproximation).toBe(false);
    expect(Math.abs(wolmanFine.psd.D50 - areaReport.psd.D50)).toBeLessThan(2.0);
  });

  it('harmonizes common physical truncation cutoff across photos with differing mmPerPx', () => {
    // Photo 1: close-up 0.25 mm/px -> 15 px = 3.75 mm; contains 20 px (5 mm) & 40 px (10 mm)
    const s1 = makeSyntheticSession({
      width: 240,
      height: 240,
      circles: makeGridCircles([10, 20], 2, 100, 60),
      mmPerPx: 0.25,
    });
    // Photo 2: wide shot 1.0 mm/px -> 15 px = 15 mm; contains 20 px (40 mm) & 25 px (50 mm)
    const s2 = makeSyntheticSession({
      width: 240,
      height: 240,
      circles: makeGridCircles([20, 25], 2, 100, 60),
      mmPerPx: 1.0,
    });

    const photos: SitePhotoInput[] = [
      { photoId: 'close', label: 'Close', included: true, session: s1 },
      { photoId: 'wide', label: 'Wide', included: true, session: s2 },
    ];

    const report = analyzeSite(photos, {
      poolingMode: 'physical-area',
      minBaxisPx: 15,
      harmonizeCutoff: true,
      bootstrapReplicates: 30,
    });

    expect(report.dCutoffCommonMm).toBeCloseTo(15, 6);
    expect(report.excludedTruncationCount).toBe(2);
    expect(report.excludedTruncationAreaMm2).toBeGreaterThan(0);
    expect(report.validGrainCount).toBe(2);
  });

  it('exclusion overlap tolerance (maxExcludedFraction) decides whether a partly excluded grain is kept', () => {
    // Two r=20 grains at (60,60) and (160,60), 1 mm/px. The exclusion covers x >= 172,
    // i.e. about 30% of the right-hand grain.
    const session = makeSyntheticSession({
      width: 240, height: 140, mmPerPx: 1,
      circles: [{ cx: 60, cy: 60, r: 20 }, { cx: 160, cy: 60, r: 20 }],
    });
    const roiConfig = { exclusionPolygons: [[{ x: 172, y: 0 }, { x: 239, y: 0 }, { x: 239, y: 139 }, { x: 172, y: 139 }]], exclusionStrokes: [] };
    const photos: SitePhotoInput[] = [{ photoId: 'p', label: 'P', included: true, session, roiConfig }];
    const opts = { poolingMode: 'physical-area' as const, minBaxisPx: 0, bootstrapReplicates: 20 };
    expect(analyzeSite(photos, { ...opts }).validGrainCount).toBe(1); // default 0.10
    expect(analyzeSite(photos, { ...opts, maxExcludedFraction: 0.1 }).validGrainCount).toBe(1);
    expect(analyzeSite(photos, { ...opts, maxExcludedFraction: 0.5 }).validGrainCount).toBe(2);
    expect(analyzeSite(photos, { ...opts, maxExcludedFraction: 0 }).validGrainCount).toBe(1);
    expect(withExclusionTolerance(roiConfig, 2)).toBe(roiConfig); // invalid values ignored
    expect(withExclusionTolerance(roiConfig, 0.3).maxExcludedFraction).toBe(0.3);
  });

  it('applies a field-count lower cutoff in mm (minSizeMm) and warns when uncalibrated', () => {
    // Radii 5..20 px at 1 mm/px: b-axes ~10..40 mm.
    const radii = [5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20];
    const session = makeSyntheticSession({ width: 400, height: 400, circles: makeGridCircles(radii, 4, 90, 50), mmPerPx: 1.0 });
    const photos: SitePhotoInput[] = [{ photoId: 'p', label: 'P', included: true, session }];
    const base = analyzeSite(photos, { poolingMode: 'physical-area', minBaxisPx: 0, bootstrapReplicates: 20 });
    const cut = analyzeSite(photos, { poolingMode: 'physical-area', minBaxisPx: 0, minSizeMm: 20, bootstrapReplicates: 20 });
    expect(cut.dCutoffCommonMm).toBe(20);
    expect(cut.validGrainCount).toBeLessThan(base.validGrainCount);
    expect(cut.excludedTruncationCount).toBe(base.validGrainCount - cut.validGrainCount);
    expect(cut.psd.D50).toBeGreaterThan(base.psd.D50);
    expect(cut.psd.D16).toBeGreaterThanOrEqual(20);

    const uncal = makeSyntheticSession({ width: 400, height: 400, circles: makeGridCircles(radii, 4, 90, 50) });
    const pxReport = analyzeSite([{ photoId: 'u', label: 'U', included: true, session: uncal }], {
      poolingMode: 'physical-area', unit: 'px', minBaxisPx: 0, minSizeMm: 20, bootstrapReplicates: 20,
    });
    expect(pxReport.warnings.join(' ')).toMatch(/cutoff of 20 mm ignored/);
  });

  it('produces bit-identical seeded bootstrap CIs, handles single-photo fallback, and contracts CI width as N grows', () => {
    const makePhoto = (id: string, radii: number[]): SitePhotoInput => ({
      photoId: id,
      label: id,
      included: true,
      session: makeSyntheticSession({
        width: 300,
        height: 300,
        circles: makeGridCircles(radii, 3, 80, 55),
        mmPerPx: 0.5,
      }),
    });

    const single = [makePhoto('p1', [10, 14, 18, 22, 26])];
    const singleReport = analyzeSite(single, {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 200,
      bootstrapSeed: 42,
    });
    expect(singleReport.bootstrapMode).toBe('single-photo-grain-fallback');
    expect(singleReport.warnings.some((w) => w.includes('Single-photo'))).toBe(true);

    const twoPhotos = [
      makePhoto('p1', [10, 12, 14]),
      makePhoto('p2', [22, 24, 26]),
    ];
    const rA = analyzeSite(twoPhotos, {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 300,
      bootstrapSeed: 42,
    });
    const rB = analyzeSite(twoPhotos, {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 300,
      bootstrapSeed: 42,
    });

    expect(rA.bootstrapCi.lower.D50).toBe(rB.bootstrapCi.lower.D50);
    expect(rA.bootstrapCi.upper.D50).toBe(rB.bootstrapCi.upper.D50);

    // Increasing N from 2 to 8 photos with similar spread contracts bootstrap CI width
    const eightPhotos = [
      makePhoto('p1', [10, 12, 14]),
      makePhoto('p2', [22, 24, 26]),
      makePhoto('p3', [10, 12, 14]),
      makePhoto('p4', [22, 24, 26]),
      makePhoto('p5', [10, 12, 14]),
      makePhoto('p6', [22, 24, 26]),
      makePhoto('p7', [10, 12, 14]),
      makePhoto('p8', [22, 24, 26]),
    ];
    const r8 = analyzeSite(eightPhotos, {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 300,
      bootstrapSeed: 42,
    });

    const width2 = rA.bootstrapCi.upper.D50 - rA.bootstrapCi.lower.D50;
    const width8 = r8.bootstrapCi.upper.D50 - r8.bootstrapCi.lower.D50;
    expect(width8).toBeLessThan(width2);
  });

  it('computes jackknife sensitivity, high-influence flags, binomial CIs, adequacy ratings, and exports', async () => {
    const p1: SitePhotoInput = {
      photoId: 'p1',
      label: 'Normal 1',
      included: true,
      session: makeSyntheticSession({
        width: 300,
        height: 300,
        circles: makeGridCircles([10, 12, 14, 15], 2, 100, 70),
        mmPerPx: 0.5,
      }),
    };
    const p2: SitePhotoInput = {
      photoId: 'p2',
      label: 'Normal 2',
      included: true,
      session: makeSyntheticSession({
        width: 300,
        height: 300,
        circles: makeGridCircles([11, 13, 14, 16], 2, 100, 70),
        mmPerPx: 0.5,
      }),
    };
    const p3: SitePhotoInput = {
      photoId: 'p3',
      label: 'Boulder Outlier',
      included: true,
      session: makeSyntheticSession({
        width: 400,
        height: 400,
        circles: [{ cx: 200, cy: 200, r: 120 }],
        mmPerPx: 0.5,
      }),
    };

    const report = analyzeSite([p1, p2, p3], {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 100,
    });

    expect(report.jackknife).not.toBeNull();
    const boulderJack = report.jackknife!.perPhoto.find((p) => p.photoId === 'p3');
    expect(boulderJack?.highInfluence).toBe(true);
    expect(report.adequacy.rating).toBe('Insufficient');
    expect(report.adequacy.largestClastWarning).toBe('critical');
    expect(report.convergence.length).toBe(3);

    expect(report.binomialCi.lower.D50).toBeLessThanOrEqual(report.psd.D50);
    expect(report.binomialCi.upper.D50).toBeGreaterThanOrEqual(report.psd.D50);

    const summaryCsv = await exportSiteSummaryCsv(report).text();
    expect(summaryCsv).toContain('Area-Weighted (Grid-by-Number / Sieve-Equivalent, Kellerhals & Bray 1971)');
    expect(summaryCsv).toContain('psd_bootstrap_ci_lo,D50');
    // Everything the dashboard shows is in the CSV too.
    for (const section of ['fabric,mean_axial_orientation_deg', 'fabric,rayleigh_p', 'size_class_1phi,', 'size_class_05phi,', 'adequacy,effective_grain_count', 'jackknife,se_D50', 'per_photo_detail,', 'metadata,confidence_level']) {
      expect(summaryCsv).toContain(section);
    }
    const firstPhoto = report.perPhoto[0]!;
    expect(summaryCsv).toContain(`per_photo_detail,${firstPhoto.label}|D50,${firstPhoto.D50}`);
    expect(summaryCsv).toMatch(/\nwarning,1,/);
    expect(report.extra).not.toBeNull();
    expect(summaryCsv).toContain('mean_diameters,sauter_mean_D32,');
    expect(summaryCsv).toContain('ratios,uniformity_Cu,');
    // Sauter mean lies between the smallest and largest grains, and above the arithmetic mean.
    expect(report.extra!.sauterMeanD32).toBeGreaterThan(report.extra!.arithmeticMeanD10);

    const summaryJson = JSON.parse(await exportSiteSummaryJson(report).text()) as {
      poolingMode: string;
      citations: string[];
    };
    expect(summaryJson.poolingMode).toBe('physical-area');
    expect(summaryJson.citations.length).toBeGreaterThan(5);

    const grainsCsv = await exportPooledGrainsCsv([p1, p2, p3], report).text();
    const lines = grainsCsv.trim().split('\n');
    expect(lines[0]).toContain('photo_id,photo_name,mm_per_px');
    expect(lines[0]).toContain('sphericity_2d');
    expect(lines.length).toBe(10); // 1 header + 4 + 4 + 1 grains
  });

  it('keeps computeSiteWentworth aligned when faciesWeight is 0 on an earlier photo', () => {
    const gravelPhoto: SitePhotoInput = {
      photoId: 'gravel',
      label: 'Gravel (excluded by faciesWeight 0)',
      included: true,
      faciesWeight: 0,
      session: makeSyntheticSession({
        width: 200,
        height: 200,
        circles: [{ cx: 100, cy: 100, r: 20 }], // bAxis ~ 40 px * 0.5 = 20 mm (gravel)
        mmPerPx: 0.5,
      }),
    };
    const cobblePhoto: SitePhotoInput = {
      photoId: 'cobble',
      label: 'Cobble (faciesWeight 1)',
      included: true,
      faciesWeight: 1,
      session: makeSyntheticSession({
        width: 240,
        height: 240,
        circles: [{ cx: 120, cy: 120, r: 40 }], // bAxis ~ 80 px * 1.0 = 80 mm (cobble)
        mmPerPx: 1.0,
      }),
    };

    const report = analyzeSite([gravelPhoto, cobblePhoto], {
      poolingMode: 'facies-weighted',
      minBaxisPx: 0,
      bootstrapReplicates: 20,
    });

    expect(report.wentworth).not.toBeNull();
    expect(report.wentworth!.cobblePct).toBe(100);
    expect(report.wentworth!.gravelPct).toBe(0);
    expect(report.psd.D50).toBeGreaterThanOrEqual(64);
  });

  it('matches wentworthHistogram10Phi proportions to report.wentworth across differing mmPerPx under physical-area and equal-photo modes', () => {
    const closeUp: SitePhotoInput = {
      photoId: 'close',
      label: 'Close-up 0.25 mm/px',
      included: true,
      session: makeSyntheticSession({
        width: 240,
        height: 240,
        circles: [{ cx: 120, cy: 120, r: 40 }], // 80 px * 0.25 = 20 mm (gravel)
        mmPerPx: 0.25,
      }),
    };
    const wideShot: SitePhotoInput = {
      photoId: 'wide',
      label: 'Wide 1.0 mm/px',
      included: true,
      session: makeSyntheticSession({
        width: 240,
        height: 240,
        circles: [{ cx: 120, cy: 120, r: 40 }], // 80 px * 1.0 = 80 mm (cobble)
        mmPerPx: 1.0,
      }),
    };

    const sumClassPct = (
      bins: ReadonlyArray<{ wentworthClass: string; weightPct: number }>,
      substr: string,
    ): number =>
      bins
        .filter((b) => b.wentworthClass.includes(substr))
        .reduce((acc, b) => acc + b.weightPct, 0);

    const phys = analyzeSite([closeUp, wideShot], {
      poolingMode: 'physical-area',
      minBaxisPx: 0,
      bootstrapReplicates: 20,
    });
    expect(phys.wentworth).not.toBeNull();
    // Wide shot has 16x physical area for the same pixel radius
    expect(phys.wentworth!.cobblePct).toBeGreaterThan(90);
    expect(sumClassPct(phys.wentworthHistogram10Phi, 'Gravel')).toBeCloseTo(
      phys.wentworth!.gravelPct,
      6,
    );
    expect(sumClassPct(phys.wentworthHistogram10Phi, 'Cobble')).toBeCloseTo(
      phys.wentworth!.cobblePct,
      6,
    );

    const eq = analyzeSite([closeUp, wideShot], {
      poolingMode: 'equal-photo',
      minBaxisPx: 0,
      bootstrapReplicates: 20,
    });
    expect(eq.wentworth).not.toBeNull();
    expect(eq.wentworth!.gravelPct).toBeCloseTo(50, 6);
    expect(eq.wentworth!.cobblePct).toBeCloseTo(50, 6);
    expect(sumClassPct(eq.wentworthHistogram10Phi, 'Gravel')).toBeCloseTo(
      eq.wentworth!.gravelPct,
      6,
    );
    expect(sumClassPct(eq.wentworthHistogram10Phi, 'Cobble')).toBeCloseTo(
      eq.wentworth!.cobblePct,
      6,
    );
  });

  it('samples ~K points inside a small ROI polygon in virtual-wolman-grid Mode B', () => {
    const session = makeSyntheticSession({
      width: 400,
      height: 400,
      circles: [{ cx: 50, cy: 50, r: 20 }],
      mmPerPx: 1.0,
    });

    const photo: SitePhotoInput = {
      photoId: 'roi-photo',
      label: 'Small ROI',
      included: true,
      session,
      roiConfig: {
        roiPolygon: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
        exclusionPolygons: [],
        exclusionStrokes: [],
      },
    };

    const report = analyzeSite([photo], {
      poolingMode: 'virtual-wolman-grid',
      wolmanPointsPerPhoto: 100,
      minBaxisPx: 0,
      bootstrapReplicates: 20,
    });

    const totalHits =
      (report.perPhoto[0]?.gridGrainHits ?? 0) +
      (report.perPhoto[0]?.gridMatrixHits ?? 0);
    expect(totalHits).toBeGreaterThanOrEqual(90);
    expect(totalHits).toBeLessThanOrEqual(121);
    expect(report.perPhoto[0]?.gridGrainHits).toBeGreaterThan(0);
  });
});

describe('minFeret size metric', () => {
  function makeRectSession(params: {
    width: number;
    height: number;
    rects: ReadonlyArray<{ x0: number; y0: number; w: number; h: number }>;
    mmPerPx?: number;
    effectiveScaleFactor?: number;
  }): AnalysisSession {
    const { width, height, rects, mmPerPx, effectiveScaleFactor = 1 } = params;
    const masks = new Int32Array(width * height);
    let id = 1;
    for (const r of rects) {
      for (let y = r.y0; y < r.y0 + r.h; y++) {
        for (let x = r.x0; x < r.x0 + r.w; x++) {
          masks[y * width + x] = id;
        }
      }
      id++;
    }
    const workingImage: WorkingImageResult = {
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
      originalWidth: Math.round(width / effectiveScaleFactor),
      originalHeight: Math.round(height / effectiveScaleFactor),
      effectiveScaleFactor,
      scaleModeApplied: effectiveScaleFactor === 1 ? '1.0x' : '0.5x',
    };
    const workingGrains = computeAllGrainMorphometrics(masks, width, height, 2);
    return new AnalysisSession({
      workingImage,
      recommendation: makeDummyRecommendation(),
      masks,
      workingGrains,
      calibration: mmPerPx !== undefined ? makeCalibration(mmPerPx) : undefined,
      excludeBorder: true,
      borderMargin: 2,
    });
  }

  it('computes PSD, Folk & Ward, Wentworth, CIs, and exports using minFeret', async () => {
    // 20x80 rectangles: minFeret = 20px (10mm at 0.5mm/px), bAxis ≈ 23.09px (11.55mm), dEq ≈ 45.14px (22.57mm)
    const s1 = makeRectSession({
      width: 240,
      height: 200,
      rects: [
        { x0: 20, y0: 20, w: 80, h: 20 },
        { x0: 20, y0: 60, w: 80, h: 20 },
        { x0: 120, y0: 20, w: 80, h: 20 },
      ],
      mmPerPx: 0.5,
    });
    const s2 = makeRectSession({
      width: 240,
      height: 200,
      rects: [
        { x0: 20, y0: 20, w: 80, h: 20 },
        { x0: 20, y0: 60, w: 80, h: 20 },
      ],
      mmPerPx: 0.5,
    });

    const photos: SitePhotoInput[] = [
      { photoId: 'p1', label: 'P1', included: true, session: s1 },
      { photoId: 'p2', label: 'P2', included: true, session: s2 },
    ];

    const repFeret = analyzeSite(photos, {
      poolingMode: 'physical-area',
      sizeMetric: 'minFeret',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });
    const repBAxis = analyzeSite(photos, {
      poolingMode: 'physical-area',
      sizeMetric: 'bAxis',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });
    const repDEq = analyzeSite(photos, {
      poolingMode: 'physical-area',
      sizeMetric: 'dEq',
      minBaxisPx: 0,
      bootstrapReplicates: 50,
    });

    expect(repFeret.sizeMetric).toBe('minFeret');
    expect(repFeret.psd.D50).toBeCloseTo(10.0, 4);
    expect(repBAxis.psd.D50).toBeGreaterThan(11.0);
    expect(repDEq.psd.D50).toBeGreaterThan(22.0);

    // Folk & Ward, Wentworth, CIs, and perPhoto reflect minFeret
    expect(repFeret.folkWard).not.toBeNull();
    expect(repFeret.folkWard!.meanMm).toBeCloseTo(10.0, 2);
    expect(repFeret.wentworth!.gravelPct).toBeCloseTo(100, 4);
    expect(repFeret.wentworthHistogram10Phi.reduce((s, b) => s + b.weightPct, 0)).toBeCloseTo(100, 4);
    expect(repFeret.bootstrapCi.lower.D50).toBeCloseTo(10.0, 4);
    expect(repFeret.binomialCi.lower.D50).toBeCloseTo(10.0, 4);
    expect(repFeret.perPhoto[0]?.D50).toBeCloseTo(10.0, 4);

    // Exports include sizeMetric: 'minFeret' and updated sizeMetricDefinition
    const summaryCsv = await exportSiteSummaryCsv(repFeret).text();
    expect(summaryCsv).toContain('metadata,size_metric,minFeret,metric');
    const summaryJson = JSON.parse(await exportSiteSummaryJson(repFeret).text()) as {
      sizeMetric: string;
      metadata: { sizeMetricDefinition: string };
    };
    expect(summaryJson.sizeMetric).toBe('minFeret');
    expect(summaryJson.metadata.sizeMetricDefinition).toContain('min_feret');
  });

  it('applies truncation cutoff to minFeret when sizeMetric is minFeret', () => {
    // 20x80 rectangle: minFeretPx = 20, bAxisPx ≈ 23.09
    const s = makeRectSession({
      width: 150,
      height: 100,
      rects: [{ x0: 20, y0: 20, w: 80, h: 20 }],
      mmPerPx: 1.0,
    });
    const photos: SitePhotoInput[] = [
      { photoId: 'p1', label: 'P1', included: true, session: s },
    ];

    const repB = analyzeSite(photos, {
      poolingMode: 'physical-area',
      sizeMetric: 'bAxis',
      minBaxisPx: 22,
      bootstrapReplicates: 10,
    });
    expect(repB.validGrainCount).toBe(1);
    expect(repB.excludedTruncationCount).toBe(0);

    const repF = analyzeSite(photos, {
      poolingMode: 'physical-area',
      sizeMetric: 'minFeret',
      minBaxisPx: 22,
      bootstrapReplicates: 10,
    });
    expect(repF.validGrainCount).toBe(0);
    expect(repF.excludedTruncationCount).toBe(1);
  });

  it('rescales minFeretPx across effectiveScaleFactor and invalidates hull cache on mask edits', () => {
    // Working 20x80 rect with effectiveScaleFactor = 0.5 => original 40x160 rect => minFeretPx = 40
    const s = makeRectSession({
      width: 150,
      height: 100,
      rects: [{ x0: 20, y0: 20, w: 80, h: 20 }],
      mmPerPx: 0.25,
      effectiveScaleFactor: 0.5,
    });

    s.ensureFeret();
    expect(s.getHullCache().size).toBe(1);
    const g0 = s.getResult().grains[0]!;
    expect(g0.minFeretPx).toBeCloseTo(40, 4);
    expect(g0.minFeretMm).toBeCloseTo(10, 4);

    // Session CSV and GeoJSON include minFeret columns
    const csv = s.exportCsv();
    expect(csv.split('\n')[0]).toContain('min_feret_px,max_feret_px,min_feret_mm,max_feret_mm');
    const gj = JSON.parse(s.exportGeoJson()) as { features: Array<{ properties: Record<string, unknown> }> };
    expect(gj.features[0]?.properties['minFeretPx']).toBeCloseTo(40, 4);

    // Splitting the grain in original-image coordinates invalidates hullCache for that grain
    const splitOk = s.splitGrain(g0.id, [{ x: 120, y: 30 }, { x: 120, y: 90 }]);
    expect(splitOk).toBe(true);
    expect(s.getHullCache().has(g0.id)).toBe(false);
    s.ensureFeret();
    const splitGrains = s.getResult().grains;
    expect(splitGrains).toHaveLength(2);
    expect(splitGrains[0]?.minFeretPx).toBeCloseTo(40, 2);

    // Undo clears hullCache and restores original grain
    expect(s.undo()).toBe(true);
    expect(s.getHullCache().size).toBe(0);
    expect(s.getResult().grains).toHaveLength(1);
  });
});



