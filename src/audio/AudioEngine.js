import { clamp, clamp01, lerp } from '../core/MathUtil.js';

/**
 * All sound in Arclight is synthesised at runtime. There are no audio files.
 *
 * That is partly an asset-ownership decision and partly a practical one: an
 * engine note that is *generated* from speed, throttle and boost can follow
 * the simulation continuously, where a looped sample has to be pitch-shifted
 * and crossfaded and always betrays itself at the loop point.
 *
 * Structure is a small mixer: a master gain feeding two buses (music and
 * effects), each with its own volume so the settings screen can balance them
 * independently. Engines are voices that live as long as a race does;
 * one-shots are built, played and left to be collected.
 *
 * Browsers will not start an AudioContext without a gesture, so everything
 * here is written to be safe to call before the context is running — it
 * simply produces nothing until `resume()` succeeds.
 */

/** Engine voices are expensive; only the closest rivals get one. */
const MAX_ENGINE_VOICES = 4;

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.paused = false;
    this.intensity = 0;

    this.voices = new Map();
    this.music = null;
    this._resumeBound = false;
  }

  /** Create the graph. Safe to call before any user gesture. */
  prepare() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[audio] Web Audio is unavailable; running silent');
      return;
    }

    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[audio] could not create an AudioContext', err);
      return;
    }

    const ctx = this.ctx;
    this.master = ctx.createGain();

    // A gentle limiter on the master bus. Eight engines plus music plus an
    // impact can comfortably sum past full scale, and the resulting clipping
    // is far more noticeable than the compression.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.noiseBuffer = makeNoiseBuffer(ctx, 2);
    this.applyVolumes();
    this.music = new MusicBed(ctx, this.musicBus, this.noiseBuffer);
    this.ready = true;

    this._bindResume();
  }

  /** The context starts suspended; the first real input wakes it. */
  _bindResume() {
    if (this._resumeBound) return;
    this._resumeBound = true;
    const wake = () => {
      this.resume();
      if (this.ctx?.state === 'running') {
        for (const type of ['pointerdown', 'keydown', 'touchstart']) {
          window.removeEventListener(type, wake);
        }
      }
    };
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(type, wake);
    }
  }

  resume() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    const at = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.get('masterVolume'), at, 0.05);
    this.musicBus.gain.setTargetAtTime(s.get('musicVolume') * 0.5, at, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.get('sfxVolume') * 0.9, at, 0.05);
  }

  setPaused(paused) {
    this.paused = paused;
    if (!this.ctx) return;
    // Duck rather than suspend: suspending the context makes resuming it
    // audibly click, and the pause menu should still make UI sounds.
    this.master.gain.setTargetAtTime(
      paused ? this.settings.get('masterVolume') * 0.25 : this.settings.get('masterVolume'),
      this.ctx.currentTime,
      0.08
    );
  }

  setIntensity(value) {
    this.intensity = clamp01(value);
    this.music?.setIntensity(this.intensity);
  }

  // ---------------------------------------------------------------- race

  attachRace(race) {
    if (!this.ready) return;
    this.race = race;
    this.detachVoices();
    this.music?.start();
    this.setIntensity(0.35);
  }

  detachRace() {
    this.race = null;
    this.detachVoices();
    this.music?.stop();
  }

  detachVoices() {
    for (const voice of this.voices.values()) voice.dispose();
    this.voices.clear();
  }

  /** Called once per rendered frame. */
  update(dt, race) {
    if (!this.ready || !race || this.paused) return;
    const player = race.player;

    // Pick which craft get a voice: the player, plus the closest rivals.
    const ranked = race.ships
      .filter((s) => s !== player)
      .map((s) => ({ ship: s, gap: Math.abs(race.track.path.delta(player.distance, s.distance)) }))
      .sort((a, b) => a.gap - b.gap)
      .slice(0, MAX_ENGINE_VOICES - 1)
      .map((e) => e.ship);
    const wanted = new Set([player, ...ranked]);

    for (const [ship, voice] of this.voices) {
      if (!wanted.has(ship)) {
        voice.dispose();
        this.voices.delete(ship);
      }
    }
    for (const ship of wanted) {
      if (!this.voices.has(ship)) {
        this.voices.set(ship, new EngineVoice(this.ctx, this.sfxBus, this.noiseBuffer, ship === player));
      }
    }

    for (const [ship, voice] of this.voices) {
      const gap = ship === player ? 0 : race.track.path.delta(player.distance, ship.distance);
      voice.update(ship, gap, player);
      if (ship.impact > 0.05) this.impact(ship.impact, ship === player);
    }

    // Music follows the race: busier as the field closes up and on the last lap.
    const entrant = race.playerEntrant;
    if (entrant) {
      const close = race.director.gapAhead(entrant);
      const pressure = close == null ? 0 : clamp01(1 - close / 4);
      const lapFraction = entrant.lap / Math.max(1, race.director.totalLaps);
      this.setIntensity(clamp01(0.3 + lapFraction * 0.4 + pressure * 0.4));
    }
  }

  // ------------------------------------------------------------ one-shots

  countdownBeep(index) {
    if (!this.ready) return;
    const final = index >= 5;
    this.blip(final ? 660 : 440, final ? 0.3 : 0.12, 0.22);
  }

  raceStart() {
    if (!this.ready) return;
    this.blip(880, 0.45, 0.3);
    this.setIntensity(0.55);
  }

  raceFinish() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => this.blip(f, 0.3, 0.5, now + i * 0.12));
    this.setIntensity(0.2);
  }

  lapChime(personalBest) {
    if (!this.ready) return;
    this.blip(personalBest ? 1046.5 : 784, 0.22, 0.26);
    if (personalBest) this.blip(1318.5, 0.18, 0.3, this.ctx.currentTime + 0.1);
  }

  uiMove() {
    this.blip(320, 0.06, 0.05);
  }

  uiSelect() {
    this.blip(520, 0.12, 0.09);
  }

  /** Simple percussive tone, used for every interface and timing sound. */
  blip(frequency, gain = 0.2, duration = 0.12, when = null) {
    if (!this.ready || !Number.isFinite(frequency)) return;
    const ctx = this.ctx;
    const at = when ?? ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(frequency, at);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.86, at + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(env).connect(this.sfxBus);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Barrier or craft contact: a filtered noise burst plus a low thud. */
  impact(strength, isPlayer) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const at = ctx.currentTime;
    const level = clamp(strength, 0, 1) * (isPlayer ? 0.5 : 0.18);
    if (level < 0.01) return;

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900 + strength * 1400, at);
    filter.frequency.exponentialRampToValueAtTime(220, at + 0.3);
    filter.Q.value = 0.9;

    const env = ctx.createGain();
    env.gain.setValueAtTime(level, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);

    noise.connect(filter).connect(env).connect(this.sfxBus);
    noise.start(at);
    noise.stop(at + 0.36);

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(110, at);
    thud.frequency.exponentialRampToValueAtTime(42, at + 0.22);
    const thudEnv = ctx.createGain();
    thudEnv.gain.setValueAtTime(level * 1.2, at);
    thudEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
    thud.connect(thudEnv).connect(this.sfxBus);
    thud.start(at);
    thud.stop(at + 0.28);
  }

  dispose() {
    this.detachRace();
    this.music?.dispose();
    try {
      this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.ready = false;
  }
}

