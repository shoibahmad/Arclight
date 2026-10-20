/**
 * localStorage that cannot throw.
 *
 * Private-browsing modes, disabled storage and quota errors all surface as
 * exceptions from perfectly ordinary calls. A racing game losing its best-lap
 * table is a nuisance; a racing game crashing on boot because of it is a bug.
 */

const PREFIX = 'arclight:';

let backing = null;
try {
  const probe = `${PREFIX}__probe`;
  window.localStorage.setItem(probe, '1');
  window.localStorage.removeItem(probe);
  backing = window.localStorage;
} catch {
  console.warn('[storage] localStorage unavailable — progress will not persist this session');
}

/** In-memory stand-in so the rest of the game behaves identically either way. */
const memory = new Map();

export function readJSON(key, fallback = null) {
  const full = PREFIX + key;
  try {
    const raw = backing ? backing.getItem(full) : memory.get(full);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    // Corrupt entry — discard rather than wedge the player out of the game.
    remove(key);
    return fallback;
  }
}

export function writeJSON(key, value) {
  const full = PREFIX + key;
  try {
    const raw = JSON.stringify(value);
    if (backing) backing.setItem(full, raw);
    else memory.set(full, raw);
    return true;
  } catch (err) {
    console.warn(`[storage] could not persist "${key}"`, err);
    return false;
  }
}

export function remove(key) {
  const full = PREFIX + key;
  try {
    if (backing) backing.removeItem(full);
    else memory.delete(full);
  } catch {
    /* nothing useful to do */
  }
}

export const isPersistent = () => backing !== null;
