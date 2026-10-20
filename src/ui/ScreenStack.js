import { TRACKS, TRACK_IDS } from '../data/tracks/index.js';
import { SHIPS, CLASSES, CLASS_IDS, getShip, getClass } from '../data/ships.js';
import { CUPS, CUP_IDS, getCup } from '../data/championships.js';
import { QUALITY_PRESETS } from '../core/Settings.js';
import { keyLabel } from '../core/Input.js';
import { formatLapTime } from '../core/MathUtil.js';
import { POINTS_TABLE } from '../core/Profile.js';

/**
 * Menus.
 *
 * Every screen is described as data — a title and a list of rows — and one
 * renderer turns that into DOM and wires up keyboard, gamepad and mouse. The
 * alternative, a bespoke component per screen, means re-solving focus and
 * navigation six times and getting it subtly different each time.
 *
 * Rows come in three shapes: an action (press to do something), an option (a
 * value you cycle left and right), and static text.
 */

export class ScreenStack {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.current = null;
    this.index = 0;
    this.stack = [];
    this.repeatTimer = 0;
    /** Scratch state the setup screen edits before a race is started. */
    this.setup = {
      trackId: TRACK_IDS[0],
      classId: 'sprint',
      shipId: 'kestrel',
      mode: 'race',
      cupId: CUP_IDS[0],
    };
  }

  get active() {
    return this.current !== null;
  }

  show(name, payload) {
    const builder = SCREENS[name];
    if (!builder) {
      console.warn(`[screens] unknown screen "${name}"`);
      return;
    }
    this.current = { name, payload, def: builder(this.game, this, payload) };
    this.index = this.current.def.items.findIndex((i) => i.type !== 'text');
    if (this.index < 0) this.index = 0;
    this._render();
  }

  /** Re-run the current screen's builder, keeping the cursor where it was. */
  refresh() {
    if (!this.current) return;
    const { name, payload } = this.current;
    const keep = this.index;
    this.current.def = SCREENS[name](this.game, this, payload);
    this.index = Math.min(keep, this.current.def.items.length - 1);
    this._render();
  }

  hide() {
    this.current = null;
    this.root.innerHTML = '';
    this.root.classList.remove('is-open');
  }

  back() {
    const previous = this.stack.pop();
    if (previous) this.show(previous.name, previous.payload);
    else if (this.game.race) this.game.togglePause(false);
    else this.show('main');
  }

  push(name, payload) {
    if (this.current) this.stack.push({ name: this.current.name, payload: this.current.payload });
    this.show(name, payload);
  }

  _render() {
    const def = this.current.def;
    this.root.classList.add('is-open');
    this.root.innerHTML = `
      <section class="screen ${def.wide ? 'screen--wide' : ''}">
        <header class="screen__head">
          ${def.eyebrow ? `<p class="screen__eyebrow caps">${esc(def.eyebrow)}</p>` : ''}
          <h1 class="screen__title">${esc(def.title)}</h1>
          ${def.subtitle ? `<p class="screen__subtitle">${esc(def.subtitle)}</p>` : ''}
        </header>
        ${def.body ? `<div class="screen__body">${def.body}</div>` : ''}
        <ul class="menu"></ul>
        ${def.footer ? `<p class="screen__footer">${esc(def.footer)}</p>` : ''}
      </section>`;

    const list = this.root.querySelector('.menu');
    def.items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = `menu__item menu__item--${item.type ?? 'action'}`;
      if (item.disabled) li.classList.add('is-disabled');

      if (item.type === 'text') {
        li.innerHTML = `<span class="menu__text">${item.html ?? esc(item.label)}</span>`;
      } else if (item.type === 'option') {
        li.innerHTML =
          `<span class="menu__label">${esc(item.label)}</span>` +
          `<span class="menu__value"><i class="menu__arrow">&lsaquo;</i>` +
          `<b>${esc(item.value)}</b><i class="menu__arrow">&rsaquo;</i></span>`;
      } else {
        li.innerHTML =
          `<span class="menu__label">${esc(item.label)}</span>` +
          (item.hint ? `<span class="menu__hint">${esc(item.hint)}</span>` : '');
      }

      if (!item.disabled && item.type !== 'text') {
        li.addEventListener('mouseenter', () => {
          this.index = i;
          this._highlight();
        });
        li.addEventListener('click', (event) => {
          this.index = i;
          // Clicking the arrows on an option row cycles it rather than
          // activating it, which is what the arrows imply.
          const arrow = event.target.closest('.menu__arrow');
          if (arrow && item.type === 'option') {
            const previous = arrow.textContent.includes('‹');
            this._cycle(previous ? -1 : 1);
          } else {
            this._activate();
          }
        });
      }
      list.append(li);
    });

    this._highlight();
  }

  _highlight() {
    const items = [...this.root.querySelectorAll('.menu__item')];
    items.forEach((el, i) => el.classList.toggle('is-active', i === this.index));
    items[this.index]?.scrollIntoView({ block: 'nearest' });
  }

  _move(direction) {
    const items = this.current.def.items;
    for (let step = 0; step < items.length; step++) {
      this.index = (this.index + direction + items.length) % items.length;
      const item = items[this.index];
      if (item.type !== 'text' && !item.disabled) break;
    }
    this._highlight();
  }

  _activate() {
    const item = this.current?.def.items[this.index];
    if (!item || item.disabled) return;
    if (item.type === 'option') this._cycle(1);
    else item.onSelect?.();
  }

  _cycle(direction) {
    const item = this.current?.def.items[this.index];
    if (!item || item.disabled) return;
    item.onCycle?.(direction);
  }

  /** Called from the fixed step, so repeat timing is frame-rate independent. */
  handleInput(input) {
    if (!this.current) return;

    if (input.pressed('uiUp')) this._move(-1);
    if (input.pressed('uiDown')) this._move(1);
    if (input.pressed('uiLeft')) this._cycle(-1);
    if (input.pressed('uiRight')) this._cycle(1);
    if (input.pressed('uiConfirm')) this._activate();
    if (input.pressed('uiBack')) {
      const def = this.current.def;
      if (def.onBack) def.onBack();
      else this.back();
    }
  }

  update() {
    /* screens are event driven; nothing to animate per frame */
  }
}

