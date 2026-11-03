import type { ServerClock } from '../../src/clock.js';

/**
 * A manually advanced server clock. Time stands still until a test moves it, so views produced at
 * the same moment are identical. Timers fire, in time order, only while the clock is advanced.
 */
export class ManualClock implements ServerClock {
  #now: number;
  #timers: { at: number; order: number; callback: () => void }[] = [];
  #order = 0;
  constructor(start = Date.UTC(2026, 0, 1)) { this.#now = start; }
  now() { return this.#now; }
  setTimer(at: number, callback: () => void) {
    const timer = { at, order: this.#order++, callback };
    this.#timers.push(timer);
    return () => { this.#timers = this.#timers.filter(entry => entry !== timer); };
  }
  /** Moves time forward by `ms`, firing every timer that comes due on the way. */
  advance(ms: number) { this.advanceTo(this.#now + ms); }
  advanceTo(at: number) {
    if (at < this.#now) throw new RangeError('The server clock never moves backwards.');
    for (;;) {
      const due = this.#timers.filter(timer => timer.at <= at).sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!due) break;
      this.#timers = this.#timers.filter(timer => timer !== due);
      this.#now = Math.max(this.#now, due.at);
      due.callback();
    }
    this.#now = at;
  }
  /** The time of the earliest pending timer, if any. */
  next(): number | undefined { return this.#timers.reduce<number | undefined>((earliest, timer) => earliest === undefined || timer.at < earliest ? timer.at : earliest, undefined); }
  /**
   * Advances through every timer pending now, as if the table were left alone until each had fired:
   * the open Action Window of a decision, and anything else the server has scheduled. Without
   * pending timers it leaves the time unchanged.
   */
  settle() {
    const latest = this.#timers.reduce((latest, timer) => Math.max(latest, timer.at), this.#now);
    this.advanceTo(latest);
  }
}

/**
 * For tests that are not about play timing. Time stands still, except that it jumps to each timer as
 * soon as the server sets one: every Presentation Phase has ended by the time a commit's response
 * arrives, so Action Windows are already open. Not for tables with an Action Time Limit, whose
 * deadlines it would pass at once.
 */
export class InstantClock extends ManualClock {
  override setTimer(at: number, callback: () => void) {
    const cancel = super.setTimer(at, callback);
    this.advanceTo(Math.max(this.now(), at));
    return cancel;
  }
}
