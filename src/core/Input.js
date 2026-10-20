import { clamp, deadzone, moveTowards } from './MathUtil.js';

/**
 * Keyboard + gamepad input, expressed as named actions.
 *
 * Two shapes of query:
 *   value(action)  0..1  — analogue, so a trigger and a key feel the same
 *   steerAxis()   -1..1  — paired actions with smoothed keyboard ramping
 *
 * Digital keys are ramped toward their target rather than snapping, which is
 * what makes keyboard steering usable in a vehicle game; a gamepad stick
 * bypasses the ramp entirely and reads through raw.
 */

export const ACTIONS = [
  'throttle', 'brake',
  'steerLeft', 'steerRight',
  'airbrakeLeft', 'airbrakeRight',
  'boost', 'shield', 'lookBack',
  'pause', 'restart',
  'uiUp', 'uiDown', 'uiLeft', 'uiRight', 'uiConfirm', 'uiBack',
];

export const DEFAULT_BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  airbrakeLeft: ['KeyQ', 'Comma'],
  airbrakeRight: ['KeyE', 'Period'],
  boost: ['ShiftLeft', 'ShiftRight'],
  shield: ['Space'],
  lookBack: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  restart: ['KeyR'],
  uiUp: ['ArrowUp', 'KeyW'],
  uiDown: ['ArrowDown', 'KeyS'],
  uiLeft: ['ArrowLeft', 'KeyA'],
  uiRight: ['ArrowRight', 'KeyD'],
  uiConfirm: ['Enter', 'Space'],
  uiBack: ['Escape', 'Backspace'],
};

/** Standard-layout gamepad mapping, by button index. */
const PAD_BUTTONS = {
  throttle: [7, 0],
  brake: [6, 2],
  airbrakeLeft: [4],
  airbrakeRight: [5],
  boost: [1],
  shield: [3],
  lookBack: [10],
  pause: [9],
  restart: [8],
  uiConfirm: [0],
  uiBack: [1],
  uiUp: [12],
  uiDown: [13],
  uiLeft: [14],
  uiRight: [15],
};

// Keys the browser would otherwise act on (scrolling, quick-find) while driving.
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
  'Slash', 'Quote', 'Backspace',
]);

const KEY_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'SPACE', Enter: 'ENTER', Escape: 'ESC', Backspace: 'BKSP', Tab: 'TAB',
  ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
  AltLeft: 'L-ALT', AltRight: 'R-ALT', Comma: ',', Period: '.', Slash: '/',
  Semicolon: ';', Quote: '’', BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=',
};

export function keyLabel(code) {
  if (!code) return '--';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  return code.toUpperCase();
}

export class Input {
  constructor(bindings = DEFAULT_BINDINGS) {
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
    this.keys = new Set();
    /** Analogue value per action, after ramping. */
    this.values = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
    /** True only on the frame an action went from inactive to active. */
    this.edges = Object.fromEntries(ACTIONS.map((a) => [a, false]));
    this.prevDigital = Object.fromEntries(ACTIONS.map((a) => [a, false]));

    this.padIndex = null;
    this.padConnected = false;
    this.usingPad = false;
    /** Raw stick value, bypassing keyboard ramping when a pad is driving. */
    this.padSteer = 0;

    /** When set, the next keydown is captured for rebinding instead of played. */
    this.captureTarget = null;
    this.onCapture = null;

    this.enabled = true;
    this._bind();
  }

  _bind() {
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      if (this.captureTarget) {
        e.preventDefault();
        const action = this.captureTarget;
        this.captureTarget = null;
        this.onCapture?.(action, e.code);
        return;
      }
      if (SWALLOW.has(e.code) && !e.metaKey && !e.ctrlKey) e.preventDefault();
      this.keys.add(e.code);
      this.usingPad = false;
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    // Alt-tabbing away mid-corner must not leave the throttle pinned on.
    this._onBlur = () => this.keys.clear();
    this._onPadConnect = (e) => {
      this.padIndex = e.gamepad.index;
      this.padConnected = true;
    };
    this._onPadDisconnect = (e) => {
      if (e.gamepad.index === this.padIndex) {
        this.padIndex = null;
        this.padConnected = false;
        this.usingPad = false;
      }
    };

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onPadConnect);
    window.addEventListener('gamepaddisconnected', this._onPadDisconnect);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onPadConnect);
    window.removeEventListener('gamepaddisconnected', this._onPadDisconnect);
  }

  setBindings(bindings) {
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
  }

  /** Ask for the next key press to be assigned to `action`. */
  beginCapture(action, onCapture) {
    this.captureTarget = action;
    this.onCapture = onCapture;
  }

  cancelCapture() {
    this.captureTarget = null;
    this.onCapture = null;
  }

  _pad() {
    if (!navigator.getGamepads) return null;
    let pads;
    try {
      pads = navigator.getGamepads();
    } catch {
      return null;
    }
    if (!pads) return null;
    if (this.padIndex != null && pads[this.padIndex]) return pads[this.padIndex];
    for (const pad of pads) {
      if (pad && pad.connected) {
        this.padIndex = pad.index;
        return pad;
      }
    }
    return null;
  }

  _keyHeld(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  _padValue(pad, action) {
    const indices = PAD_BUTTONS[action];
    if (!pad || !indices) return 0;
    let best = 0;
    for (const i of indices) {
      const b = pad.buttons[i];
      if (!b) continue;
      const v = typeof b === 'object' ? (b.value ?? (b.pressed ? 1 : 0)) : b;
      if (v > best) best = v;
    }
    return best > 0.06 ? best : 0;
  }

  /**
   * Sample every action for this frame.
   * Called once per frame, before any system reads input.
   */
  update(dt) {
    const pad = this._pad();
    const padActive = !!pad;

    let padSteerRaw = 0;
    if (padActive) {
      padSteerRaw = deadzone(pad.axes[0] ?? 0, 0.14);
      // Any meaningful pad activity switches the on-screen prompt glyphs over.
      if (Math.abs(padSteerRaw) > 0.02 || pad.buttons.some((b) => (b.value ?? 0) > 0.2)) {
        this.usingPad = true;
      }
    }
    this.padSteer = padSteerRaw;

    for (const action of ACTIONS) {
      const keyDown = this.enabled && this._keyHeld(action);
      const padVal = this.enabled && padActive ? this._padValue(pad, action) : 0;
      const digital = keyDown || padVal > 0.4;

      this.edges[action] = digital && !this.prevDigital[action];
      this.prevDigital[action] = digital;

      // Steering keys ramp; everything else reads straight through so that
      // boost and airbrakes respond on the exact frame they are pressed.
      const target = Math.max(keyDown ? 1 : 0, padVal);
      if (action === 'steerLeft' || action === 'steerRight') {
        const rate = target > this.values[action] ? 4.2 : 7.5;
        this.values[action] = moveTowards(this.values[action], target, rate * dt);
      } else {
        this.values[action] = target;
      }
    }
  }

  value(action) {
    return this.values[action] ?? 0;
  }

  held(action) {
    return (this.values[action] ?? 0) > 0.5;
  }

  pressed(action) {
    return this.edges[action] === true;
  }

  /** Combined -1..1 steering. A live stick overrides the ramped keys. */
  steerAxis() {
    if (this.usingPad && Math.abs(this.padSteer) > 0.001) return clamp(this.padSteer, -1, 1);
    return clamp(this.values.steerRight - this.values.steerLeft, -1, 1);
  }

  /** Consume all edges — used when a screen opens so it cannot eat its own key. */
  flushEdges() {
    for (const action of ACTIONS) this.edges[action] = false;
  }
}
