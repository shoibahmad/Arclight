import { formatLapTime, formatDelta, clamp01, lerp } from '../core/MathUtil.js';
import { CHARGE_TOLERANCE } from '../track/Arcline.js';

/**
 * In-race HUD.
 *
 * Built from DOM rather than drawn into the 3D scene. Text in a WebGL canvas
 * either needs a glyph atlas or ends up as blurry textured quads, and the one
 * thing a racing HUD cannot be is hard to read at a glance. The minimap is the
 * exception — it is a 2D canvas, because it is a few hundred line segments
 * redrawn every frame.
 *
 * The whole thing is written to avoid per-frame DOM churn: every element is
 * created once, and `update` only assigns textContent or a transform when the
 * value has actually changed. Setting textContent on twenty nodes at 144Hz is
 * enough to show up in a profile.
 */

const MINIMAP_SIZE = 150;

export class Hud {
  constructor(root, settings) {
    this.root = root;
    this.settings = settings;
    this.race = null;
    this.visible = false;
    this._cache = new Map();
    this._messageTimer = 0;

    root.innerHTML = TEMPLATE;
    this.el = {
      speed: root.querySelector('[data-hud=speed]'),
      speedUnit: root.querySelector('[data-hud=speed-unit]'),
      cellFill: root.querySelector('[data-hud=cell-fill]'),
      cellValue: root.querySelector('[data-hud=cell-value]'),
      hullFill: root.querySelector('[data-hud=hull-fill]'),
      position: root.querySelector('[data-hud=position]'),
      positionTotal: root.querySelector('[data-hud=position-total]'),
      lap: root.querySelector('[data-hud=lap]'),
      lapTotal: root.querySelector('[data-hud=lap-total]'),
      currentTime: root.querySelector('[data-hud=current-time]'),
      bestTime: root.querySelector('[data-hud=best-time]'),
      lastTime: root.querySelector('[data-hud=last-time]'),
      delta: root.querySelector('[data-hud=delta]'),
      lineBar: root.querySelector('[data-hud=line-bar]'),
      lineMark: root.querySelector('[data-hud=line-mark]'),
      chargeGlow: root.querySelector('[data-hud=charge-glow]'),
      message: root.querySelector('[data-hud=message]'),
      gapAhead: root.querySelector('[data-hud=gap-ahead]'),
      gapBehind: root.querySelector('[data-hud=gap-behind]'),
      boost: root.querySelector('[data-hud=boost]'),
      shield: root.querySelector('[data-hud=shield]'),
      tower: root.querySelector('[data-hud=tower]'),
      countdown: root.querySelector('[data-hud=countdown]'),
    };

    this.minimap = root.querySelector('[data-hud=minimap]');
    this.minimap.width = MINIMAP_SIZE * 2;
    this.minimap.height = MINIMAP_SIZE * 2;
    this.ctx = this.minimap.getContext('2d');
    this._outline = null;
    this._towerRows = [];
  }

  attach(race) {
    this.race = race;
    this._outline = race.track.minimapOutline(4);
    this._cache.clear();
    this._buildTower(race);
    this.el.lapTotal.textContent = String(race.director.totalLaps);
    this.el.positionTotal.textContent = String(race.ships.length);
    this.root.classList.toggle('hud--timetrial', race.mode === 'timetrial');
  }

  detach() {
    this.race = null;
    this._towerRows = [];
    this.el.tower.innerHTML = '';
  }

