import { expect, test } from 'vitest';
import { completedHandCount, sessionSummaryRefreshKey } from '../src/session-summary.js';

const decision = (id: string) => ({ decisionId: id });
function table(history: { handId: string; decisions: number; completed: boolean }[], tableSessionId = 'table-1') {
  return {
    tableSessionId,
    view: { history: history.map(hand => ({ handId: hand.handId, description: '', decisions: Array.from({ length: hand.decisions }, (_, index) => decision(`${hand.handId}/decision-${index + 1}`)), ...(hand.completed ? { result: {} } : {}) })) },
  } as never as Parameters<typeof sessionSummaryRefreshKey>[0] & object;
}

test('only completed Hands count toward a Session summary refresh', () => {
  expect(completedHandCount(table([]))).toBe(0);
  expect(completedHandCount(table([{ handId: 'hand-1', decisions: 2, completed: true }, { handId: 'hand-2', decisions: 1, completed: false }]))).toBe(1);
});

test('a closed tab never requests a summary', () => {
  expect(sessionSummaryRefreshKey(table([{ handId: 'hand-1', decisions: 1, completed: true }]), false)).toBeNull();
  expect(sessionSummaryRefreshKey(undefined, true)).toBeNull();
});

test('opening the tab produces a key, and reopening after closing produces a request again', () => {
  const current = table([{ handId: 'hand-1', decisions: 1, completed: true }]);
  const opened = sessionSummaryRefreshKey(current, true);
  expect(opened).not.toBeNull();
  const keys = [true, false, true].map(open => sessionSummaryRefreshKey(current, open));
  expect(keys).toEqual([opened, null, opened]);
});

test('actions inside the Hand in progress do not refresh an open tab', () => {
  const before = table([{ handId: 'hand-1', decisions: 1, completed: true }, { handId: 'hand-2', decisions: 0, completed: false }]);
  const after = table([{ handId: 'hand-1', decisions: 1, completed: true }, { handId: 'hand-2', decisions: 3, completed: false }]);
  expect(sessionSummaryRefreshKey(after, true)).toBe(sessionSummaryRefreshKey(before, true));
});

test('completing a Hand refreshes an open tab, and another table does not share the key', () => {
  const midHand = table([{ handId: 'hand-1', decisions: 1, completed: false }]);
  const completed = table([{ handId: 'hand-1', decisions: 2, completed: true }]);
  expect(sessionSummaryRefreshKey(completed, true)).not.toBe(sessionSummaryRefreshKey(midHand, true));
  expect(sessionSummaryRefreshKey(table([], 'table-2'), true)).not.toBe(sessionSummaryRefreshKey(table([], 'table-1'), true));
});
