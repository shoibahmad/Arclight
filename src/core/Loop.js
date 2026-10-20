/**
 * Fixed-timestep game loop with interpolated rendering.
 *
 * Vehicle handling is extremely sensitive to step size — tune grip at 60Hz and
 * the same car understeers on a 144Hz monitor. The simulation therefore always
 * advances in equal STEP slices and the renderer interpolates between the last
 * two states, so the game plays identically on every display.
 */

const STEP = 1 / 120;
/** Beyond this many catch-up steps we drop time instead of stalling further. */
const MAX_STEPS = 5;
/** A tab restored after minutes in the background must not simulate minutes. */
const MAX_FRAME = 0.25;

export class Loop {
  /**
   * @param {(dt: number) => void} update  fixed-step simulation
   * @param {(alpha: number, frameDt: number) => void} render
   */
  constructor(update, render) {
    this.update = update;
    this.render = render;

    this.running = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.rafId = 0;

    /** Wall-clock seconds the loop has actually simulated. */
    this.elapsed = 0;
    /** Smoothed frames-per-second, for the perf readout and auto-quality. */
    this.fps = 60;
    /** Milliseconds spent inside update+render last frame. */
    this.frameMs = 0;
    this.stepCount = 0;

    this._tick = this._tick.bind(this);
    this._onVisibility = () => {
      // Returning from a hidden tab: throw away the gap rather than fast-forward.
      if (!document.hidden) this.lastTime = performance.now();
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    document.addEventListener('visibilitychange', this._onVisibility);
    this.rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  _tick(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this._tick);

    const frameStart = now;
    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (!Number.isFinite(frameDt) || frameDt < 0) frameDt = 0;
    if (frameDt > MAX_FRAME) frameDt = MAX_FRAME;

    // Exponential moving average: responsive enough to catch a sustained drop,
    // steady enough that the readout is not a blur of digits.
    const instant = frameDt > 0 ? 1 / frameDt : this.fps;
    this.fps += (instant - this.fps) * 0.08;

    this.accumulator += frameDt;

    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS) {
      this.update(STEP);
      this.accumulator -= STEP;
      this.elapsed += STEP;
      steps++;
    }
    this.stepCount = steps;

    // Hard overrun (a GC pause, a shader compile). Discard the backlog so the
    // next frame starts clean instead of compounding the stall.
    if (steps === MAX_STEPS && this.accumulator > STEP) this.accumulator = 0;

    this.render(this.accumulator / STEP, frameDt);
    this.frameMs = performance.now() - frameStart;
  }
}

export { STEP as FIXED_STEP };