  setVisible(visible) {
    this.visible = visible;
    this.root.classList.toggle('is-visible', visible);
    this.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  _buildTower(race) {
    this.el.tower.innerHTML = '';
    this._towerRows = race.ships.map((ship) => {
      const row = document.createElement('li');
      row.className = 'tower__row';
      if (ship.isPlayer) row.classList.add('is-player');
      row.innerHTML =
        '<span class="tower__pos numeric"></span>' +
        '<span class="tower__name"></span>' +
        '<span class="tower__gap numeric"></span>';
      this.el.tower.append(row);
      return {
        row,
        pos: row.querySelector('.tower__pos'),
        name: row.querySelector('.tower__name'),
        gap: row.querySelector('.tower__gap'),
        ship,
      };
    });
  }

  /** Only touch the DOM when a value has actually changed. */
  _set(element, value) {
    if (!element) return;
    if (this._cache.get(element) === value) return;
    this._cache.set(element, value);
    element.textContent = value;
  }

  _style(element, property, value) {
    if (!element) return;
    const key = `${property}`;
    const store = this._cache.get(element) ?? {};
    if (store[key] === value) return;
    store[key] = value;
    this._cache.set(element, store);
    element.style.setProperty(property, value);
  }

  flashMessage(text, duration = 1200) {
    this.el.message.textContent = text;
    this.el.message.classList.add('is-shown');
    this._messageTimer = duration / 1000;
  }

  announceLap(entrant, lapTime, personalBest) {
    this._set(this.el.lastTime, formatLapTime(lapTime));
    if (personalBest) this.flashMessage('PERSONAL BEST', 1400);
  }

  update(dt, race) {
    if (!this.visible || !race) return;
    const player = race.player;
    const entrant = race.playerEntrant;
    const director = race.director;

    // Speed
    const mph = this.settings.get('units') === 'mph';
    const speed = Math.max(0, player.speed) * (mph ? 2.23694 : 3.6);
    this._set(this.el.speed, String(Math.round(speed)).padStart(3, '0'));
    this._set(this.el.speedUnit, mph ? 'MPH' : 'KPH');

    // Cell and hull
    const cell = player.energy01;
    this._style(this.el.cellFill, 'transform', `scaleX(${cell.toFixed(3)})`);
    this._set(this.el.cellValue, String(Math.round(cell * 100)));
    this.el.cellFill.classList.toggle('is-low', cell < 0.2);
    this._style(this.el.hullFill, 'transform', `scaleX(${player.integrity01.toFixed(3)})`);
    this.el.hullFill.classList.toggle('is-low', player.integrity01 < 0.3);

    // Arcline tracking: a sliding marker, plus a glow when charging.
    const offset = clamp01(Math.abs(player.lineError) / (CHARGE_TOLERANCE * 1.6));
    const side = Math.sign(player.lineError) || 1;
    this._style(this.el.lineMark, 'transform', `translateX(${(side * offset * 50).toFixed(1)}px)`);
    this._style(this.el.chargeGlow, 'opacity', player.chargeRate01.toFixed(2));
    this.el.lineBar.classList.toggle('is-charging', player.chargeRate01 > 0.05);

    // Timing
    if (entrant) {
      const lapTime = director.running ? director.clock - entrant.currentLapStart : 0;
      this._set(this.el.currentTime, formatLapTime(lapTime));
      this._set(this.el.bestTime, entrant.bestLap ? formatLapTime(entrant.bestLap) : '--:--.---');
      this._set(this.el.position, String(entrant.position));
      this._set(this.el.lap, String(Math.min(entrant.lap, director.totalLaps)));

      if (race.mode === 'timetrial') {
        const delta = race.ghostDelta();
        if (delta == null) {
          this._set(this.el.delta, '');
          this.el.delta.className = 'hud__delta numeric';
        } else {
          this._set(this.el.delta, formatDelta(delta));
          this.el.delta.className = `hud__delta numeric ${delta <= 0 ? 'is-ahead' : 'is-behind'}`;
        }
      } else {
        const ahead = director.gapAhead(entrant);
        const behind = director.gapBehind(entrant);
        this._set(this.el.gapAhead, ahead == null ? '' : `-${ahead.toFixed(1)}`);
        this._set(this.el.gapBehind, behind == null ? '' : `+${behind.toFixed(1)}`);
      }
    }

    // Boost / shield pips
    this.el.boost.classList.toggle('is-active', player.boosting);
    this.el.shield.classList.toggle('is-active', player.shielding);

    // Countdown
    if (director.state === 'countdown') {
      const remaining = Math.ceil(director.countdown);
      this._set(this.el.countdown, remaining > 0 ? String(remaining) : '');
      this.el.countdown.classList.add('is-shown');
    } else {
      this.el.countdown.classList.remove('is-shown');
    }

    // Message fade
    if (this._messageTimer > 0) {
      this._messageTimer -= dt;
      if (this._messageTimer <= 0) this.el.message.classList.remove('is-shown');
    }

    this._updateTower(director);
    this._drawMinimap(race);
  }

  _updateTower(director) {
    const standings = director.standings;
    for (let i = 0; i < standings.length; i++) {
      const entrant = standings[i];
      const row = this._towerRows.find((r) => r.ship === entrant.ship);
      if (!row) continue;
      this._set(row.pos, String(i + 1).padStart(2, '0'));
      this._set(row.name, entrant.name);

      const leader = standings[0];
      if (i === 0) {
        this._set(row.gap, entrant.finished ? formatLapTime(entrant.totalTime) : 'LEAD');
      } else {
        const metres = leader.ship.progress - entrant.ship.progress;
        const seconds = metres / Math.max(14, entrant.ship.speed);
        this._set(row.gap, `+${seconds.toFixed(1)}`);
      }
      // Reordering the DOM every frame would thrash layout; `order` lets
      // flexbox do it without touching the tree.
      this._style(row.row, 'order', String(i));
    }
  }

  _drawMinimap(race) {
    const ctx = this.ctx;
    const outline = this._outline;
    if (!ctx || !outline) return;

    const size = MINIMAP_SIZE * 2;
    const pad = 16;
    const scale = size - pad * 2;
    ctx.clearRect(0, 0, size, size);

    const toScreen = (x, y) => [size / 2 + x * scale, size / 2 + y * scale];

    // Circuit outline.
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < outline.points.length; i += 2) {
      const [sx, sy] = toScreen(outline.points[i], outline.points[i + 1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(150, 180, 210, 0.5)';
    ctx.stroke();

    // Craft blips. Rivals first so the player is always drawn on top.
    const point = { x: 0, y: 0 };
    const sorted = [...race.ships].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer));
    for (const ship of sorted) {
      race.track.minimapPoint(ship.distance, point);
      const [sx, sy] = toScreen(point.x, point.y);
      ctx.beginPath();
      ctx.arc(sx, sy, ship.isPlayer ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = ship.isPlayer ? '#ffffff' : 'rgba(255, 110, 150, 0.9)';
      ctx.fill();
      if (ship.isPlayer) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#40e0ff';
        ctx.stroke();
      }
    }

    // Start line marker.
    race.track.minimapPoint(0, point);
    const [lx, ly] = toScreen(point.x, point.y);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(lx - 5, ly - 5, 10, 10);
  }
}

const TEMPLATE = `
<div class="hud__corner hud__corner--tl">
  <div class="hud__block">
    <div class="hud__label">POS</div>
    <div class="hud__big numeric"><span data-hud="position">1</span><i>/<span data-hud="position-total">8</span></i></div>
  </div>
  <div class="hud__block">
    <div class="hud__label">LAP</div>
    <div class="hud__big numeric"><span data-hud="lap">1</span><i>/<span data-hud="lap-total">3</span></i></div>
  </div>
</div>

<div class="hud__corner hud__corner--tr">
  <ol class="tower" data-hud="tower"></ol>
</div>

<div class="hud__timing">
  <div class="hud__time hud__time--current"><span class="hud__label">LAP</span><b class="numeric" data-hud="current-time">0:00.000</b></div>
  <div class="hud__time"><span class="hud__label">BEST</span><b class="numeric" data-hud="best-time">--:--.---</b></div>
  <div class="hud__time"><span class="hud__label">LAST</span><b class="numeric" data-hud="last-time">--:--.---</b></div>
  <div class="hud__delta numeric" data-hud="delta"></div>
</div>

<div class="hud__gaps">
  <span class="numeric" data-hud="gap-ahead"></span>
  <span class="numeric" data-hud="gap-behind"></span>
</div>

<div class="hud__corner hud__corner--bl">
  <canvas class="minimap" data-hud="minimap" width="300" height="300"></canvas>
</div>

<div class="hud__corner hud__corner--br">
  <div class="hud__speed">
    <b class="numeric" data-hud="speed">000</b>
    <span data-hud="speed-unit">KPH</span>
  </div>
  <div class="hud__meters">
    <div class="meter meter--cell">
      <span class="meter__label">CELL</span>
      <div class="meter__track"><i data-hud="cell-fill"></i></div>
      <span class="meter__value numeric" data-hud="cell-value">100</span>
    </div>
    <div class="meter meter--hull">
      <span class="meter__label">HULL</span>
      <div class="meter__track"><i data-hud="hull-fill"></i></div>
    </div>
  </div>
  <div class="hud__pips">
    <span class="pip" data-hud="boost">BOOST</span>
    <span class="pip" data-hud="shield">SHIELD</span>
  </div>
</div>

<div class="hud__line" data-hud="line-bar">
  <i class="hud__line-glow" data-hud="charge-glow"></i>
  <i class="hud__line-mark" data-hud="line-mark"></i>
</div>

<div class="hud__message" data-hud="message"></div>
<div class="hud__countdown numeric" data-hud="countdown"></div>
`;

export { lerp };
