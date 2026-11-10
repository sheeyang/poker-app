/**
 * The server's only source of time for play timing. Presentation Phases, Action Windows and every later
 * schedule (deadlines, countdowns) read `now()` and wake through `setTimer`, so tests can substitute a
 * manually advanced clock. Times are milliseconds since the Unix epoch, as carried in table views.
 */
export interface ServerClock {
  now(): number;
  /**
   * Calls `callback` once, at or after server time `at`. The returned function cancels it. `purpose` tells play
   * timing (the default) from housekeeping that nobody at a table sees, such as unloading an idle table.
   */
  setTimer(at: number, callback: () => void, purpose?: TimerPurpose): () => void;
}
export type TimerPurpose = 'play' | 'housekeeping';

/** Longest delay Node timers accept; later wake-ups re-arm when this one fires. */
const maximumDelay = 2 ** 31 - 1;

export const systemClock: ServerClock = {
  now: () => Date.now(),
  setTimer(at, callback) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const delay = at - Date.now();
      timer = setTimeout(delay > maximumDelay ? arm : callback, Math.max(0, Math.min(delay, maximumDelay)));
      // Scheduled play never keeps the process alive; shutdown clears these anyway.
      timer.unref();
    };
    arm();
    return () => clearTimeout(timer);
  },
};
