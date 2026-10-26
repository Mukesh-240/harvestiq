// In-memory session event log with key-based duplicate suppression.

export class EventLog {
  #events = [];
  #lastByKey = new Map();
  #seq = 0;
  #max;

  constructor(max = 500) {
    this.#max = max;
  }

  /** @returns the stored event, or null if suppressed as a duplicate. */
  add({ t, type, severity = 'info', title, detail = '', key = null, dedupeMs = 0 }) {
    if (key && dedupeMs > 0) {
      const last = this.#lastByKey.get(key);
      if (last !== undefined && t - last < dedupeMs) return null;
    }
    if (key) this.#lastByKey.set(key, t);
    const event = Object.freeze({ id: ++this.#seq, t, type, severity, title, detail });
    this.#events.push(event);
    if (this.#events.length > this.#max) this.#events.shift();
    return event;
  }

  /** Chronological copy. */
  all() {
    return [...this.#events];
  }

  /** Newest first. */
  latest(limit = 100) {
    return this.#events.slice(-limit).reverse();
  }

  get size() {
    return this.#events.length;
  }
}