/**
 * One craft's engine.
 *
 * Two detuned sawtooths for the body of the note, a sine an octave down for
 * weight, and filtered noise for the turbine. Pitch and filter cutoff both
 * follow speed, and the noise layer opens up with throttle — which is what
 * makes lifting off audible even when the craft is still travelling fast.
 */
class EngineVoice {
  constructor(ctx, destination, noiseBuffer, isPlayer) {
    this.ctx = ctx;
    this.isPlayer = isPlayer;

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    this.panner = ctx.createStereoPanner?.() ?? null;
    if (this.panner) {
      this.out.connect(this.panner).connect(destination);
    } else {
      this.out.connect(destination);
    }

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.filter.Q.value = 1.1;
    this.filter.connect(this.out);

    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'sawtooth';
    this.oscB.detune.value = 11;
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';

    this.oscGain = ctx.createGain();
    this.oscGain.gain.value = 0.3;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.36;

    this.oscA.connect(this.oscGain);
    this.oscB.connect(this.oscGain);
    this.oscGain.connect(this.filter);
    this.sub.connect(this.subGain).connect(this.out);

    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuffer;
    this.noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 1800;
    this.noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.out);

    const now = ctx.currentTime;
    this.oscA.start(now);
    this.oscB.start(now);
    this.sub.start(now);
    this.noise.start(now);
  }

  update(ship, gap, player) {
    const ctx = this.ctx;
    const at = ctx.currentTime;
    const smoothing = 0.04;

    const speed = clamp01(ship.speed01);
    const boost = ship.boosting ? 1 : 0;

    // Pitch: a wide but musical sweep, lifted further by boost.
    const base = 58 + speed * 150 + boost * 26;
    this.oscA.frequency.setTargetAtTime(base, at, smoothing);
    this.oscB.frequency.setTargetAtTime(base * 1.005, at, smoothing);
    this.sub.frequency.setTargetAtTime(base * 0.5, at, smoothing);

    this.filter.frequency.setTargetAtTime(500 + speed * 3400 + boost * 1200, at, smoothing);

    // Turbine layer opens with throttle and with sliding.
    const air = clamp01(speed * 0.7 + ship.sliding * 0.5 + boost * 0.3);
    this.noiseGain.gain.setTargetAtTime(air * 0.1, at, smoothing);
    this.noiseFilter.frequency.setTargetAtTime(1200 + speed * 3000, at, smoothing);

    // Distance attenuation and stereo placement for rivals.
    let level = this.isPlayer ? 0.26 : 0.16;
    if (!this.isPlayer) {
      const distance = Math.abs(gap);
      level *= clamp01(1 - distance / 90);
      if (this.panner) {
        // Ahead reads centre, alongside reads to the side it is actually on.
        const lateral = clamp((ship.lateral - player.lateral) / 10, -1, 1);
        const behind = gap < 0 ? -0.35 : 0;
        this.panner.pan.setTargetAtTime(clamp(lateral + behind, -1, 1), at, 0.08);
      }
    }
    this.out.gain.setTargetAtTime(level, at, 0.08);
  }

  dispose() {
    const at = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, at, 0.04);
    for (const node of [this.oscA, this.oscB, this.sub, this.noise]) {
      try {
        node.stop(at + 0.2);
      } catch {
        /* already stopped */
      }
    }
  }
}

