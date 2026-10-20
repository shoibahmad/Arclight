/**
 * Craft roster.
 *
 * Four frames, each a different answer to the same question: the cell is the
 * only resource, and it pays for boost, shields and air brakes alike. A craft
 * that charges quickly can afford to be clumsy; one that charges slowly has to
 * be driven on the arcline.
 *
 * Stat units:
 *   topSpeed   m/s at full throttle on the flat, in Sprint class
 *   thrust     m/s^2 of acceleration available at a standstill
 *   grip       peak lateral acceleration, as a multiple of g
 *   agility    peak yaw rate in radians/second at low speed
 *   mass       scales impact severity and how much a nudge moves the craft
 *   shield     integrity points; a hard wall strike costs roughly 20
 *   cell       capacity in units; boost burns ~28/s, shields ~22/s
 *   charge     multiplier on arcline charge rate
 */

export const SHIPS = [
  {
    id: 'kestrel',
    name: 'Kestrel',
    team: 'Vantor Dynamics',
    blurb:
      'The reference frame every other team is measured against. Nothing it does is remarkable, and nothing it does will surprise you halfway through a corner.',
    stats: {
      topSpeed: 118,
      thrust: 44,
      grip: 1.55,
      agility: 1.35,
      mass: 1.0,
      shield: 100,
      cell: 100,
      charge: 1.0,
    },
    colours: { hull: 0xd8dde4, trim: 0x2a3340, accent: 0x40e0ff, thruster: 0x7fe8ff },
  },
  {
    id: 'vireo',
    name: 'Vireo',
    team: 'Halsey Kestner',
    blurb:
      'Built for drivers who would rather not think about the cell. Charges fast and holds the road, but it runs out of top end on anything with a long straight.',
    stats: {
      topSpeed: 108,
      thrust: 47,
      grip: 1.82,
      agility: 1.5,
      mass: 0.92,
      shield: 95,
      cell: 115,
      charge: 1.3,
    },
    colours: { hull: 0x7fe3b0, trim: 0x16302a, accent: 0x52e39b, thruster: 0x9effc8 },
  },
  {
    id: 'mantis',
    name: 'Mantis',
    team: 'Orbital Sable',
    blurb:
      'Quickest thing on the grid in a straight line and the least forgiving everywhere else. Thin shielding, a greedy cell, and a nose that will rotate further than you asked.',
    stats: {
      topSpeed: 132,
      thrust: 52,
      grip: 1.38,
      agility: 1.72,
      mass: 0.85,
      shield: 72,
      cell: 92,
      charge: 0.85,
    },
    colours: { hull: 0x2b2f3a, trim: 0xff3d7f, accent: 0xff3d7f, thruster: 0xff7ab0 },
  },
  {
    id: 'oriole',
    name: 'Oriole',
    team: 'Brevik Foundry',
    blurb:
      'Heavy, stubborn, and almost impossible to put out of a race. It will not win a drag race, but it is still there on the last lap when the Mantis is limping.',
    stats: {
      topSpeed: 114,
      thrust: 39,
      grip: 1.66,
      agility: 1.12,
      mass: 1.25,
      shield: 140,
      cell: 108,
      charge: 1.1,
    },
    colours: { hull: 0xe0a24a, trim: 0x3a2a18, accent: 0xffb347, thruster: 0xffd089 },
  },
];

export const SHIP_IDS = SHIPS.map((s) => s.id);

export function getShip(id) {
  return SHIPS.find((s) => s.id === id) ?? SHIPS[0];
}

/**
 * Speed classes.
 *
 * Apex is not simply "everything faster" — grip rises more slowly than speed
 * does, so the same corner that was flat out in Sprint needs a genuine lift.
 * That is what makes the second class feel like a different circuit rather
 * than the same one on fast-forward.
 */
export const CLASSES = {
  sprint: {
    id: 'sprint',
    name: 'Sprint',
    speed: 1.0,
    thrust: 1.0,
    grip: 1.0,
    agility: 1.0,
    aiSkill: 0.82,
    description: 'Opening class. Wide margins, forgiving cell economy.',
  },
  apex: {
    id: 'apex',
    name: 'Apex',
    speed: 1.22,
    thrust: 1.18,
    grip: 1.09,
    agility: 0.94,
    aiSkill: 0.93,
    description: 'Everything arrives sooner and the grip has not kept up.',
  },
};

export const CLASS_IDS = Object.keys(CLASSES);

export function getClass(id) {
  return CLASSES[id] ?? CLASSES.sprint;
}

/** Stats with the class multipliers folded in. */
export function resolveStats(shipId, classId) {
  const ship = getShip(shipId);
  const cls = getClass(classId);
  const s = ship.stats;
  return {
    topSpeed: s.topSpeed * cls.speed,
    thrust: s.thrust * cls.thrust,
    grip: s.grip * cls.grip,
    agility: s.agility * cls.agility,
    mass: s.mass,
    shield: s.shield,
    cell: s.cell,
    charge: s.charge,
  };
}
