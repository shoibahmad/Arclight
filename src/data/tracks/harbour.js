/**
 * Harbour Mile — the drag strip.
 *
 * Four corners, two of them nearly flat, and the longest straight in the
 * game. Everything here is about terminal velocity and what you are willing
 * to spend to get there: a Mantis on full boost down the Mile is the fastest
 * thing in Arclight, and it arrives at Dockhead with an empty cell and no
 * shield. The Oriole arrives slower and still has both.
 */
export default {
  id: 'harbour',
  name: 'Harbour Mile',
  theme: 'nocturne',
  laps: 3,
  parLap: 64,
  layout: {
    start: [0, 0, 0],
    heading: 0,
    width: 25,
  },
  segments: [
    { straight: 980, name: 'The Mile', width: 25 },
    { turn: 90, radius: 175, bank: 14, name: 'Dockhead' },
    { straight: 340, rise: 9, width: 24 },
    { turn: 90, radius: 200, bank: 12, name: 'Crane Turn' },
    { straight: 260, rise: -4 },
    { turn: -30, radius: 300, name: 'Seawall' },
    { straight: 420, width: 26 },
    { turn: 90, radius: 155, bank: 15, name: 'Quayside' },
    { straight: 300, rise: -5 },
    { turn: 90, radius: 185, bank: 12, name: 'Bollard' },
    { straight: 240 },
    { turn: -30, radius: 280, name: 'Slipway' },
    { straight: 180 },
    { turn: 60, radius: 165, bank: 10, name: 'Harbour gate' },
  ],
};
