/**
 * End-to-end smoke test.
 *
 *   npm run test:smoke
 *
 * Boots the real game in headless Chrome, drives a race to completion with
 * the AI holding the player's craft, and fails on any console error, any
 * thrown exception, any non-finite state, or a race that does not actually
 * progress. It is the test that answers the only question that really
 * matters for a game: does it run, start to finish, without falling over.
 *
 * Runs on SwiftShader, so it works on a machine with no GPU — which also
 * means it is slow. Simulation is stepped directly rather than in real time
 * so the whole race takes seconds rather than minutes.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep, findBrowser } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8788;
const BASE = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const keepOpen = args.includes('--watch');
const shotDir = join(ROOT, 'docs', 'captures');

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!findBrowser()) {
  console.error('No Chrome or Edge found; set CHROME_PATH. Skipping smoke test.');
  process.exit(0);
}

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT), '--no-open'], {
  stdio: 'ignore',
});
await sleep(700);

const browser = await Browser.launch({ width: 1280, height: 720, headless: !keepOpen });
const page = await browser.open(`${BASE}/`, { width: 1280, height: 720 });

try {
  console.log('\nboot');
  await page.waitFor('window.arclight && window.arclight.ready === true', {
    timeout: 90000,
    label: 'game to finish booting',
  });
  check(true, 'game boots');

  const trackCount = await page.evaluate(
    `(async () => (await import('/src/data/tracks/index.js')).TRACK_IDS.length)()`
  );
  check(trackCount >= 6, 'all circuits registered', `${trackCount} tracks`);

  console.log('\nrace');
  // Start a short race directly, bypassing the menus, and run it off the
  // simulation clock rather than wall clock.
  await page.evaluate(`
    window.arclight.startRace({
      trackId: 'meridian', classId: 'sprint', shipId: 'kestrel',
      mode: 'race', opponents: 7, laps: 2, seed: 1234,
    });
    window.arclight.race.startImmediately();
    window.__probe = { maxSpeed: 0, nonFinite: 0, steps: 0 };
  `);
  check(true, 'race starts');

  // Hold the throttle and let the player's craft be steered by a copy of the
  // AI, so the run exercises a full lap rather than the first barrier.
  await page.evaluate(`
    (async () => {
      const { AIDriver } = await import('/src/game/AIDriver.js');
      const race = window.arclight.race;
      window.__pilot = new AIDriver(race.player, race.track, race.arcline, { skill: 0.95, seed: 9 });
    })()
  `);

  const SIM_SECONDS = 260;
  const CHUNK = 4;
  for (let elapsed = 0; elapsed < SIM_SECONDS; elapsed += CHUNK) {
    const done = await page.evaluate(`
      (() => {
        const game = window.arclight;
        const race = game.race;
        if (!race) return true;
        const step = 1 / 120;
        for (let i = 0; i < ${CHUNK} * 120; i++) {
          const c = window.__pilot.update(step, { rivals: race.ships, frozen: race.director.frozen });
          Object.assign(race.playerControls, c);
          race.step(step);
          const p = race.player;
          window.__probe.steps++;
          window.__probe.maxSpeed = Math.max(window.__probe.maxSpeed, p.speed);
          if (!Number.isFinite(p.position.x + p.position.y + p.position.z + p.speed)) {
            window.__probe.nonFinite++;
          }
          if (race.director.state === 'finished') return true;
        }
        return race.director.state === 'finished';
      })()
    `);
    if (done) break;
  }

  const probe = await page.evaluate('JSON.stringify(window.__probe)').then(JSON.parse);
  const summary = await page.evaluate(`
    (() => {
      const race = window.arclight.race;
      if (!race) return null;
      const d = race.director;
      return JSON.stringify({
        state: d.state,
        clock: d.clock,
        results: d.results().map(r => ({ pos: r.position, name: r.name, laps: r.laps,
          total: r.totalTime, best: r.bestLap, retired: r.retired, isPlayer: r.isPlayer })),
      });
    })()
  `).then((v) => (v ? JSON.parse(v) : null));

  check(probe.steps > 1000, 'simulation advanced', `${probe.steps} steps`);
  check(probe.nonFinite === 0, 'state stayed finite', `${probe.nonFinite} bad frames`);
  check(probe.maxSpeed > 60, 'craft reached racing speed', `${(probe.maxSpeed * 3.6).toFixed(0)} kph`);

  check(summary !== null, 'race survived to the end');
  if (summary) {
    check(summary.state === 'finished', 'race reached the finish', summary.state);
    const finishers = summary.results.filter((r) => !r.retired);
    check(finishers.length >= 6, 'field classified', `${finishers.length}/8 finished`);

    const withBest = summary.results.filter((r) => r.best != null);
    check(withBest.length >= 6, 'lap times recorded', `${withBest.length} drivers`);

    const bestTimes = withBest.map((r) => r.best);
    const fastest = Math.min(...bestTimes);
    const slowest = Math.max(...bestTimes);
    check(fastest > 25 && fastest < 160, 'fastest lap is plausible', `${fastest.toFixed(2)}s`);
    check(slowest / fastest < 2.2, 'field is competitive', `spread ${(slowest / fastest).toFixed(2)}x`);

    const positions = summary.results.map((r) => r.pos);
    check(
      new Set(positions).size === positions.length,
      'classification has no duplicate positions'
    );

    console.log('\n  classification');
    for (const r of summary.results) {
      console.log(
        `    P${String(r.pos).padStart(2)}  ${String(r.name).padEnd(13)}` +
          ` ${r.retired ? 'DNF    ' : (r.total ?? 0).toFixed(2).padStart(7)}` +
          `  best ${(r.best ?? 0).toFixed(2).padStart(6)}${r.isPlayer ? '   <- player' : ''}`
      );
    }
  }

  console.log('\nscreens');
  await page.evaluate('window.arclight.quitToMenu()');
  await sleep(400);
  const menuOpen = await page.evaluate("document.querySelectorAll('.menu__item').length");
  check(menuOpen > 3, 'main menu renders', `${menuOpen} items`);

  await page.screenshot(join(shotDir, 'smoke-menu.png')).catch(() => {});

  const errors = page.errors.filter(
    (e) => !/favicon|Failed to load resource/i.test(e.text)
  );
  check(errors.length === 0, 'no console errors', errors.length ? errors[0].text.split('\n')[0] : '');
  for (const error of errors.slice(0, 6)) console.log(`      ${error.text.split('\n')[0]}`);
} catch (error) {
  check(false, 'smoke test threw', error.message);
  for (const e of page.errors.slice(0, 6)) console.log(`      ${e.text.split('\n')[0]}`);
} finally {
  if (!keepOpen) {
    await page.close();
    await browser.close();
  }
  server.kill();
}

console.log(failures === 0 ? '\nsmoke test passed\n' : `\nsmoke test failed (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
