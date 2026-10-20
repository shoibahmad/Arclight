/**
 * Minimal pub/sub.
 *
 * Systems that need to talk across layers (race -> hud, race -> audio) publish
 * here instead of holding references to each other. Keeps the UI replaceable
 * and keeps the simulation from importing anything that touches the DOM.
 */
export class Signal {
  constructor() {
    this.listeners = new Map();
  }

  on(type, fn) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const dispose = this.on(type, (payload) => {
      dispose();
      fn(payload);
    });
    return dispose;
  }

  off(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    // Copy: handlers are allowed to unsubscribe themselves mid-dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[signal] handler for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this.listeners.clear();
  }
}
