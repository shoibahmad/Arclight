/**
 * Championships.
 *
 * Three cups of increasing length, each unlocking the next along with the
 * circuits and craft it introduces. The Apex class is held back until the
 * second cup is on the podium, so a player meets every circuit at the slower
 * speed before meeting it again at the faster one — which is the only reason
 * the second class feels like new content rather than a difficulty slider.
 */

export const CUPS = [
  {
    id: 'proving',
    name: 'Proving Cup',
    blurb: 'Two rounds across the flats. Somewhere to learn the line.',
    tracks: ['meridian', 'saltflat'],
    unlocks: {
      cups: ['nocturne'],
      tracks: ['lowtown', 'harbour'],
      ships: ['mantis'],
    },
  },
  {
    id: 'nocturne',
    name: 'Nocturne Cup',
    blurb: 'Three rounds after dark. Narrow, walled, and unforgiving of a wide exit.',
    tracks: ['lowtown', 'harbour', 'meridian'],
    unlocks: {
      cups: ['summit'],
      tracks: ['vaskr', 'calder'],
      ships: ['oriole'],
      classes: ['apex'],
    },
  },
  {
    id: 'summit',
    name: 'Summit Cup',
    blurb: 'All six circuits. Everything you have learned, in one sitting.',
    tracks: ['vaskr', 'calder', 'saltflat', 'lowtown', 'harbour', 'meridian'],
    unlocks: {},
  },
];

export const CUP_IDS = CUPS.map((c) => c.id);

export function getCup(id) {
  return CUPS.find((c) => c.id === id) ?? CUPS[0];
}
