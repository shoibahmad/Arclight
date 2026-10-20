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
  `);
  await page.waitFor('window.arclight.race && !window.arclight.loading', {
    timeout: 90000,
    label: 'the circuit to finish building',
  });
  await page.evaluate(`
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

  console.log('\ntime trial');
  await page.evaluate('window.arclight.quitToMenu()');
  await page.evaluate(`
    window.arclight.profile.clearGhost('meridian', 'sprint');
    window.arclight.startRace({
      trackId: 'meridian', classId: 'sprint', shipId: 'vireo',
      mode: 'timetrial', opponents: 0, laps: 2, seed: 77,
    });
  `);
  await page.waitFor('window.arclight.race && !window.arclight.loading', { timeout: 90000 });
  await page.evaluate('window.arclight.race.startImmediately()');
  await page.evaluate(`
    (async () => {
      const { AIDriver } = await import('/src/game/AIDriver.js');
      const race = window.arclight.race;
      window.__pilot = new AIDriver(race.player, race.track, race.arcline, { skill: 0.95, seed: 4 });
    })()
  `);

  // Two laps is enough to bank a ghost and then replay against it.
  for (let i = 0; i < 60; i++) {
    const done = await page.evaluate(`
      (() => {
        const race = window.arclight.race;
        if (!race) return true;
        const step = 1 / 120;
        for (let k = 0; k < 480; k++) {
          Object.assign(race.playerControls, window.__pilot.update(step, { rivals: race.ships }));
          race.step(step);
        }
        return race.director.state === 'finished';
      })()
    `);
    if (done) break;
  }

  const trial = await page.evaluate(`
    (() => {
      const game = window.arclight;
      const ghost = game.profile.loadGhost('meridian', 'sprint');
      const record = game.profile.getRecord('meridian', 'sprint');
      return JSON.stringify({
        hasGhost: !!ghost,
        ghostFrames: ghost ? ghost.length : 0,
        ghostLap: ghost ? ghost.lapTime : null,
        bestLap: record ? record.bestLap : null,
      });
    })()
  `).then(JSON.parse);

  check(trial.hasGhost, 'ghost recorded and persisted', `${trial.ghostFrames} frames`);
  check(
    trial.ghostLap > 20 && trial.ghostLap < 200,
    'ghost lap time is plausible',
    `${(trial.ghostLap ?? 0).toFixed(2)}s`
  );
  check(trial.bestLap != null, 'best lap written to the profile', `${(trial.bestLap ?? 0).toFixed(2)}s`);

  // Replay against the stored ghost and confirm the live delta works.
  await page.evaluate('window.arclight.quitToMenu()');
  await page.evaluate(`
    window.arclight.startRace({
      trackId: 'meridian', classId: 'sprint', shipId: 'vireo',
      mode: 'timetrial', opponents: 0, laps: 2, seed: 78,
    });
  `);
  await page.waitFor('window.arclight.race && !window.arclight.loading', { timeout: 90000 });
  await page.evaluate(`
    window.arclight.race.startImmediately();
    (function () {
      const race = window.arclight.race;
      const step = 1 / 120;
      for (let k = 0; k < 1200; k++) {
        Object.assign(race.playerControls, { throttle: 1, brake: 0, steer: 0, airLeft: 0, airRight: 0, boost: false, shield: false });
        race.step(step);
      }
    })();
  `);
  const ghostState = await page.evaluate(`
    (() => {
      const race = window.arclight.race;
      const delta = race.ghostDelta();
      return JSON.stringify({ loaded: !!race.ghost, delta, visible: !!race.ghostVisual });
    })()
  `).then(JSON.parse);
  check(ghostState.loaded, 'ghost loaded for playback');
  check(ghostState.visible, 'ghost craft created');
  check(Number.isFinite(ghostState.delta), 'live ghost delta computed', `${(ghostState.delta ?? 0).toFixed(3)}s`);

  console.log('\nchampionship');
  await page.evaluate('window.arclight.quitToMenu()');
  const cup = await page.evaluate(`
    (async () => {
      const game = window.arclight;
      const { getCup } = await import('/src/data/championships.js');
      const cupDef = getCup('proving');
      const entrants = [{ id: 'player', name: 'YOU', isPlayer: true }];
      for (let i = 0; i < 7; i++) entrants.push({ id: 'ai-' + i, name: 'AI ' + i, isPlayer: false });
      game.profile.startCareer('proving', 'sprint', entrants);

      // Apply two rounds of results without driving them.
      const order = entrants.map((e) => ({ id: e.id }));
      game.profile.applyRaceResult(order);
      game.profile.applyRaceResult([...order].reverse());
      const career = game.profile.career;
      return JSON.stringify({
        rounds: cupDef.tracks.length,
        raceIndex: career.raceIndex,
        topPoints: career.standings[0].points,
        totalPoints: career.standings.reduce((a, s) => a + s.points, 0),
        standings: career.standings.length,
      });
    })()
  `).then(JSON.parse);

  check(cup.raceIndex === 2, 'championship advanced two rounds', `index ${cup.raceIndex}`);
  check(cup.standings === 8, 'championship tracks the whole field');
  // 25+18+15+12+10+8+6+4 = 98 per round, two rounds.
  check(cup.totalPoints === 196, 'points awarded correctly', `${cup.totalPoints} over 2 rounds`);
  check(cup.topPoints >= 25, 'leader has points', `${cup.topPoints}`);

  await page.evaluate(`
    (() => {
      const game = window.arclight;
      game.profile.completeCup('proving', 'sprint', 1);
      for (const [kind, ids] of Object.entries({ cups: ['nocturne'], tracks: ['lowtown', 'harbour'], ships: ['mantis'] })) {
        for (const id of ids) game.profile.unlock(kind, id);
      }
    })()
  `);
  const unlocked = await page.evaluate(`
    JSON.stringify({
      cup: window.arclight.profile.has('cups', 'nocturne'),
      track: window.arclight.profile.has('tracks', 'lowtown'),
      ship: window.arclight.profile.has('ships', 'mantis'),
      career: window.arclight.profile.career,
    })
  `).then(JSON.parse);
  check(unlocked.cup && unlocked.track && unlocked.ship, 'cup win unlocks the next tier');
  check(unlocked.career === null, 'career cleared after a completed cup');

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
