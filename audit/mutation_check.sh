#!/usr/bin/env bash
# Audit: quick mutation check. Copies the repo to a scratch dir, applies one mutation at a time,
# runs the test suite, and reports whether any test failed (killed) or not (survived).
# Usage: bash audit/mutation_check.sh <scratch_dir>
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd); W=${1:-/tmp/mut}
muts=(
 "src/modules/sedimentStats.ts|const phi16 = -Math.log2(psdMm.D84);|const phi16 = -Math.log2(psdMm.D16);|F&W phi16 mapped to D16 (swap)"
 "src/modules/sedimentStats.ts|cdf\[i\] = (cumSum - 0.5 \* pair.w) / totalWeight;|cdf[i] = cumSum / totalWeight;|percentile CDF without midpoint"
 "src/modules/pipelineController.ts|areaPx: grain.areaPx \* invSq,|areaPx: grain.areaPx * inv,|area rescaled linearly instead of squared"
 "src/modules/postprocessCore.ts|const bAxisPx = 4.0 \* Math.sqrt(l2);|const bAxisPx = 4.2 * Math.sqrt(l2);|b-axis +5% scale error"
 "src/modules/siteAnalysis.ts|? (sumW \* sumW) / Math.max(1e-12, sumW2)|? sumW|Kish n_eff replaced by raw weight sum"
 "src/modules/siteAnalysis.ts|if (cum <= alpha / 2) {|if (cum <= alpha) {|binomial CI lower tail alpha instead of alpha/2"
 "src/modules/sedimentStats.ts|} else if (d < 64) {|} else if (d < 32) {|Wentworth gravel/cobble edge 64->32 mm"
 "src/modules/sedimentStats.ts|if (sortingPhi < 0.5) return 'Well Sorted';|if (sortingPhi < 0.6) return 'Well Sorted';|F&W sorting threshold"
 "src/modules/postprocessCore.ts|const wMag = Math.min(1.0, rawMag / 1.5);|const wMag = 1.0;|flow-QC magnitude weighting removed"
)
for m in "${muts[@]}"; do
  IFS='|' read -r file from to desc <<<"$m"
  rm -rf "$W"; mkdir -p "$W"; (cd "$REPO" && tar --exclude=node_modules --exclude=dist --exclude=audit -cf - .) | (cd "$W" && tar xf -); ln -s "$REPO/node_modules" "$W/node_modules"
  if ! grep -qF -- "$(echo "$from" | sed 's/\\//g')" "$W/$file"; then echo "NOT-APPLIED | $desc"; continue; fi
  sed -i "s#$from#$to#" "$W/$file"
  out=$(cd "$W" && npx vitest run 2>&1 | grep -E "Tests +[0-9]")
  fails=$(echo "$out" | grep -oE "[0-9]+ failed" | head -1)
  # the flaky timing test is excluded from the kill decision
  real=$(cd "$W" && npx vitest run 2>&1 | grep -E "^ +(×|FAIL)" | grep -v "< 5 ms\|budget" | wc -l)
  if [ "$real" -gt 0 ]; then echo "KILLED ($real non-timing failures) | $desc"; else echo "SURVIVED | $desc   [$out]"; fi
done
