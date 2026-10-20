/**
 * Vaskr Hollow — the flowing one.
 *
 * Carved through a glacier, so the barriers are ice and the light comes off
 * the surface as much as out of the sky. Long linked sweepers that never
 * quite settle, which makes the arcline unusually valuable: there is almost
 * nowhere to recharge in a straight line, so the cell has to be earned in the
 * corners themselves.
 *
 * Like Lowtown, built as two halves of 180 degrees each so the loop closes
 * without the builder having to stretch anything. Unlike Lowtown, the two
 * halves are very different in character — the first is open and fast, the
 * second tightens all the way to Cathedral.
 */
export default {
  id: 'vaskr',
  name: 'Vaskr Hollow',
  theme: 'hollow',
  laps: 3,
  parLap: 60,
  layout: {
    start: [0, 0, 0],
    heading: 0,
    width: 22,
  },
  segments: [
    { straight: 380, name: 'Moraine straight', width: 22 },
    { turn: 75, radius: 165, bank: 11, rise: 8, name: 'Crevasse' },
    { straight: 200, rise: 6, width: 21 },
    { turn: 85, radius: 190, bank: 12, name: 'Blue Hollow' },
    { straight: 160, rise: -5 },
    { turn: -40, radius: 170, bank: -8, name: 'Serac' },
    { straight: 220, width: 20 },
    { turn: 60, radius: 150, bank: 13, rise: -6, name: 'Icefall' },

    { straight: 260, rise: 4, width: 22 },
    { turn: 90, radius: 140, bank: 14, name: 'The Throat' },
    { straight: 190, rise: -7, width: 21 },
    { turn: -35, radius: 195, bank: -6, name: 'Meltwater' },
    { straight: 150 },
    { turn: 65, radius: 160, bank: 10, name: 'Glass Bend' },
    { straight: 230, rise: 0, width: 22 },
    { turn: 60, radius: 165, bank: 13, name: 'Cathedral' },
  ],
};
