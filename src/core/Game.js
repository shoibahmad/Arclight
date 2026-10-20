import * as THREE from 'three';
import { Viewport, ViewportError } from '../render/Viewport.js';
import { Loop, FIXED_STEP } from './Loop.js';
import { Input } from './Input.js';
import { Settings } from './Settings.js';
import { Profile } from './Profile.js';
import { Signal } from './Signal.js';
import { Race } from '../game/Race.js';
import { RACE_STATE } from '../game/RaceDirector.js';
import { Hud } from '../ui/Hud.js';
import { ScreenStack } from '../ui/ScreenStack.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { setAnisotropy } from '../assets/Materials.js';
import { clamp01 } from './MathUtil.js';

/**
 * The application shell.
 *
 * Owns everything that outlives a single race — the renderer, the loop, input,
 * settings, the save profile, audio and the screen stack — and nothing that
 * does not. A race is created, run and thrown away; the shell is what is still
 * standing afterwards.
 *
 * The update order matters and is deliberate: input is sampled once per frame
 * before any simulation reads it, the simulation runs in fixed steps, and
 * everything cosmetic happens afterwards against the leftover interpolation.
 */

export class Game {
  constructor({ canvas, hudRoot, screenRoot }) {
    this.canvas = canvas;
    this.settings = new Settings();
    this.profile = new Profile();
    this.events = new Signal();

    this.viewport = new Viewport(canvas, this.settings);
    setAnisotropy(this.viewport.maxAnisotropy);

    this.input = new Input(this.settings.get('bindings'));
    this.audio = new AudioEngine(this.settings);
    this.hud = new Hud(hudRoot, this.settings);
    this.screens = new ScreenStack(screenRoot, this);

    /** @type {Race|null} */
    this.race = null;
    this.paused = false;
    this.fade = 0;
    this.fadeTarget = 0;
    this.ready = false;

    /** A still scene shown behind the menus when no race is loaded. */
    this.menuScene = new THREE.Scene();
    this.menuCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 4000);

    this.loop = new Loop(
      (dt) => this.step(dt),
      (alpha, dt) => this.render(alpha, dt)
    );

