/**
 * Meridian Flats — the introductory circuit.
 *
 * Deliberately forgiving: wide, mostly fast, and every corner is visible from
 * the one before it. The only real commitment is Sandshelf, a double-apex left
 * that rewards lifting early far more than it rewards braking late. The
 * hairpin at Kiln is the one place a new player will lose the back end, and it
 * sits at the end of the longest straight so the mistake is cheap.
 */
export default {
  id: 'meridian',
  name: 'Meridian Flats',
  theme: 'ridge',
  laps: 3,
  /** Rough lap time at Sprint class, used to seed AI pacing before any data. */
  parLap: 62,
  layout: {
    start: [0, 0, 0],
    heading: 0,
    width: 24,
  },
  segments: [
    { straight: 480, name: 'Main straight', width: 24 },
    { turn: 80, radius: 150, bank: 10, rise: 6, name: 'Copperline' },
    { straight: 160, rise: 8, width: 22 },
    { turn: 55, radius: 200, bank: 7, name: 'Longwall' },
    { straight: 120 },
    { turn: -40, radius: 140, bank: -6, rise: -4, name: 'The Kink' },
    { straight: 200, width: 21 },
    { turn: 50, radius: 170, bank: 8, name: 'Sandshelf entry' },
    { straight: 140, rise: -6 },
    { turn: 90, radius: 110, bank: 13, name: 'Sandshelf' },
    { straight: 260, rise: -4, width: 23 },
    { turn: -35, radius: 160, bank: -5, name: 'Driftline' },
    { straight: 110 },
    { turn: 65, radius: 130, bank: 10, name: 'Ironpost' },
    { straight: 180, width: 20 },
    { turn: 60, radius: 75, bank: 15, name: 'Kiln' },
    { straight: 150, rise: 4 },
    { turn: -25, radius: 200, name: 'Lowline' },
    { straight: 130, width: 24 },
    { turn: 60, radius: 145, bank: 8, rise: -4, name: 'Final sweep' },
  ],
};
