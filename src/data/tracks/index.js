import meridian from './meridian.js';
import saltflat from './saltflat.js';
import lowtown from './lowtown.js';
import harbour from './harbour.js';
import vaskr from './vaskr.js';
import calder from './calder.js';

/**
 * Track registry.
 *
 * Imported statically rather than loaded on demand: the whole point of this
 * build is that it runs from a clean clone with no network and no bundler, so
 * there is no loader to hide a dynamic import behind, and the combined data
 * is a few kilobytes.
 */
const ALL = [meridian, saltflat, lowtown, harbour, vaskr, calder];

export const TRACKS = Object.fromEntries(ALL.map((t) => [t.id, t]));
export const TRACK_IDS = ALL.map((t) => t.id);

export function loadTrack(id) {
  return TRACKS[id] ?? null;
}

/** Tracks grouped by the environment they use, for menu presentation. */
export function tracksByTheme() {
  const grouped = new Map();
  for (const track of ALL) {
    if (!grouped.has(track.theme)) grouped.set(track.theme, []);
    grouped.get(track.theme).push(track);
  }
  return grouped;
}
