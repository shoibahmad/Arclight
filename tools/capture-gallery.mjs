/**
 * Capture a set of reference shots into docs/captures, and report the frame
 * cost of each scene.
 *
 *   node tools/capture-gallery.mjs
 *
 * Runs on SwiftShader, so the frame times are not representative of real
 * hardware — the useful numbers here are draw calls and triangle counts,
 * which are hardware independent.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep, findBrowser } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'captures');
const PORT = 8802;

const SHOTS = [
  { name: 'meridian', track: 'meridian', ship: 'kestrel', at: 1250, quality: 'high' },
  { name: 'saltflat', track: 'saltflat', ship: 'vireo', at: 900, quality: 'high' },
  { name: 'lowtown', track: 'lowtown', ship: 'mantis', at: 620, quality: 'high' },
  { name: 'harbour', track: 'harbour', ship: 'mantis', at: 1500, quality: 'high' },
  { name: 'vaskr', track: 'vaskr', ship: 'oriole', at: 1400, quality: 'high' },
  { name: 'calder', track: 'calder', ship: 'kestrel', at: 1000, quality: 'high' },
  { name: 'meridian-low', track: 'meridian', ship: 'kestrel', at: 1250, quality: 'low' },
];

if (!findBrowser()) {
  console.error('No Chrome or Edge found; set CHROME_PATH.');
  process.exit(0);
}

await mkdir(OUT, { recursive: true });
const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT), '--no-open'], {
  stdio: 'ignore',
});
await sleep(700);

const browser = await Browser.launch({ width: 1600, height: 900 });
const page = await browser.open(`http://localhost:${PORT}/`, { width: 1600, height: 900 });

try {
  await page.waitFor('window.arclight && window.arclight.ready === true', { timeout: 90000 });
  await sleep(600);
  await page.screenshot(join(OUT, 'menu.png'));
  console.log('  menu');

  console.log('\n  scene        draws  triangles   build');
  for (const shot of SHOTS) {
    await page.evaluate(`window.arclight.settings.set('quality', '${shot.quality}')`);
    const built = await page.evaluate(`
      (() => {
        const t0 = performance.now();
        window.arclight.startRace({
          trackId: '${shot.track}', classId: 'sprint', shipId: '${shot.ship}',
          mode: 'race', opponents: 7, laps: 3, seed: 2026,
        });
        window.__t0 = t0;
        return true;
      })()
    `);
    void built;
    await page.waitFor('window.arclight.race && !window.arclight.loading', { timeout: 120000 });
    const buildMs = await page.evaluate('Math.round(performance.now() - window.__t0)');

    await page.evaluate(`
      (async () => {
        const { AIDriver } = await import('/src/game/AIDriver.js');
        const race = window.arclight.race;
        race.startImmediately();
        const pilot = new AIDriver(race.player, race.track, race.arcline, { skill: 0.95, seed: 3 });
        const step = 1 / 120;
        let guard = 0;
        while (race.player.progress < ${shot.at} && guard++ < 120 * 400) {
          Object.assign(race.playerControls, pilot.update(step, { rivals: race.ships }));
          race.step(step);
        }
      })()
    `);
    await sleep(3000);
    await page.screenshot(join(OUT, `${shot.name}.png`));

    const stats = await page.evaluate(`JSON.stringify({
      draws: window.arclight.viewport.sceneStats?.calls ?? 0,
      tris: window.arclight.viewport.sceneStats?.triangles ?? 0,
    })`).then(JSON.parse);
    console.log(
      `  ${shot.name.padEnd(13)}${String(stats.draws).padStart(4)}` +
        `${stats.tris.toLocaleString().padStart(11)}${(buildMs + ' ms').padStart(9)}`
    );
  }

  const errors = page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e.text));
  if (errors.length) {
    console.log('\n  errors:');
    for (const e of errors.slice(0, 6)) console.log(`    ${e.text.split('\n')[0]}`);
  }
} catch (error) {
  console.error('capture failed:', error.message);
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();
  server.kill();
}
