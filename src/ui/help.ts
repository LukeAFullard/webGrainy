// In-app, plain-language help for every user-facing setting and tool.
// Mirrors docs/SETTINGS_GUIDE.md; keep the two in sync.

export interface HelpTopic {
  /** Setting name as shown in the UI. */
  title: string;
  /** Group heading in the "Settings help" dialog. */
  group: HelpGroup;
  /** What the setting does, in one or two plain sentences. */
  what: string;
  /** Default value, as shown to the user. */
  default: string;
  /** When it is reasonable to change it, and in which direction. */
  when: string;
}

export type HelpGroup =
  | 'Analysis'
  | 'Advanced analysis'
  | 'Site statistics'
  | 'Photo'
  | 'Tools';

export const HELP_GROUP_ORDER: readonly HelpGroup[] = [
  'Analysis',
  'Advanced analysis',
  'Site statistics',
  'Photo',
  'Tools',
];

export const HELP_TOPICS = {
  model: {
    title: 'Model',
    group: 'Analysis',
    what: 'Which neural network finds the grains. CP-SAM is more accurate but a larger download (180–617 MB, see "CP-SAM weights") and needs a modern graphics card for good speed. U-Net is small (26 MB) and fast and works almost anywhere, but is less accurate. Auto picks one for you based on the photo and your hardware. On phones and tablets Auto always picks U-Net.',
    default: 'Auto',
    when: 'Use CP-SAM for results you will report or publish (median D50 error about 3% in testing, vs about 6% for U-Net). Use U-Net for a quick look or on a phone. Use the same model for all photos you compare.',
  },
  cpsamWeights: {
    title: 'CP-SAM weights',
    group: 'Analysis',
    what: 'Which copy of the Cellpose-SAM network to download and run. FP16 is the original (617 MB). INT8 (316 MB) and FP4 (183 MB) store the same network in compressed form. All three gave the same accuracy on the 40-photo benchmark (outline score 0.652–0.653, median D50 error 2.8–2.9%). Only used when the model is CP-SAM.',
    default: 'Auto: FP16 on a graphics card (WebGPU with float16), otherwise INT8 (always INT8 on phones and tablets)',
    when: 'On a computer without a suitable graphics card, INT8 needs about half the memory of FP16 (about 2 GB vs 3.8 GB), loads much faster, and is as fast or faster (up to about 2× in the benchmark, depending on the computer). Choose FP4 for the smallest download on a slow or metered connection (it needs about as much memory as FP16 while running). On a graphics card, FP16 has been checked against the CPU on one integrated Intel GPU so far (other makers not yet; the GPU check page can test yours); INT8 and FP4 have not, so the app always runs them on the CPU (the GPU check page can test them on your graphics card). Keep the same choice for all photos you compare, and note it when reporting results (it is recorded in the export).',
  },
  scaleMode: {
    title: 'Scale mode',
    group: 'Analysis',
    what: 'The resolution the model works at. Results are always converted back to the original photo pixels and to mm.',
    default: 'Auto (longest side shrunk to at most 1024 px)',
    when: 'Choose "1.0x Full" for large photos with many small grains (slower, more memory). Choose 0.5x or 0.25x for close-up photos of big cobbles or boulders. Shrinking the photo raises the smallest grain that can be detected.',
  },
  flowThreshold: {
    title: 'Flow threshold',
    group: 'Analysis',
    what: 'A quality check on each candidate grain. Higher values accept more (including doubtful) outlines; lower values keep only clean, convincing ones.',
    default: '0.45',
    when: 'Raise it (e.g. 0.6) if obvious grains are missing. Lower it (e.g. 0.3) if you see many ragged or nonsensical outlines. Change in small steps and check the outlines.',
  },
  cellprobThreshold: {
    title: 'Cellprob threshold',
    group: 'Analysis',
    what: 'How sure the model must be that a pixel is part of a grain. Lower values make outlines larger and include fainter stones; higher values are stricter.',
    default: '0',
    when: 'Lower it (e.g. −1) if outlines are too small or dark stones are missed. Raise it (e.g. +1) if outlines bleed into sand or shadow between grains.',
  },
  minSize: {
    title: 'Min size (px²)',
    group: 'Analysis',
    what: 'Objects smaller than this area (in working-resolution pixels) are discarded. It sets the smallest grain the app can report.',
    default: '30 px² (about 6 px across)',
    when: 'Lower it (e.g. 15) for sharp close-up photos where fine grains matter. Raise it if noisy photos produce many tiny false grains. Fine grains near this limit are always under-counted.',
  },
  maxGrainAreaFraction: {
    title: 'Max area fraction',
    group: 'Analysis',
    what: 'A safety limit: no single grain may cover more than this fraction of the photo. It stops a sand patch, water or a big shadow being treated as one giant "grain".',
    default: '0.40 (40% of the photo)',
    when: 'Raise to 1.0 if one real boulder covers more than 40% of the photo and is being left out. Lower it (e.g. 0.15) if huge false grains appear over sand or water; this also drops any real stones above that size.',
  },
  applyClahe: {
    title: 'Apply CLAHE',
    group: 'Analysis',
    what: 'Boosts local contrast before analysis.',
    default: 'Off',
    when: 'Leave it off. In the pre-processing benchmark (40 test photos, validation/preprocessing) it lowered outline accuracy with both models (U-Net PQ −0.01 to −0.02, Cellpose-SAM −0.03 to −0.04) and made some sites much worse (D50 error up to +22 percentage points; coarse cobble photos suffered most). Use it only for experiments, and record that you did (it is in the export metadata).',
  },
  fineGrainUpscale: {
    title: 'Enlarge for fine grains',
    group: 'Analysis',
    what: 'Re-analyses the photo after enlarging it ×1.5, so small grains are bigger for the network. Sizes are still reported in the original photo pixels (or mm), so results stay comparable. Offered for U-Net when the median grain is under 20 px in the analysed image.',
    default: 'Offered, not automatic',
    when: 'Accept it for fine gravel analysed with U-Net. In the pre-processing benchmark (40 test photos) enlarging fine-gravel photos ×1.5 improved outline accuracy (PQ +0.025, 95% CI +0.007 to +0.049) and recall of small grains, with no site getting worse, at about 1.5–2× the time for the photos it is applied to (about twice as many tiles). The 20 px threshold was chosen after seeing the test results, so it is offered rather than automatic until confirmed on new data. Cellpose-SAM already handles fine grains and does not need it. Undo returns to the normal analysis.',
  },
  claheClipLimit: {
    title: 'CLAHE clip',
    group: 'Analysis',
    what: 'How strong the CLAHE contrast boost is (only used when CLAHE is on).',
    default: '2.0',
    when: 'Increase to 3–4 for stronger enhancement in very difficult lighting. Too high exaggerates noise and texture.',
  },
  excludeBorder: {
    title: 'Exclude border grains',
    group: 'Analysis',
    what: 'Leaves out grains that touch the edge of the photo. They are cut off by the frame, so they look smaller than they are.',
    default: 'On',
    when: 'Keep on for normal use. Turn off only if the photo edge coincides with a real boundary of the sampled area and you accept the cut-off grains. Applies immediately to analysed photos.',
  },
  excludeBorderMargin: {
    title: 'Border margin (px)',
    group: 'Analysis',
    what: 'How close to the photo edge (in working-resolution pixels) a grain must come to count as "touching the border".',
    default: '2 px',
    when: 'Increase (e.g. 5–10) if the photo edges are blurred, vignetted or distorted. Takes effect the next time photos are analysed.',
  },
  niter: {
    title: 'Flow steps',
    group: 'Advanced analysis',
    what: 'How many steps the post-processing takes when tracing each pixel to the centre of its grain.',
    default: '250',
    when: 'Rarely needed. Increase (e.g. 400) if very large or elongated grains are split into several pieces. Higher values are slower. The default is the tested value.',
  },
  cpuThreads: {
    title: 'CPU threads',
    group: 'Advanced analysis',
    what: 'How many processor threads the neural network uses when it runs on the CPU (no graphics card). Saved in this browser; takes effect after you reload the page.',
    default: 'Auto: one fewer than the processor threads, at most 8 (e.g. 3 on a 4-thread computer)',
    when: 'Lower it if the computer or phone becomes unresponsive or hot during analysis. Raise it (up to all threads) on a computer you are not using for anything else, for a little more speed; more than the number of physical cores rarely helps. Has no effect when a graphics card (WebGPU) runs the model.',
  },
  notifyWhenDone: {
    title: 'Notify me when a long analysis finishes',
    group: 'Advanced analysis',
    what: 'Shows a system notification when an analysis that took more than a minute finishes while this tab is in the background. The browser asks for permission the first time. Whether or not this is on, the tab title shows progress, e.g. "(3/12) webGrainy", and "✓ Done" at the end while you are in another tab.',
    default: 'Off',
    when: 'Turn it on for long batches (CP-SAM, many photos) so you can work elsewhere. The screen is kept awake during an analysis where the browser allows it, but switching tabs or minimising can still slow it down on some devices.',
  },
  sitePlace: {
    title: 'Place (repeat surveys)',
    group: 'Site statistics',
    what: 'Each site in webGrainy is one survey: the photos of one place on one occasion. To follow a place over time, give each of its surveys the same place name (e.g. "Rakaia reach 3"). Surveys of a place are grouped in the site list, "+ New survey of this place" starts the next one with the same statistics settings, and Compare sites draws one line per place over time and lists the change between consecutive surveys (D16, D50, D84 with 95% intervals).',
    default: 'Empty (the site is not grouped with others)',
    when: 'Whenever the same reach, bar or patch is photographed again (after a flood, each season, before and after works). Use the same camera height, scale method and analysis settings for every survey so that changes reflect the bed, not the method.',
  },
  surveyDate: {
    title: 'Survey date',
    group: 'Site statistics',
    what: 'The date the site (survey) was made, used to order surveys of a place and plot D16/D50/D84 over time in Compare sites. If you leave it empty, the earliest camera date of the survey\'s photos is used (when the photos have one). Saved with the site and in project files.',
    default: 'Empty: the earliest photo date',
    when: 'Set it when the photos have no camera date, when the camera clock was wrong, or when photos from several days belong to one survey.',
  },
  backup: {
    title: 'Results, downloads and browser storage',
    group: 'Site statistics',
    what: 'webGrainy keeps your photos and results in this browser only while you work: a site is removed from this browser after the chosen number of days without use (opening it, changing it or "Keep longer" restarts the count), so the browser does not fill up with photos. Removal happens when the app is opened, and only automatically for sites whose results were downloaded after their last change: a site with work that was never downloaded (or changed since) is kept and listed, so you can download, keep or remove it. A site open in any tab is never removed, and a warning appears 3 days before. "Download results…" saves every result file of the site in one .zip: site summaries, pooled grains, the grain-size curve and printable report, and for each photo its grains, summary, label mask and outlines, with a README. Tick "Include the project file" to add a .webgrainy file with the photos, which reopens the site in webGrainy later (Open). "Results downloaded" turns into a warning when the site has changed since its last download.',
    default: 'Sites are kept 30 days after last use. webGrainy asks the browser not to clear its storage on its own; the storage line says whether it agreed. Browsers can still clear it sooner (e.g. Safari after 7 days without a visit, unless the app is installed).',
    when: 'Download the results after each analysis session; keep your original photos in your own folders. Choose "until I delete them" only if you manage the browser storage yourself.',
  },
  skipTilesOutsideRoi: {
    title: 'Skip areas outside the ROI',
    group: 'Advanced analysis',
    what: 'When a photo has a region of interest (ROI) or exclusion areas, the network only runs on the parts of the photo near the area that is counted, plus a 128-pixel safety margin. Grains inside the ROI get exactly the same outlines as a full analysis, unless they reach more than 128 pixels outside it.',
    default: 'On',
    when: 'Keep it on: it saves time in proportion to the area outside the ROI. Draw the ROI before analysing. If you enlarge the ROI or remove an exclusion afterwards, the app warns that part of the new area was not analysed; re-analyse that photo. Turn it off if you expect to change ROIs a lot after analysing, or if grains much larger than 256 pixels cross the ROI edge.',
  },
  minSeedDensity: {
    title: 'Seed density',
    group: 'Advanced analysis',
    what: 'How many pixels must end up at the same point before a new grain is started.',
    default: '2',
    when: 'Rarely needed. Increase (e.g. 4–6) if noise creates many tiny fragment grains. Decrease to 1 only for very small grains. The default is the tested value.',
  },
  compareSites: {
    title: 'Compare sites',
    group: 'Site statistics',
    what: 'Compares the sites (surveys) you tick, grouped by place: a table of D16, D50 (with its confidence interval), D84, geometric mean and spread, Sauter mean, sorting and gravel/cobble share; "More statistics" with Folk & Ward, adequacy, size cutoff, shape and fabric; overlaid grain-size curves and size distributions; size-class composition bars; grain shape (b/a) curves; and a fabric rose for each site. For each pair of sites it gives the ratio of D16, D50 and D84 with 95% intervals and p-values. With "Order by survey date" it draws D16/D50/D84 over time, one line per place, and lists the change between consecutive surveys of each place. All sites are computed with the same statistics settings, over the same size range (the largest size cutoff of the compared sites), and a warning appears when their photos were analysed with different settings (model, image scale, enhancement, post-processing). "Printable comparison report" puts all of it, with the change over time when ordered by date, into one A4 report to print or save as PDF.',
    default: 'All sites ticked',
    when: 'Use it to compare reaches, or one place before and after a flood or between seasons. Take several photos per survey (at least 5 for a usable test): with one photo there is no interval or p-value, because a single photo cannot show how much the bed varies from patch to patch, and with 2–4 photos intervals are wide, so only large differences show. The tests are approximate: they combine each site\'s photo-level bootstrap interval on a log scale, allowing for the number of photos (Welch t-test). Treat p < 0.05 as "likely different" and check the curves; with many pairs, some will be "significant" by chance; for a formal test use a full two-sample method such as GSDtools (Eaton et al. 2019). Sites must be calibrated (mm) to be plotted together; uncalibrated sites are listed but not plotted with calibrated ones. Fabric orientations are relative to each photo\'s frame, so compare them only between surveys photographed the same way round.',
  },
  moreStats: {
    title: 'More statistics',
    group: 'Site statistics',
    what: 'Extra summary numbers. Mean diameters D[p,q] = Σdᵖ/Σd^q use every grain once: the Sauter mean D[3,2] is the mean size weighted by grain area (the same basis as the grid-by-number PSD); D[4,3] weights larger grains more. The geometric mean Dg and geometric standard deviation σg, D30/D60/D65, the uniformity (Cu) and curvature (Cc) coefficients, Trask sorting So, span and the Fredle index use the same weighting as the PSD curve. Moments (φ) are the method-of-moments mean, sorting, skewness and kurtosis on the φ scale (GRADISTAT; Blott & Pye 2001), an alternative to Folk & Ward.',
    default: 'Always computed; uses the chosen size metric',
    when: 'Use the Sauter mean or Dg when a formula asks for a "mean grain size"; D65 for Einstein-type roughness; Cu/Cc for engineering gradation; the Fredle index for spawning-gravel assessments. All are 2D surface measures from photos, so they inherit the same limits as D50 (no hidden fines, no subsurface).',
  },
  poolingMode: {
    title: 'Pooling mode',
    group: 'Site statistics',
    what: 'How grains from all photos are combined into one size distribution. "Physical area-weighted" counts each grain by its visible area, the photo equivalent of a grid (Wolman) pebble count. "Number-weighted" counts every grain once and gives much finer results that are not comparable with pebble counts or sieving.',
    default: 'Physical area-weighted',
    when: 'Keep the default for most work. Use "Equal-photo" if photos cover very different areas and each location should count the same. Use "Virtual Wolman grid" to mimic a field pebble count. Use "Facies-weighted" with per-photo facies weights for stratified sampling. Use "Number-weighted" only if you specifically need a by-count distribution.',
  },
  sizeMetric: {
    title: 'Size metric',
    group: 'Site statistics',
    what: 'Which grain size is used. "b-axis" is the short axis of an ellipse fitted to the outline (standard for photo-sieving). "min-Feret" is the narrowest caliper width of the outline (closest to a hand-measured b-axis). "d_eq" is the diameter of a circle with the same area.',
    default: 'b-axis (ellipse minor)',
    when: 'Keep b-axis for comparison with published photo-sieving. Use min-Feret when comparing with caliper measurements (its D50 was about 3% larger than the b-axis D50 on the held-out test photos; middle half of photos 0–5%). Always report which one you used.',
  },
  harmonizePhysicalCutoff: {
    title: 'Harmonize cutoff',
    group: 'Site statistics',
    what: 'Photos at different scales can resolve different smallest sizes. Each photo\'s smallest size is the larger of "Min b-axis (px)" and what its analysis can detect: large photos are shrunk for analysis (see Image scale), which raises that floor. When on, the largest of these cutoffs (in mm) is applied to every photo, so all photos describe the same size range.',
    default: 'On',
    when: 'Keep on when combining photos taken at different heights or zooms. Turning it off adds more fine grains from the sharper photos, but mixes size ranges.',
  },
  minBaxisPx: {
    title: 'Min b-axis (px)',
    group: 'Site statistics',
    what: 'Grains smaller than this (in original photo pixels) are left out of both This photo and Whole site statistics because they are too small to measure reliably. Marked with an amber dot when "Mark edge/too-small grains" is on.',
    default: '15 px',
    when: 'Lower it (e.g. 10) for very sharp high-resolution photos. Raise it if small grains look unreliable. Applies immediately without re-analysing.',
  },
  minSizeMm: {
    title: 'Field-count cutoff (mm)',
    group: 'Site statistics',
    what: 'Leaves out all grains smaller than this size (mm) from both This photo and Whole site statistics, so results cover the same size range as a field pebble count. Marked with an amber dot when "Mark edge/too-small grains" is on.',
    default: '0 (off)',
    when: 'Set it to the smallest stone your field method records (typically 8–16 mm) whenever you compare with a pebble count. Without it the photo D50 can look much finer (about 30% with Cellpose-SAM at the K1 test site and about 20% with U-Net; with a matching 13 mm cutoff both agreed with the field D50 within about 3%). Applies immediately without re-analysing.',
  },
  maxExcludedFraction: {
    title: 'Exclusion overlap',
    group: 'Site statistics',
    what: 'How much of a grain may overlap an excluded area (ruler, boot, vegetation…) before the grain is left out. 0.10 means a grain is dropped if more than 10% of it is inside an excluded region.',
    default: '0.10',
    when: 'Lower it (e.g. 0) to drop any grain touching an excluded area, e.g. when an exclusion marks a disturbed patch. Raise it (e.g. 0.5) if exclusions are rough and clip the edges of real grains you want to keep. Applies immediately.',
  },
  confidenceLevel: {
    title: 'Confidence level',
    group: 'Site statistics',
    what: 'The width of the uncertainty ranges reported for D16, D50, D84 and other statistics.',
    default: '95%',
    when: 'Use 90% only if your reporting standard asks for it. 95% is the usual choice.',
  },
  bootstrapReplicates: {
    title: 'Bootstrap repeats',
    group: 'Site statistics',
    what: 'How many times photos are resampled to estimate the site uncertainty. More repeats give more stable uncertainty ranges but take longer.',
    default: '500',
    when: 'Increase to 1000–2000 for final reported results. Decrease (e.g. 200) for faster updates while editing.',
  },
  bootstrapSeed: {
    title: 'Bootstrap seed',
    group: 'Site statistics',
    what: 'A fixed starting number for the random resampling, so the same data always give the same uncertainty ranges.',
    default: '42',
    when: 'Normally leave it. Changing it shows how much the uncertainty ranges vary by chance; they should change only slightly.',
  },
  bootstrapTwoStage: {
    title: 'Two-stage bootstrap',
    group: 'Site statistics',
    what: 'Also resamples grains within each photo, as well as photos within the site. This gives wider, more conservative uncertainty ranges.',
    default: 'Off',
    when: 'Turn on when you have only a few photos, or photos with few grains each, and want to account for both sources of variation.',
  },
  wolmanPointsPerPhoto: {
    title: 'Virtual Wolman points',
    group: 'Site statistics',
    what: 'Number of grid points laid over each photo in "Virtual Wolman grid" pooling (only used in that mode).',
    default: '100 per photo',
    when: 'Use about the number of stones you would count in the field per photo area. More points use more of the information in each photo.',
  },
  faciesWeight: {
    title: 'Facies weight',
    group: 'Photo',
    what: 'How much this photo counts in "Facies-weighted" pooling. Each photo\'s share of the site is its weight divided by the total of all included photos\' weights (shown under the box), so a surface type\'s share is the sum over its photos.',
    default: '1 (equal weight)',
    when: 'Set when sampling a reach with distinct surface patches. Divide each surface type\'s share of the reach among its photos: riffle 70% of the reach with 4 photos and pool 30% with 1 photo means 0.175 for each riffle photo (0.7 / 4) and 0.3 for the pool photo. Giving every riffle photo 0.7 would make the pool only 10% of the site. Only used in Facies-weighted pooling.',
  },
  calibrate: {
    title: 'Calibrate',
    group: 'Tools',
    what: 'Sets the photo scale by clicking both ends of a known length (ruler, coin or quadrat). Without it, all sizes are in pixels.',
    default: 'Not calibrated',
    when: 'Always calibrate before reporting sizes. Use the longest reference available, lying flat on the gravel near the middle of the photo.',
  },
  rectify: {
    title: '4-point rectify',
    group: 'Tools',
    what: 'Straightens a photo taken at an angle, using four points that form a rectangle on the ground (e.g. quadrat corners).',
    default: 'Not applied',
    when: 'Use whenever the camera was noticeably tilted. Click the corners in order around the rectangle (top-left, top-right, bottom-right, bottom-left). Rectifying replaces the photo; Undo rectify (toolbar) restores the original with its scale and areas (after several rectifications, the photo as it was before the first). Re-analyse the photo afterwards.',
  },
  exclusion: {
    title: 'ROI and exclusion tools',
    group: 'Tools',
    what: 'ROI: draw the sampling area (e.g. the inside of a quadrat); only grains inside it count, and drawing again replaces it. Exclude / Brush: draw polygons or paint areas (rulers, boots, vegetation, water, deep shadow) to leave them out. Grains with more than 10% of their area outside the ROI or inside an excluded region are dropped from the statistics. Clear areas removes them all.',
    default: 'Whole photo, nothing excluded',
    when: 'Use the ROI when only part of the photo was sampled, and exclusions on any non-gravel object or area in the photo.',
  },
  editing: {
    title: 'Editing tools',
    group: 'Tools',
    what: 'Split (draw a line across stones that were joined), Merge (select pieces of one stone), Delete (remove non-grains), Add (draw a missed grain; press Finish shape when done). These tools appear once the photo is analysed. All edits can be undone.',
    default: '—',
    when: 'Always check the outlines and fix obvious mistakes before reporting results.',
  },
  tidyOutlines: {
    title: 'Tidy outlines (optional)',
    group: 'Tools',
    what: 'Makes every grain one solid piece. The analysis can give a grain a few pixels that do not touch it (specks along its edge, often in the dark gaps between stones) and leave small holes inside it. Tidy finds each grain\'s connected parts (pixels meeting only at a corner count as separate) and keeps the largest. Each other part joins the neighbouring grain it shares the longest edge with, becomes a grain of its own if it is at least Min size, or is removed if it touches no other grain; specks of several grains that touch only each other (floating in a gap) are removed, so afterwards every grain is one piece. Holes enclosed by one grain are filled; gaps between grains are kept. Toolbar: the photo shown. Photo list → Select: several photos. One undo step per photo; recorded in every export.',
    default: 'Off: only applied when you choose it',
    when: 'When you see specks or holes in the outlines (or multi-part grains in GIS exports). On the 40 held-out test images it changed about 0.005% of the pixels and left outline agreement and the median D50 error unchanged, but on very fine gravel (grains of 15–30 px) it can move D50 by a few percent. See METHODS, section 6.',
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpKey = keyof typeof HELP_TOPICS;

export function isHelpKey(key: string): key is HelpKey {
  return Object.prototype.hasOwnProperty.call(HELP_TOPICS, key);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Small "?" button placed next to a setting; opens the help dialog on that topic. */
export function helpButton(key: HelpKey): string {
  const t: HelpTopic = HELP_TOPICS[key];
  return `<button type="button" class="help-btn" data-help="${key}" title="${esc(t.what)}" aria-label="Help: ${esc(t.title)}">?</button>`;
}

function topicHtml(key: HelpKey, open: boolean): string {
  const t: HelpTopic = HELP_TOPICS[key];
  return `
    <details class="help-topic" id="help-${key}" ${open ? 'open' : ''}>
      <summary>${esc(t.title)}</summary>
      <dl class="help-dl">
        <dt>What it does</dt><dd>${esc(t.what)}</dd>
        <dt>Default</dt><dd>${esc(t.default)}</dd>
        <dt>When to change it</dt><dd>${esc(t.when)}</dd>
      </dl>
    </details>`;
}

/**
 * Help dialog. With a `focus` key the chosen topic is expanded and shown first;
 * all other topics stay listed (collapsed) so users can browse.
 */
export function renderHelpModalHtml(focus: HelpKey | null): string {
  const keys = Object.keys(HELP_TOPICS) as HelpKey[];
  const groups = HELP_GROUP_ORDER.map((g) => {
    const inGroup = keys.filter((k) => HELP_TOPICS[k].group === g && k !== focus);
    if (inGroup.length === 0) return '';
    return `<h3 class="help-group">${esc(g)}</h3>${inGroup.map((k) => topicHtml(k, false)).join('')}`;
  }).join('');
  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">${focus ? `Help: ${esc(HELP_TOPICS[focus].title)}` : 'Settings help'}</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body" tabindex="0">
        <p class="help-intro"><strong>New here?</strong> <button type="button" class="btn btn-sm" data-action="show-guide">Show the getting-started guide</button> <button type="button" class="btn btn-sm" data-open-modal="shortcuts">Keyboard shortcuts</button> (or press <kbd>?</kbd>)</p>
        <p class="help-intro"><strong>Using a GPU?</strong> The <a href="./gpucheck.html" target="_blank" rel="noopener">GPU check</a> page tests whether your graphics card gives the same results as the CPU (please send us the report).</p>
        <p class="help-intro">The defaults are the settings that were tested. For most photos: calibrate the scale, check the outlines, and set the field-count cutoff if you compare with a pebble count. Change other settings only for the reasons below, and note what you changed (exports record all settings).</p>
        ${focus ? topicHtml(focus, true) : ''}
        ${focus ? '<h3 class="help-group">All settings</h3>' : ''}
        ${groups}
      </div>
    </div>`;
}
