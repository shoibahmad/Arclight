/**
 * Lowtown Spiral — the technical one.
 *
 * Narrow, walled, and relentless. Ten corners in under two and a half
 * kilometres with barely a straight long enough to recharge properly, so the
 * cell is spent almost as fast as it is earned and a clean lap matters more
 * than a brave one. The Stack is the signature: a tightening left taken blind
 * over a crest, with a wall on the exit for anyone who carried too much in.
 *
 * Laid out as two near-mirrored halves, each turning 180 degrees. A circuit
 * built that way closes on itself almost exactly, which leaves the layout
 * builder nothing to correct and means the corners here are the radii that
 * were actually written down. The halves are deliberately not identical —
 * the second is tighter and shorter — so it still drives as two different
 * pieces of road.
 */
export default {
  id: 'lowtown',
  name: 'Lowtown Spiral',
  theme: 'nocturne',
  laps: 4,
  parLap: 47,
  layout: {
    start: [0, 0, 0],
    heading: 0,
    width: 19,
  },
  segments: [
    { straight: 300, name: 'Market straight', width: 19 },
    { turn: 80, radius: 95, bank: 12, name: 'Cutters' },
    { straight: 120, rise: 5, width: 18 },
    { turn: -20, radius: 150, name: 'Gantry kink' },
    { straight: 95 },
    { turn: 70, radius: 100, bank: 10, name: 'Transom' },
    { straight: 140, rise: 4 },
    { turn: -15, radius: 180, name: 'Siding' },
    { straight: 110, width: 17 },
    { turn: 65, radius: 88, bank: 15, name: 'The Stack' },

    { straight: 270, rise: -6, width: 19 },
    { turn: 90, radius: 86, bank: 14, name: 'Hook' },
    { straight: 105, width: 18 },
    { turn: -25, radius: 140, name: 'Underpass' },
    { straight: 110 },
    { turn: 60, radius: 112, bank: 9, name: 'Nightside' },
    { straight: 125, rise: -3 },
    { turn: -10, radius: 190, name: 'Lamprow' },
    { straight: 130, width: 19 },
    { turn: 65, radius: 80, bank: 16, name: 'Reversal' },
  ],
};
