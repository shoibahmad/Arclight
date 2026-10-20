import { readJSON, writeJSON } from './Storage.js';
import { DEFAULT_BINDINGS } from './Input.js';
import { clamp } from './MathUtil.js';

/**
 * Player settings, persisted between sessions.
 *
 * Quality presets exist so the game has something sane to fall back to on a
 * laptop iGPU; `renderScale` is kept separate from the preset because it is the
 * single most effective dial and players like to touch it directly.
 */

export const QUALITY_PRESETS = {
  low: {
    label: 'LOW',
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    bloom: true,
    bloomIterations: 3,
    grain: false,
    decorDensity: 0.4,
    reflections: false,
    anisotropy: 2,
    trailSegments: 20,
  },
  medium: {
    label: 'MEDIUM',
    maxPixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    bloomIterations: 4,
    grain: true,
    decorDensity: 0.7,
    reflections: false,
    anisotropy: 4,
    trailSegments: 32,
  },
  high: {
    label: 'HIGH',
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    bloomIterations: 5,
    grain: true,
    decorDensity: 1,
    reflections: true,
    anisotropy: 8,
    trailSegments: 48,
  },
  ultra: {
    label: 'ULTRA',
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    bloom: true,
    bloomIterations: 6,
    grain: true,
    decorDensity: 1.35,
    reflections: true,
    anisotropy: 16,
    trailSegments: 64,
  },
};

export const DEFAULTS = {
  quality: 'high',
  renderScale: 1,
  fov: 78,
  cameraMode: 'chase', // chase | close | cockpit
  shake: 0.8,
  speedLines: true,
  chromaticAberration: true,
  masterVolume: 0.8,
  musicVolume: 0.55,
  sfxVolume: 0.9,
  units: 'kph', // kph | mph
  showGhost: true,
  showRacingLine: true,
  invertPitch: false,
  bindings: DEFAULT_BINDINGS,
};

const KEY = 'settings';

export class Settings {
  constructor() {
    this.data = { ...DEFAULTS, ...readJSON(KEY, {}) };
    this.data.bindings = { ...DEFAULT_BINDINGS, ...(this.data.bindings || {}) };
    this._sanitise();
    /** Callbacks fired after any change, so the renderer can reconfigure. */
    this._watchers = new Set();
  }

  _sanitise() {
    const d = this.data;
    if (!QUALITY_PRESETS[d.quality]) d.quality = DEFAULTS.quality;
    d.renderScale = clamp(Number(d.renderScale) || 1, 0.5, 1);
    d.fov = clamp(Number(d.fov) || DEFAULTS.fov, 60, 100);
    d.shake = clamp(Number(d.shake) ?? DEFAULTS.shake, 0, 1.5);
    for (const k of ['masterVolume', 'musicVolume', 'sfxVolume']) {
      d[k] = clamp(Number(d[k]) ?? DEFAULTS[k], 0, 1);
    }
    if (!['chase', 'close', 'cockpit'].includes(d.cameraMode)) d.cameraMode = 'chase';
    if (!['kph', 'mph'].includes(d.units)) d.units = 'kph';
  }

  get preset() {
    return QUALITY_PRESETS[this.data.quality];
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this._sanitise();
    this.save();
    for (const fn of this._watchers) fn(key, this.data[key]);
  }

  bind(action, code, slot = 0) {
    const list = [...(this.data.bindings[action] || [])];
    list[slot] = code;
    this.data.bindings = { ...this.data.bindings, [action]: list };
    this.save();
    for (const fn of this._watchers) fn('bindings', this.data.bindings);
  }

  resetBindings() {
    this.data.bindings = { ...DEFAULT_BINDINGS };
    this.save();
    for (const fn of this._watchers) fn('bindings', this.data.bindings);
  }

  onChange(fn) {
    this._watchers.add(fn);
    return () => this._watchers.delete(fn);
  }

  save() {
    writeJSON(KEY, this.data);
  }

  /**
   * Pick a starting preset from whatever we can see of the machine.
   * Deliberately conservative: it is much better to start at MEDIUM and have
   * the player raise it than to open on a 12fps ULTRA first impression.
   */
  static detectQuality() {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (mobile) return 'low';
    if (cores >= 8 && memory >= 8) return 'high';
    if (cores >= 4) return 'medium';
    return 'low';
  }
}
