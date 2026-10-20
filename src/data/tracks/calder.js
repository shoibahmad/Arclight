/**
 * Calder Shelf — the vertical one.
 *
 * Climbs sixty metres over the first half of the lap and gives it all back in
 * two drops. Grade matters here in a way it does not elsewhere: the craft is
 * genuinely light over the crest at Overhang, grip falls away with it, and
 * the corner on the far side arrives before the suspension has settled.
 * Shield discipline is the difference between finishing and not.
 */
export default {
  id: 'calder',
  name: 'Calder Shelf',
  theme: 'hollow',
  laps: 3,
  parLap: 66,
  layout: {
    start: [0, 0, 0],
    heading: 0,
    width: 23,
  },
  segments: [
    { straight: 420, rise: 10, name: 'Shelf straight', width: 23 },
    { turn: 80, radius: 150, bank: 12, rise: 14, name: 'Ascent' },
    { straight: 230, rise: 16, width: 21 },
    { turn: -25, radius: 220, rise: 8, name: 'Ledge kink' },
    { straight: 180, rise: 12 },
    { turn: 95, radius: 125, bank: 14, name: 'Overhang' },
    { straight: 200, rise: -18, width: 22 },
    { turn: 70, radius: 170, bank: 11, rise: -10, name: 'The Drop' },
    { straight: 260, rise: -14 },
    { turn: -30, radius: 240, name: 'Runout' },
    { straight: 150 },
    { turn: 105, radius: 115, bank: 16, name: 'Basin' },
    { straight: 280, rise: -8, width: 24 },
    { turn: -35, radius: 200, bank: -6, name: 'Scree' },
    { straight: 190 },
    { turn: 100, radius: 145, bank: 12, name: 'Return' },
  ],
};
