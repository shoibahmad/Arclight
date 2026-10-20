import { readJSON, writeJSON, remove } from './Storage.js';

/**
 * Career progression: unlocks, records, championship state and lifetime stats.
 *
 * Ghosts live in their own storage keys rather than inside the profile blob.
 * They are by far the largest thing we persist, and a corrupt or oversized
 * ghost must never take the player's unlocks down with it.
 */

const KEY = 'profile';
const GHOST_KEY = (trackId, classId) => `ghost:${trackId}:${classId}`;
const VERSION = 1;

/** Championship points, 1st through 8th — FIA-style, steep at the front. */
export const POINTS_TABLE = [25, 18, 15, 12, 10, 8, 6, 4];

function emptyProfile() {
  return {
    version: VERSION,
    unlocks: {
      ships: ['kestrel', 'vireo'],
      tracks: ['meridian', 'saltflat'],
      classes: ['sprint'],
      cups: ['proving'],
    },
    records: {},
    cups: {},
    career: null,
    stats: {
      races: 0,
      wins: 0,
      podiums: 0,
      distanceMetres: 0,
      topSpeed: 0,
      playSeconds: 0,
      perfectLaps: 0,
    },
  };
}

export class Profile {
  constructor() {
    const stored = readJSON(KEY, null);
    this.data = stored && stored.version === VERSION ? stored : emptyProfile();
    // Merge forward so a profile written by an older build keeps its records
    // but still gains any newly added fields.
    const blank = emptyProfile();
    this.data.unlocks = { ...blank.unlocks, ...this.data.unlocks };
    this.data.stats = { ...blank.stats, ...this.data.stats };
    this.data.records ??= {};
    this.data.cups ??= {};
  }

  save() {
    writeJSON(KEY, this.data);
  }

  // ---------------------------------------------------------------- unlocks

  has(kind, id) {
    return (this.data.unlocks[kind] || []).includes(id);
  }

  unlock(kind, id) {
    const list = this.data.unlocks[kind] || (this.data.unlocks[kind] = []);
    if (list.includes(id)) return false;
    list.push(id);
    this.save();
    return true;
  }

  // ---------------------------------------------------------------- records

  recordKey(trackId, classId) {
    return `${trackId}:${classId}`;
  }

  getRecord(trackId, classId) {
    return this.data.records[this.recordKey(trackId, classId)] || null;
  }

  /**
   * Store a finished session's times.
   * @returns {{lap: boolean, race: boolean}} which records were beaten
   */
  submitTimes(trackId, classId, { bestLap, raceTime } = {}) {
    const key = this.recordKey(trackId, classId);
    const rec = this.data.records[key] || { bestLap: null, bestRace: null };
    const beat = { lap: false, race: false };

    if (Number.isFinite(bestLap) && bestLap > 0 && (rec.bestLap == null || bestLap < rec.bestLap)) {
      rec.bestLap = bestLap;
      beat.lap = true;
    }
    if (Number.isFinite(raceTime) && raceTime > 0 && (rec.bestRace == null || raceTime < rec.bestRace)) {
      rec.bestRace = raceTime;
      beat.race = true;
    }

    this.data.records[key] = rec;
    this.save();
    return beat;
  }

  // ----------------------------------------------------------------- ghosts

  loadGhost(trackId, classId) {
    const raw = readJSON(GHOST_KEY(trackId, classId), null);
    if (!raw || !Array.isArray(raw.samples) || raw.samples.length < Ghost.STRIDE) return null;
    return Ghost.fromJSON(raw);
  }

  saveGhost(trackId, classId, ghost) {
    if (!ghost || ghost.length < 2) return false;
    return writeJSON(GHOST_KEY(trackId, classId), ghost.toJSON());
  }

  clearGhost(trackId, classId) {
    remove(GHOST_KEY(trackId, classId));
  }

  // ------------------------------------------------------------ championship

  startCareer(cupId, classId, entrants) {
    this.data.career = {
      cupId,
      classId,
      raceIndex: 0,
      standings: entrants.map((e) => ({ id: e.id, name: e.name, points: 0, isPlayer: !!e.isPlayer })),
      results: [],
    };
    this.save();
    return this.data.career;
  }

