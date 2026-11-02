import type { ObservableTableSession } from '@poker/contracts';

/** Hands in the viewer's history that have a recorded result; the Hand in progress has none. */
export function completedHandCount(table: Pick<ObservableTableSession, 'view'>): number {
  return table.view.history.filter(hand => hand.result !== undefined).length;
}

/**
 * Identifies one fresh Session summary request. A key is produced while the Session summary tab is open and changes
 * when the tab opens or when a Hand completes; actions inside the Hand in progress never change it.
 * Callers request a fresh summary each time a non-null key differs from the one they last acted on.
 */
export function sessionSummaryRefreshKey(table: Pick<ObservableTableSession, 'tableSessionId' | 'view'> | undefined, tabOpen: boolean): string | null {
  if (!table || !tabOpen) return null;
  return `${table.tableSessionId}:${completedHandCount(table)}`;
}