// ------------------------------------------------------------------ screens

const SCREENS = {
  main(game, stack) {
    const profile = game.profile;
    const stats = profile.data.stats;
    return {
      eyebrow: 'Anti-gravity circuit racing',
      title: 'ARCLIGHT',
      subtitle: 'Ride the line. The line pays for everything else.',
      footer: `${stats.races} races · ${stats.wins} wins · ${Math.round(stats.distanceMetres / 1000)} km`,
      items: [
        {
          label: 'Championship',
          hint: 'Run a cup for points',
          onSelect: () => stack.push('cupSelect'),
        },
        {
          label: 'Quick race',
          hint: 'One race, pick everything',
          onSelect: () => {
            stack.setup.mode = 'race';
            stack.push('setup');
          },
        },
        {
          label: 'Time trial',
          hint: 'Alone, against your ghost',
          onSelect: () => {
            stack.setup.mode = 'timetrial';
            stack.push('setup');
          },
        },
        { label: 'Records', onSelect: () => stack.push('records') },
        { label: 'Settings', onSelect: () => stack.push('settings') },
        { label: 'Controls', onSelect: () => stack.push('controls') },
      ],
      onBack: () => {},
    };
  },

  cupSelect(game, stack) {
    const items = CUP_IDS.map((id) => {
      const cup = getCup(id);
      const unlocked = game.profile.has('cups', id);
      const result = game.profile.cupResult(id, stack.setup.classId);
      return {
        label: cup.name,
        hint: unlocked
          ? result
            ? `Best finish: P${result.position}`
            : `${cup.tracks.length} rounds`
          : 'Locked — win the previous cup',
        disabled: !unlocked,
        onSelect: () => {
          stack.setup.cupId = id;
          stack.setup.mode = 'championship';
          stack.push('setup');
        },
      };
    });

    return {
      eyebrow: 'Championship',
      title: 'Select a cup',
      subtitle: 'Points are awarded 25-18-15-12-10-8-6-4 across every round.',
      items,
    };
  },

  setup(game, stack) {
    const setup = stack.setup;
    const isCup = setup.mode === 'championship';
    const cup = getCup(setup.cupId);
    const unlockedTracks = TRACK_IDS.filter((id) => game.profile.has('tracks', id));
    const unlockedShips = SHIPS.filter((s) => game.profile.has('ships', s.id));
    const unlockedClasses = CLASS_IDS.filter((id) => game.profile.has('classes', id));

    const ship = getShip(setup.shipId);
    const track = TRACKS[setup.trackId];
    const record = game.profile.getRecord(setup.trackId, setup.classId);

    const items = [];

    if (isCup) {
      items.push({
        type: 'text',
        html: `<b>${esc(cup.name)}</b> — ${cup.tracks.map((t) => esc(TRACKS[t]?.name ?? t)).join(' · ')}`,
      });
    } else {
      items.push({
        type: 'option',
        label: 'Circuit',
        value: track?.name ?? setup.trackId,
        onCycle: (d) => {
          setup.trackId = cycle(unlockedTracks, setup.trackId, d);
          stack.refresh();
        },
      });
    }

    items.push(
      {
        type: 'option',
        label: 'Class',
        value: getClass(setup.classId).name,
        onCycle: (d) => {
          setup.classId = cycle(unlockedClasses, setup.classId, d);
          stack.refresh();
        },
      },
      {
        type: 'option',
        label: 'Craft',
        value: ship.name,
        onCycle: (d) => {
          setup.shipId = cycle(unlockedShips.map((s) => s.id), setup.shipId, d);
          stack.refresh();
        },
      },
      {
        label: isCup ? 'Start championship' : 'Start',
        onSelect: () => {
          if (isCup) startChampionship(game, stack);
          else
            game.startRace({
              trackId: setup.trackId,
              classId: setup.classId,
              shipId: setup.shipId,
              mode: setup.mode,
              opponents: setup.mode === 'timetrial' ? 0 : 7,
            });
        },
      }
    );

    const stats = ship.stats;
    const body = `
      <div class="spec">
        <div class="spec__col">
          <h3>${esc(ship.name)}</h3>
          <p class="spec__team">${esc(ship.team)}</p>
          <p class="spec__blurb">${esc(ship.blurb)}</p>
          ${bar('Top speed', stats.topSpeed, 70, 140)}
          ${bar('Thrust', stats.thrust, 30, 56)}
          ${bar('Grip', stats.grip, 1.2, 2.0)}
          ${bar('Agility', stats.agility, 1.0, 1.8)}
          ${bar('Shield', stats.shield, 60, 150)}
          ${bar('Cell charge', stats.charge, 0.8, 1.4)}
        </div>
        <div class="spec__col">
          <h3>${esc(track?.name ?? '')}</h3>
          <p class="spec__team">${esc(track ? `${track.laps} laps · ${describeTheme(track.theme)}` : '')}</p>
          <p class="spec__blurb">${esc(cornerList(track))}</p>
          <dl class="spec__records">
            <dt>Best lap</dt><dd class="numeric">${record?.bestLap ? formatLapTime(record.bestLap) : '--:--.---'}</dd>
            <dt>Best race</dt><dd class="numeric">${record?.bestRace ? formatLapTime(record.bestRace) : '--:--.---'}</dd>
          </dl>
        </div>
      </div>`;

    return {
      wide: true,
      eyebrow: isCup ? 'Championship' : setup.mode === 'timetrial' ? 'Time trial' : 'Quick race',
      title: isCup ? cup.name : 'Race setup',
      subtitle: getClass(setup.classId).description,
      body,
      items,
    };
  },

  pause(game, stack) {
    return {
      eyebrow: 'Paused',
      title: game.race?.track.name ?? 'Paused',
      items: [
        { label: 'Resume', onSelect: () => game.togglePause(false) },
        { label: 'Restart race', onSelect: () => game.restartRace() },
        { label: 'Settings', onSelect: () => stack.push('settings') },
        { label: 'Quit to menu', onSelect: () => game.quitToMenu() },
      ],
      onBack: () => game.togglePause(false),
    };
  },

  results(game, stack, payload) {
    const { results, config } = payload;
    const player = results.find((r) => r.isPlayer);
    const career = game.profile.career;
    const isCup = config.mode === 'championship' && career;

    const rows = results
      .map(
        (r) => `<tr class="${r.isPlayer ? 'is-player' : ''}">
          <td class="numeric">${r.position}</td>
          <td>${esc(r.name)}</td>
          <td class="numeric">${r.retired ? 'DNF' : formatLapTime(r.totalTime)}</td>
          <td class="numeric">${r.bestLap ? formatLapTime(r.bestLap) : '--'}</td>
          ${isCup ? `<td class="numeric">+${POINTS_TABLE[r.position - 1] ?? 0}</td>` : ''}
        </tr>`
      )
      .join('');

    const body = `
      <table class="results">
        <thead><tr><th>#</th><th>Driver</th><th>Time</th><th>Best lap</th>${isCup ? '<th>Pts</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    const items = [];
    if (isCup) {
      items.push({
        label: career.raceIndex >= getCup(career.cupId).tracks.length ? 'Final standings' : 'Next round',
        onSelect: () => advanceChampionship(game, stack, results),
      });
    } else {
      items.push({ label: 'Race again', onSelect: () => game.restartRace() });
    }
    items.push({ label: 'Back to menu', onSelect: () => game.quitToMenu() });

    return {
      wide: true,
      eyebrow: 'Classification',
      title: player ? positionTitle(player.position) : 'Race complete',
      subtitle: `${esc(TRACKS[config.trackId]?.name ?? '')} · ${getClass(config.classId).name}`,
      body,
      items,
      onBack: () => game.quitToMenu(),
    };
  },

  standings(game, stack, payload) {
    const career = payload.career;
    const cup = getCup(career.cupId);
    const rows = career.standings
      .map(
        (s, i) => `<tr class="${s.isPlayer ? 'is-player' : ''}">
          <td class="numeric">${i + 1}</td><td>${esc(s.name)}</td><td class="numeric">${s.points}</td>
        </tr>`
      )
      .join('');

    const done = career.raceIndex >= cup.tracks.length;
    const playerPosition = career.standings.findIndex((s) => s.isPlayer) + 1;

    return {
      wide: true,
      eyebrow: cup.name,
      title: done ? positionTitle(playerPosition, 'championship') : 'Standings',
      subtitle: done ? '' : `Round ${career.raceIndex} of ${cup.tracks.length} complete`,
      body: `<table class="results"><thead><tr><th>#</th><th>Driver</th><th>Points</th></tr></thead><tbody>${rows}</tbody></table>`,
      items: done
        ? [{ label: 'Finish', onSelect: () => finishChampionship(game, stack, playerPosition) }]
        : [
            { label: 'Next round', onSelect: () => startChampionshipRound(game, stack) },
            { label: 'Abandon championship', onSelect: () => {
                game.profile.abandonCareer();
                game.quitToMenu();
              } },
          ],
      onBack: () => {},
    };
  },

  records(game, stack) {
    const rows = [];
    for (const id of TRACK_IDS) {
      const track = TRACKS[id];
      for (const classId of CLASS_IDS) {
        const record = game.profile.getRecord(id, classId);
        if (!record) continue;
        rows.push(`<tr>
          <td>${esc(track.name)}</td>
          <td>${getClass(classId).name}</td>
          <td class="numeric">${record.bestLap ? formatLapTime(record.bestLap) : '--'}</td>
          <td class="numeric">${record.bestRace ? formatLapTime(record.bestRace) : '--'}</td>
        </tr>`);
      }
    }

    const stats = game.profile.data.stats;
    return {
      wide: true,
      eyebrow: 'Career',
      title: 'Records',
      subtitle: `${stats.races} races · ${stats.wins} wins · ${stats.podiums} podiums · top speed ${Math.round(stats.topSpeed * 3.6)} kph`,
      body: rows.length
        ? `<table class="results"><thead><tr><th>Circuit</th><th>Class</th><th>Best lap</th><th>Best race</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
        : '<p class="screen__empty">No times set yet.</p>',
      items: [{ label: 'Back', onSelect: () => stack.back() }],
    };
  },

  settings(game, stack) {
    const s = game.settings;
    const percent = (v) => `${Math.round(v * 100)}%`;
    const option = (label, value, onCycle) => ({ type: 'option', label, value, onCycle });
    const bump = (key, step, lo, hi) => (d) => {
      s.set(key, Math.min(hi, Math.max(lo, +(s.get(key) + d * step).toFixed(2))));
      stack.refresh();
    };

    return {
      eyebrow: 'Options',
      title: 'Settings',
      items: [
        option('Quality', QUALITY_PRESETS[s.get('quality')].label, (d) => {
          s.set('quality', cycle(Object.keys(QUALITY_PRESETS), s.get('quality'), d));
          stack.refresh();
        }),
        option('Render scale', percent(s.get('renderScale')), bump('renderScale', 0.05, 0.5, 1)),
        option('Field of view', `${Math.round(s.get('fov'))}`, bump('fov', 2, 60, 100)),
        option('Camera', s.get('cameraMode').toUpperCase(), (d) => {
          s.set('cameraMode', cycle(['chase', 'close', 'cockpit'], s.get('cameraMode'), d));
          stack.refresh();
        }),
        option('Screen shake', percent(s.get('shake') / 1.5), bump('shake', 0.1, 0, 1.5)),
        option('Lens aberration', s.get('chromaticAberration') ? 'ON' : 'OFF', () => {
          s.set('chromaticAberration', !s.get('chromaticAberration'));
          stack.refresh();
        }),
        option('Show arcline', s.get('showRacingLine') ? 'ON' : 'OFF', () => {
          s.set('showRacingLine', !s.get('showRacingLine'));
          stack.refresh();
        }),
        option('Show ghost', s.get('showGhost') ? 'ON' : 'OFF', () => {
          s.set('showGhost', !s.get('showGhost'));
          stack.refresh();
        }),
        option('Units', s.get('units').toUpperCase(), (d) => {
          s.set('units', cycle(['kph', 'mph'], s.get('units'), d));
          stack.refresh();
        }),
        option('Master volume', percent(s.get('masterVolume')), bump('masterVolume', 0.05, 0, 1)),
        option('Music', percent(s.get('musicVolume')), bump('musicVolume', 0.05, 0, 1)),
        option('Effects', percent(s.get('sfxVolume')), bump('sfxVolume', 0.05, 0, 1)),
        { label: 'Back', onSelect: () => stack.back() },
      ],
    };
  },

  controls(game, stack) {
    const bindings = game.settings.get('bindings');
    const row = (action, label) => ({
      label,
      hint: (bindings[action] || []).map(keyLabel).join('  /  '),
      onSelect: () => {
        const item = stack.current.def.items[stack.index];
        item.hint = 'press a key…';
        stack._render();
        game.input.beginCapture(action, (boundAction, code) => {
          game.settings.bind(boundAction, code, 0);
          stack.refresh();
        });
      },
    });

    return {
      wide: true,
      eyebrow: 'Options',
      title: 'Controls',
      subtitle: 'Select a row and press a key to rebind. A gamepad works without setup.',
      items: [
        row('throttle', 'Thrust'),
        row('brake', 'Brake'),
        row('steerLeft', 'Steer left'),
        row('steerRight', 'Steer right'),
        row('airbrakeLeft', 'Left air brake'),
        row('airbrakeRight', 'Right air brake'),
        row('boost', 'Boost'),
        row('shield', 'Shield'),
        row('lookBack', 'Look back'),
        row('restart', 'Restart (time trial)'),
        {
          label: 'Reset to defaults',
          onSelect: () => {
            game.settings.resetBindings();
            stack.refresh();
          },
        },
        { label: 'Back', onSelect: () => stack.back() },
      ],
      onBack: () => {
        game.input.cancelCapture();
        stack.back();
      },
    };
  },
};

// ------------------------------------------------------------- championship

function startChampionship(game, stack) {
  const cup = getCup(stack.setup.cupId);
  const entrants = [{ id: 'player', name: 'YOU', isPlayer: true }];
  for (let i = 0; i < 7; i++) {
    entrants.push({ id: `ai-${i}`, name: FIELD_NAMES[i % FIELD_NAMES.length], isPlayer: false });
  }
  game.profile.startCareer(cup.id, stack.setup.classId, entrants);
  startChampionshipRound(game, stack);
}

function startChampionshipRound(game, stack) {
  const career = game.profile.career;
  if (!career) return game.quitToMenu();
  const cup = getCup(career.cupId);
  const trackId = cup.tracks[career.raceIndex];
  if (!trackId) return game.quitToMenu();

  game.startRace({
    trackId,
    classId: career.classId,
    shipId: stack.setup.shipId,
    mode: 'championship',
    opponents: 7,
  });
}

function advanceChampionship(game, stack, results) {
  const order = results.map((r) => ({
    id: r.isPlayer ? 'player' : `ai-${results.filter((x) => !x.isPlayer).indexOf(r)}`,
  }));
  const career = game.profile.applyRaceResult(order);
  game.endRace();
  stack.show('standings', { career });
}

function finishChampionship(game, stack, position) {
  const career = game.profile.career;
  if (career) {
    game.profile.completeCup(career.cupId, career.classId, position);
    // Winning a cup opens the next one, its circuits, and eventually the
    // faster class — the only progression gates in the game.
    const cup = getCup(career.cupId);
    if (position <= 3 && cup.unlocks) {
      for (const [kind, ids] of Object.entries(cup.unlocks)) {
        for (const id of ids) game.profile.unlock(kind, id);
      }
    }
  }
  game.quitToMenu();
}

const FIELD_NAMES = [
  'R. Almeida',
  'K. Sørvik',
  'T. Okonkwo',
  'M. Ferreira',
  'J. Lindqvist',
  'A. Pradhan',
  'D. Marchetti',
  'S. Beaumont',
];

// -------------------------------------------------------------- helpers

function cycle(list, value, direction) {
  if (!list.length) return value;
  const i = list.indexOf(value);
  const next = (i + direction + list.length) % list.length;
  return list[next];
}

function bar(label, value, lo, hi) {
  const fill = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return `<div class="statbar"><span>${esc(label)}</span><i><b style="transform:scaleX(${fill.toFixed(3)})"></b></i></div>`;
}

function positionTitle(position, what = 'race') {
  if (position === 1) return what === 'race' ? 'Race won' : 'Champion';
  if (position === 2) return 'Second';
  if (position === 3) return 'Third';
  return `Finished ${ordinal(position)}`;
}

function ordinal(n) {
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10 > 3 ? 0 : n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function describeTheme(id) {
  return { ridge: 'High desert', nocturne: 'Night city', hollow: 'Glacier' }[id] ?? id;
}

function cornerList(track) {
  if (!track) return '';
  const names = track.segments.filter((s) => s.turn != null && s.name).map((s) => s.name);
  return names.join(' · ');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

export { SCREENS };
