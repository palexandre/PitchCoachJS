/** Minimal event emitter used by every public class. */
export class Emitter {
  #handlers = new Map();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (data) => {
      off();
      fn(data);
    });
    return off;
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[entona] error in "${type}" handler`, err);
      }
    }
  }
}