  get career() {
    return this.data.career;
  }

  abandonCareer() {
    this.data.career = null;
    this.save();
  }

  /** Apply one race's finishing order to the active championship. */
  applyRaceResult(order) {
    const career = this.data.career;
    if (!career) return null;

    for (let i = 0; i < order.length; i++) {
      const entry = career.standings.find((s) => s.id === order[i].id);
      if (entry) entry.points += POINTS_TABLE[i] ?? 0;
    }
    career.standings.sort((a, b) => b.points - a.points);
    career.results.push(order.map((o) => o.id));
    career.raceIndex++;
    this.save();
    return career;
  }

  completeCup(cupId, classId, position) {
    const key = `${cupId}:${classId}`;
    const prev = this.data.cups[key];
    if (!prev || position < prev.position) {
      this.data.cups[key] = { position, at: Date.now() };
    }
    this.data.career = null;
    this.save();
  }

  cupResult(cupId, classId) {
    return this.data.cups[`${cupId}:${classId}`] || null;
  }

  // ------------------------------------------------------------------ stats

  addStats(patch) {
    const s = this.data.stats;
    s.races += patch.races || 0;
    s.wins += patch.wins || 0;
    s.podiums += patch.podiums || 0;
    s.distanceMetres += patch.distanceMetres || 0;
    s.playSeconds += patch.playSeconds || 0;
    s.perfectLaps += patch.perfectLaps || 0;
    if ((patch.topSpeed || 0) > s.topSpeed) s.topSpeed = patch.topSpeed;
    this.save();
  }

  reset() {
    this.data = emptyProfile();
    this.save();
  }
}

/**
 * A recorded lap, sampled at a fixed rate and quantised on the way to storage.
 *
 * Full float precision would roughly triple the size for a difference nobody
 * can see on a translucent ghost craft, and localStorage is a scarce ~5MB.
 */
export class Ghost {
  static RATE = 15; // samples per second
  static STRIDE = 7; // x, y, z, yaw, pitch, roll, speed

  constructor(samples = [], lapTime = 0) {
    this.samples = samples;
    this.lapTime = lapTime;
  }

  get length() {
    return Math.floor(this.samples.length / Ghost.STRIDE);
  }

  push(pos, yaw, pitch, roll, speed) {
    this.samples.push(pos.x, pos.y, pos.z, yaw, pitch, roll, speed);
  }

  /** Sample the recording at an arbitrary time, interpolating between frames. */
  sampleAt(time, out) {
    const n = this.length;
    if (n === 0) return false;
    const f = Math.min(Math.max(time * Ghost.RATE, 0), n - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, n - 1);
    const t = f - i0;
    const a = i0 * Ghost.STRIDE;
    const b = i1 * Ghost.STRIDE;
    const s = this.samples;

    out.x = s[a] + (s[b] - s[a]) * t;
    out.y = s[a + 1] + (s[b + 1] - s[a + 1]) * t;
    out.z = s[a + 2] + (s[b + 2] - s[a + 2]) * t;
    // Angles are interpolated the short way round so the craft never spins
    // backwards through a wrap at +/-PI.
    out.yaw = lerpAngle(s[a + 3], s[b + 3], t);
    out.pitch = lerpAngle(s[a + 4], s[b + 4], t);
    out.roll = lerpAngle(s[a + 5], s[b + 5], t);
    out.speed = s[a + 6] + (s[b + 6] - s[a + 6]) * t;
    return true;
  }

  toJSON() {
    const out = new Array(this.samples.length);
    for (let i = 0; i < this.samples.length; i++) {
      const isPos = i % Ghost.STRIDE < 3;
      out[i] = Math.round(this.samples[i] * (isPos ? 100 : 1000)) / (isPos ? 100 : 1000);
    }
    return { v: 1, lapTime: this.lapTime, samples: out };
  }

  static fromJSON(raw) {
    return new Ghost(raw.samples, raw.lapTime || 0);
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
