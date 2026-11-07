import type { ObservableTableSession } from '@poker/contracts';

const timeFields = new Set(['startsAt', 'endsAt', 'opensAt', 'deadlineAt', 'serverTime']);

/** The moment a recorded view was waiting on: the open Action Window, else the Next-Hand Countdown, else when it was produced. */
export function anchorOf(session: Pick<ObservableTableSession, 'schedule' | 'serverTime'>): number {
  return session.schedule.actionWindow?.opensAt ?? session.schedule.nextHandCountdown?.startsAt ?? session.serverTime;
}

/** A copy of `value` with every server timestamp moved by `delta`, so a recorded view can be replayed as if it just happened. */
export function shiftTimes<T>(value: T, delta: number): T {
  if (Array.isArray(value)) return value.map(item => shiftTimes(item, delta)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, timeFields.has(key) && typeof item === 'number' ? item + delta : shiftTimes(item, delta)])) as T;
  }
  return value;
}

/** The recorded view, replayed so that what it was waiting on starts at `now`. */
export function replayAt(session: ObservableTableSession, now: number): ObservableTableSession {
  return shiftTimes(session, now - anchorOf(session));
}
