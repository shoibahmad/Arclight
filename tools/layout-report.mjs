/**
 * Circuit layout report.
 *
 *   node --import ./tools/test/register.mjs tools/layout-report.mjs [trackId]
 *
 * Prints length, how far the hand-written loop misses closure by, the turn
 * correction that had to be applied, corner radii and the tightest point.
 * This is the feedback loop for authoring a track: tweak a radius or a
 * straight, re-run, and see whether the shape still closes on itself.
 */

import { TRACKS, loadTrack } from '../src/data/tracks/index.js';
import { buildLayout, levelLayout, layoutExtent } from '../src/track/TrackLayout.js';
import { TrackPath } from '../src/track/TrackPath.js';

const only = process.argv[2];
const ids = only ? [only] : Object.keys(TRACKS);

let worst = 0;

for (const id of ids) {
  const data = loadTrack(id);
  if (!data) {
    console.error(`unknown track "${id}"`);
    process.exitCode = 1;
    continue;
  }

  const { nodes, report } = buildLayout(data.segments, {
    start: data.layout?.start,
    heading: data.layout?.heading,
    width: data.layout?.width,
  });
  const drift = levelLayout(nodes);
  const path = new TrackPath(nodes, { spacing: 2 });
  const extent = layoutExtent(nodes);

  // Minimum corner radius, from the sampled curvature.
  let tightest = Infinity;
  let tightestAt = 0;
  for (let i = 0; i < path.count; i++) {
    const k = Math.abs(path.sampleByIndex(i).curvature);
    if (k > 1e-6) {
      const r = 1 / k;
      if (r < tightest) {
        tightest = r;
        tightestAt = path.sampleByIndex(i).distance;
      }
    }
  }

  let climb = 0;
  let maxGrade = 0;
  for (let i = 0; i < path.count; i++) {
    const s = path.sampleByIndex(i);
    climb += Math.max(0, s.grade) * path.spacing;
    maxGrade = Math.max(maxGrade, Math.abs(s.grade));
  }

  const gapPercent = (report.gap / report.length) * 100;
  worst = Math.max(worst, gapPercent);

  console.log(`\n${data.name}  (${id})`);
  console.log(`  theme          ${data.theme}`);
  console.log(`  length         ${path.length.toFixed(0)} m   (${data.laps} laps)`);
  console.log(`  authored miss  ${report.rawGap.toFixed(1)} m`);
  console.log(`  residual gap   ${report.gap.toFixed(2)} m  (${gapPercent.toFixed(3)}% of lap)`);
  console.log(`  turn rescale   ${((report.turnScale - 1) * 100).toFixed(2)}%`);
  console.log(
    `  adjusted       straights ${(report.straightAdjust * 100).toFixed(1)}%, ` +
      `radii ${(report.radiusAdjust * 100).toFixed(1)}%${report.clamped ? ' (clamped)' : ''}`
  );
  console.log(`  level drift    ${drift.toFixed(1)} m`);
  console.log(`  tightest R     ${tightest.toFixed(0)} m at ${tightestAt.toFixed(0)} m`);
  console.log(`  total climb    ${climb.toFixed(0)} m, steepest grade ${(maxGrade * 100).toFixed(1)}%`);
  console.log(`  footprint      ${extent.size.x.toFixed(0)} x ${extent.size.z.toFixed(0)} m`);
  console.log(`  control nodes  ${nodes.length}`);
}

if (worst > 2) {
  console.log(`\nworst closure gap is ${worst.toFixed(2)}% of a lap — tighten the layout`);
  process.exitCode = 1;
}
