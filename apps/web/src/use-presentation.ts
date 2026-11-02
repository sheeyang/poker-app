import { useEffect, useReducer, useRef } from 'react';
import type { ObservableTableSession } from '@poker/contracts';
import { actionWindowOpen, dealOpen, deadlineCountdown, estimateClockOffset, nextPresentationChange, presentTable, recordClockSample, type ClockSample } from './presentation.js';
import { nextHandStatus } from './online-status.js';

/**
 * Shows a committed table at the server's pace. Each received view's server time refines the clock
 * estimate; the table re-renders when its next step is due. Presentation only reads time: it never
 * sends, delays or retries anything, whatever the animation or motion preferences.
 */
export function usePresentation(table: ObservableTableSession | undefined, viewerId: string | undefined) {
  const samples = useRef<readonly ClockSample[]>([]);
  const sampled = useRef<string | undefined>(undefined);
  const [tick, refresh] = useReducer((count: number) => count + 1, 0);
  // A view is sampled once, when it first renders; later renders of the same view add no sample.
  const key = table && table.tableSessionId + '@' + table.serverTime;
  if (table && key !== sampled.current) {
    sampled.current = key;
    samples.current = recordClockSample(samples.current, { serverTime: table.serverTime, receivedAt: Date.now() });
  }
  const offset = estimateClockOffset(samples.current);
  const serverNow = Date.now() + offset;
  const next = table && nextPresentationChange(table, serverNow);
  useEffect(() => {
    if (next === undefined) return;
    // One millisecond late rather than early; every refresh re-arms for the step after.
    const timer = setTimeout(refresh, Math.max(0, next - (Date.now() + offset)) + 1);
    return () => clearTimeout(timer);
  }, [next, offset, table, tick]);
  if (!table) return undefined;
  return {
    table: presentTable(table, serverNow),
    /** The viewer may act now: their window is open and its Action Deadline, if any, has not been reached. */
    actionOpen: actionWindowOpen(table, viewerId, serverNow),
    /** Whole seconds left before the acting Participant's Action Deadline, or `undefined` without one. */
    countdown: deadlineCountdown(table, serverNow),
    /** The current actor's window is open, whoever acts. */
    actorWindowOpen: actionWindowOpen(table, table.view.state.actorId ?? undefined, serverNow),
    /** The last Hand has been paid out, so Deal is available. */
    dealOpen: dealOpen(table, serverNow),
    /** Between Hands at an Online Table: the Next-Hand Countdown, or why there is none. */
    nextHand: nextHandStatus(table, serverNow),
  };
}