    this.settings.onChange((key) => this._onSettingChanged(key));
    window.addEventListener('resize', () => this.viewport.resize());
    this._bindErrorHandling();
  }

  _bindErrorHandling() {
    // A thrown error inside the loop would otherwise silently stop the game
    // with a black screen and no explanation.
    this._onError = (event) => {
      const error = event.error ?? event.reason;
      if (!error) return;
      console.error('[game] unhandled error', error);
      this.showFatal(error);
    };
    window.addEventListener('error', this._onError);
    window.addEventListener('unhandledrejection', this._onError);
  }

  _onSettingChanged(key) {
    if (key === 'bindings') this.input.setBindings(this.settings.get('bindings'));
    if (['quality', 'renderScale', 'chromaticAberration'].includes(key)) {
      this.viewport.applyQuality();
      setAnisotropy(this.viewport.maxAnisotropy);
    }
    if (key.endsWith('Volume')) this.audio.applyVolumes();
  }

  async boot(onProgress = () => {}) {
    onProgress(0.1, 'renderer');
    // Give the browser a frame between heavy steps so the boot bar actually
    // moves instead of jumping from 0 to 100 after a four second freeze.
    await nextFrame();

    onProgress(0.35, 'audio');
    this.audio.prepare();
    await nextFrame();

    onProgress(0.6, 'interface');
    this.screens.show('main');
    await nextFrame();

    onProgress(1, 'ready');
    this.ready = true;
    this.loop.start();
  }

  // ------------------------------------------------------------- race flow

  /**
   * @param {{trackId:string, classId:string, shipId:string, mode?:string,
   *          laps?:number, opponents?:number, career?:object}} config
   */
  startRace(config) {
    this.endRace();

    const ghost =
      config.mode === 'timetrial'
        ? this.profile.loadGhost(config.trackId, config.classId)
        : null;

    this.race = new Race({
      ...config,
      ghost,
      settings: this.settings,
      seed: config.seed ?? Math.floor(Math.random() * 100000),
    });
    this.raceConfig = config;

    this.race.environment.applyGrade(this.viewport);
    this.hud.attach(this.race);
    this.audio.attachRace(this.race);
    this._bindRaceEvents();

    document.body.classList.add('is-driving');
    this.screens.hide();
    this.hud.setVisible(true);
    this.fadeTarget = 0;
    this.fade = 1;

    this.race.start();
  }

  _bindRaceEvents() {
    const events = this.race.director.events;
    events.on('countdown', ({ lit }) => this.audio.countdownBeep(lit));
    events.on('start', () => {
      this.audio.raceStart();
      this.hud.flashMessage('GO', 900);
    });
    events.on('lap', ({ entrant, lapTime, personalBest }) => {
      if (!entrant.ship.isPlayer) return;
      this.hud.announceLap(entrant, lapTime, personalBest);
      this.audio.lapChime(personalBest);
      if (this.race.mode === 'timetrial') {
        const best = this.race.captureGhostIfBest(lapTime);
        if (best) this.profile.saveGhost(this.raceConfig.trackId, this.raceConfig.classId, best);
      }
    });
    events.on('lastLap', () => {
      this.hud.flashMessage('FINAL LAP', 1600);
      this.audio.setIntensity(1);
    });
    events.on('finish', ({ entrant }) => {
      if (entrant.ship.isPlayer) this.onPlayerFinished();
    });
    events.on('complete', () => this.onRaceComplete());
  }

  onPlayerFinished() {
    this.hud.flashMessage('FINISH', 1800);
    this.audio.raceFinish();
    document.body.classList.remove('is-driving');
  }

  onRaceComplete() {
    if (!this.race) return;
    const results = this.race.director.results();
    const player = results.find((r) => r.isPlayer);
    const config = this.raceConfig;

    if (player) {
      this.profile.submitTimes(config.trackId, config.classId, {
        bestLap: player.bestLap,
        raceTime: player.totalTime,
      });
      this.profile.addStats({
        races: 1,
        wins: player.position === 1 ? 1 : 0,
        podiums: player.position <= 3 ? 1 : 0,
        distanceMetres: Math.max(0, this.race.player.progress),
        topSpeed: this.race.player.speed,
        playSeconds: this.race.director.clock,
      });
    }

    // Give the player a beat to cross the line before the screen takes over.
    setTimeout(() => {
      if (!this.race) return;
      this.screens.show('results', { results, config });
      this.hud.setVisible(false);
    }, 1800);
  }

  endRace() {
    if (!this.race) return;
    this.audio.detachRace();
    this.hud.detach();
    this.race.dispose();
    this.race = null;
    document.body.classList.remove('is-driving');
  }

  restartRace() {
    if (!this.raceConfig) return;
    this.startRace(this.raceConfig);
  }

  quitToMenu() {
    this.endRace();
    this.hud.setVisible(false);
    this.screens.show('main');
  }

  togglePause(force) {
    if (!this.race || this.race.finished) return;
    const next = force ?? !this.paused;
    if (next === this.paused) return;
    this.paused = next;
    this.race.paused = next;

    if (next) {
      this.screens.show('pause');
      document.body.classList.remove('is-driving');
      this.audio.setPaused(true);
    } else {
      this.screens.hide();
      document.body.classList.add('is-driving');
      this.audio.setPaused(false);
      this.input.flushEdges();
    }
  }

  // ----------------------------------------------------------------- loop

  step(dt) {
    if (!this.ready) return;

    // Input is sampled once per fixed step so a 240Hz display cannot feed the
    // simulation more edges than a 60Hz one.
    this.input.update(dt);

    if (this.screens.active && !this.race) {
      this.screens.handleInput(this.input);
      return;
    }

    if (this.race) {
      if (this.input.pressed('pause')) this.togglePause();
      if (this.paused) {
        this.screens.handleInput(this.input);
        return;
      }
      if (this.input.pressed('restart') && this.race.mode === 'timetrial') {
        this.restartRace();
        return;
      }
      this._readPlayerControls();
      this.race.step(dt);
    }
  }

  _readPlayerControls() {
    const c = this.race.playerControls;
    const input = this.input;
    c.throttle = input.value('throttle');
    c.brake = input.value('brake');
    c.steer = input.steerAxis();
    c.airLeft = input.value('airbrakeLeft');
    c.airRight = input.value('airbrakeRight');
    c.boost = input.held('boost');
    c.shield = input.held('shield');
    this.race.lookBack = input.held('lookBack');

    // Nothing moves until the lights go out, but the engine should still
    // respond to the throttle so the grid sounds alive.
    if (this.race.director.state !== RACE_STATE.RACING) {
      c.brake = 0;
      c.steer = 0;
    }
  }

  render(alpha, dt) {
    if (!this.ready) return;

    this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * 4.5);
    this.viewport.setFade(clamp01(this.fade));
    this.viewport.resize();

    if (this.race) {
      if (!this.paused) this.race.present(dt, this.viewport);
      this.race.camera.aspect = this.viewport.aspect;
      this.race.camera.updateProjectionMatrix();
      this.viewport.render(this.race.scene, this.race.camera, dt);
      this.hud.update(dt, this.race);
      this.audio.update(dt, this.race);
    } else {
      this.menuCamera.aspect = this.viewport.aspect;
      this.menuCamera.updateProjectionMatrix();
      this.viewport.render(this.menuScene, this.menuCamera, dt);
    }

    this.screens.update(dt);
  }

  showFatal(error) {
    this.loop.stop();
    const message =
      error instanceof ViewportError
        ? error.message
        : 'Arclight hit an unexpected error and had to stop.';
    const detail = error?.stack || String(error);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="fatal">
         <h1>Something went wrong</h1>
         <p>${escapeHtml(message)}</p>
         <pre>${escapeHtml(detail)}</pre>
       </div>`
    );
  }

  dispose() {
    this.loop.stop();
    this.endRace();
    this.input.dispose();
    this.audio.dispose();
    this.viewport.dispose();
    window.removeEventListener('error', this._onError);
    window.removeEventListener('unhandledrejection', this._onError);
  }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

export { FIXED_STEP };
