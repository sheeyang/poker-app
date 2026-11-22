import { hashKey } from '@tanstack/react-query';
import type { ObservableTableSession } from '@poker/contracts';

/** Hands in the viewer's history that have a recorded result; the Hand in progress has none. */
export function completedHandCount(table: Pick<ObservableTableSession, 'view'>): number {
  return table.view.history.filter(hand => hand.result !== undefined).length;
}

/**
 * Identifies one fresh Session summary request. A key is produced while the Session summary tab is open and changes
 * when the tab opens, when a Hand completes, or when the Guest's Reference Strategy changes, in this tab or another;
 * actions inside the Hand in progress never change it.
 * Callers request a fresh summary each time a non-null key differs from the one they last acted on.
 */
export function sessionSummaryRefreshKey(table: Pick<ObservableTableSession, 'tableSessionId' | 'view'> & Partial<Pick<ObservableTableSession, 'trainerConfiguration'>> | undefined, tabOpen: boolean): string | null {
  if (!table || !tabOpen) return null;
  return `${table.tableSessionId}:${completedHandCount(table)}:${hashKey([table.trainerConfiguration?.referenceStrategy ?? null])}`;
}
