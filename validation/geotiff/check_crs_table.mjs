#!/usr/bin/env node
// Checks the app's projected -> longitude/latitude conversion (dist/modules/projToLonLat.js,
// `npm run build` first) against PROJ for every CRS in src/modules/crsTable.ts: the reference
// points in crs_reference.json (written by make_crs_table.py) are each CRS's area-of-use centre,
// projected by PROJ. Fails if any point is off by more than 1 mm.
//   node validation/geotiff/check_crs_table.mjs
import { readFileSync } from 'node:fs';
import { lonLatProjector } from '../../dist/modules/projToLonLat.js';

const ref = JSON.parse(readFileSync(new URL('./crs_reference.json', import.meta.url), 'utf8'));
const D = Math.PI / 180;
const metres = (a, b) => Math.hypot((((a[0] - b[0] + 540) % 360) - 180) * D * Math.cos(b[1] * D), (a[1] - b[1]) * D) * 6371008.8;
let worst = [0, null];
for (const [code, x, y, lon, lat] of ref) {
  const f = lonLatProjector(code, 'projected');
  if (!f) throw new Error(`EPSG:${code} missing from the table`);
  const err = metres(f(x, y), [lon, lat]);
  if (err > worst[0]) worst = [err, code];
}
console.log(`${ref.length} CRSs; largest difference from PROJ: ${(worst[0] * 1000).toFixed(3)} mm (EPSG:${worst[1]})`);
if (worst[0] > 0.001) process.exit(1);