/**
 * Generative score.
 *
 * A pulse, a bass line and a pad, scheduled a little ahead of the clock. The
 * intensity value opens filters, adds the off-beat and brings in a counter
 * line, so the music tightens as a race does without ever needing a
 * transition or a crossfade.
 */
class MusicBed {
  constructor(ctx, destination, noiseBuffer) {
    this.ctx = ctx;
    this.destination = destination;
    this.noiseBuffer = noiseBuffer;
    this.running = false;
    this.intensity = 0.3;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;

    // A minor, natural. Dark enough for the subject, not so dark it sulks.
    this.scale = [0, 3, 5, 7, 10, 12];
    this.root = 55; // A1
  }

  start() {
    if (this.running || !this.ctx) return;
    this.running = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    // A 25ms scheduler with a 120ms lookahead: far enough ahead to survive a
    // dropped frame, short enough that intensity changes are heard promptly.
    this.timer = setInterval(() => this._schedule(), 25);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  setIntensity(value) {
    this.intensity = value;
  }

  _schedule() {
    if (!this.running) return;
    const ctx = this.ctx;
    const tempo = lerp(104, 138, this.intensity);
    const stepDuration = 60 / tempo / 4;

    while (this.nextTime < ctx.currentTime + 0.12) {
      this._playStep(this.step, this.nextTime, stepDuration);
      this.nextTime += stepDuration;
      this.step++;
    }
  }

  _playStep(step, at, duration) {
    const bar = Math.floor(step / 16) % 4;
    const beat = step % 16;
    const intensity = this.intensity;

    // Kick on 1 and 11, which gives the pattern a forward lean.
    if (beat === 0 || beat === 10) this._kick(at, 0.5 + intensity * 0.3);

    // Hat on every off-beat once the race warms up.
    if (beat % 2 === 1 && intensity > 0.35) this._hat(at, 0.05 + intensity * 0.09);

    // Bass: root, fifth, seventh, walking by bar.
    if (beat % 4 === 0) {
      const degrees = [0, 0, 3, 2];
      const semitone = this.scale[degrees[bar]];
      this._bass(at, this.root * Math.pow(2, semitone / 12), duration * 3.4, 0.22);
    }

    // Counter line, only at higher intensity.
    if (intensity > 0.6 && beat % 8 === 6) {
      // Integer index: a fractional one silently yields undefined, and the
      // resulting NaN frequency throws out of setValueAtTime.
      const degree = (bar + Math.floor(step / 8)) % this.scale.length;
      this._lead(at, this.root * 4 * Math.pow(2, this.scale[degree] / 12), duration * 2.2, 0.07 * intensity);
    }
  }

  _kick(at, gain) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(128, at);
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.1);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain * 0.5, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(env).connect(this.destination);
    osc.start(at);
    osc.stop(at + 0.24);
  }

  _hat(at, gain) {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    source.connect(filter).connect(env).connect(this.destination);
    source.start(at);
    source.stop(at + 0.06);
  }

  _bass(at, frequency, duration, gain) {
    if (!Number.isFinite(frequency) || !Number.isFinite(gain)) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(frequency, at);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(220 + this.intensity * 900, at);
    filter.Q.value = 6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(filter).connect(env).connect(this.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  _lead(at, frequency, duration, gain) {
    if (!Number.isFinite(frequency) || !Number.isFinite(gain)) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(frequency, at);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    osc.connect(filter).connect(env).connect(this.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  dispose() {
    this.stop();
  }
}

/** White noise, used for turbine air, impacts and hi-hats. */
function makeNoiseBuffer(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let value = 0;
  for (let i = 0; i < length; i++) {
    // Slightly low-passed rather than pure white: pure white noise is harsh
    // and sits badly under the engine note.
    value = value * 0.78 + (Math.random() * 2 - 1) * 0.22;
    data[i] = value * 2.4;
  }
  return buffer;
}

export { EngineVoice, MusicBed };
