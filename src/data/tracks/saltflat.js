/**
 * Saltflat Run — the fast one.
 *
 * Almost no slow corners. Two long full-throttle sections separated by
 * high-speed sweepers that are flat in Sprint and emphatically not flat in
 * Apex. The cell economy is the whole challenge here: the arcline on a
 * 95-degree sweeper at 400kph is a thread, and drifting a metre wide for
 * three seconds is the difference between arriving at Saltpan with boost and
 * arriving without it.
 */
export default {
  id: 'saltflat',
  name: 'Saltflat Run',
  theme: 'ridge',
  laps: 3,
  parLap: 58,
  layout: {
    start: [0, 0, 0],
    heading: 0,
    width: 26,
  },
  segments: [
    { straight: 620, name: 'Pan straight', width: 26 },
    { turn: 90, radius: 210, bank: 12, name: 'Saltpan' },
    { straight: 180, rise: 7, width: 24 },
    { turn: 80, radius: 240, bank: 11, name: 'Long Bend' },
    { straight: 300, rise: 5 },
    { turn: -40, radius: 220, bank: -7, name: 'Mirage' },
    { straight: 240, width: 23 },
    { turn: 70, radius: 185, bank: 13, name: 'Shimmer' },
    { straight: 150, rise: -6 },
    { turn: 95, radius: 130, bank: 16, name: 'The Scald' },
    { straight: 420, rise: -6, width: 26 },
    { turn: -35, radius: 260, name: 'Driftwood' },
    { straight: 200 },
    { turn: 100, radius: 160, bank: 14, name: 'Homeward' },
  ],
};
