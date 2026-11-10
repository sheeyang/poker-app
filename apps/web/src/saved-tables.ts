import type { ObservableTableSession, SavedTable, TableMode } from '@poker/contracts';
import { blindsLabel, chips, gameLabel } from './table-model.js';
import { handInProgress } from './presentation.js';

/** How play stands at the Current Table and the Guest's stack there: read from the copy its subscription already holds. */
export interface LiveDetails { readonly tableSessionId: string; readonly handInProgress: boolean; readonly stack?: number }

export type SavedRow =
  | { readonly kind: 'unreadable'; readonly tableSessionId: string }
  | {
    readonly kind: 'practice' | 'current' | 'away';
    readonly tableSessionId: string;
    readonly seatCount: number;
    readonly name: string;
    readonly blinds: string;
    readonly ante?: string;
    readonly status: string;
    readonly action: 'Continue' | 'Back to game' | 'Return to table';
    /** Only the Current Table's row, and only while its live copy is loaded. */
    readonly live?: Pick<LiveDetails, 'handInProgress' | 'stack'>;
    readonly openedAt?: number;
  }
  /** A Closed Table: listed, but nobody can open it until replay arrives. */
  | {
    readonly kind: 'closed';
    readonly tableSessionId: string;
    readonly seatCount: number;
    readonly name: string;
    readonly blinds: string;
    readonly ante?: string;
    readonly status: 'Closed';
    readonly openedAt?: number;
  };

/**
 * The live details of a loaded table at server time `serverNow`; undefined while it is not loaded. A Hand is in
 * progress until its payout phase ends (`handInProgress`). A Guest who is only watching has no stack.
 */
export function liveDetails(tableSessionId: string, table: ObservableTableSession | undefined, serverNow: number): LiveDetails | undefined {
  if (!table) return undefined;
  const { state } = table.view;
  const own = state.participants.find(participant => participant.participantId === table.viewerParticipantId && participant.seat !== null);
  return { tableSessionId, handInProgress: handInProgress(table, serverNow), ...(own ? { stack: own.stack } : {}) };
}

/**
 * The rows of one mode's list: what each saved table says and offers, in the order to show them. The server's entries
 * carry only stored facts, among them when the Guest last opened the table; a table is the Current Table when it is an Online
 * Table the Guest has not left, and only that row takes the live details. A Closed Table offers nothing to do. Rows go
 * most recently opened first, then tables never opened, in the order given.
 */
export function savedRows(saved: readonly SavedTable[], mode: TableMode, live?: LiveDetails): SavedRow[] {
  const rows = saved.filter(entry => entry.mode === mode).map((entry): SavedRow => {
    const { tableSessionId, seatCount, stakes } = entry;
    if (seatCount === undefined || !stakes) return { kind: 'unreadable', tableSessionId };
    const described = { tableSessionId, seatCount, name: gameLabel(seatCount), blinds: blindsLabel(stakes.smallBlind, stakes.bigBlind),
      ...(stakes.ante ? { ante: chips(stakes.ante) } : {}), ...(entry.openedAt !== undefined ? { openedAt: entry.openedAt } : {}) };
    if (entry.closed) return { kind: 'closed', ...described, status: 'Closed' };
    const kind = entry.mode === 'practice' ? 'practice' : entry.left ? 'away' : 'current';
    const details = kind === 'current' && live?.tableSessionId === tableSessionId ? { handInProgress: live.handInProgress, ...(live.stack !== undefined ? { stack: live.stack } : {}) } : undefined;
    return {
      kind, ...described,
      status: kind === 'practice' ? 'Practice' : kind === 'away' ? 'Not at this table' : 'Current Table',
      action: kind === 'practice' ? 'Continue' : kind === 'away' ? 'Return to table' : 'Back to game',
      ...(details ? { live: details } : {}),
    };
  });
  // Array.prototype.sort is stable: tables never opened keep the order the server gave.
  const recency = (row: SavedRow) => row.kind === 'unreadable' ? -1 : row.openedAt ?? -1;
  return rows.sort((a, b) => recency(b) - recency(a));
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The Opened column: how long ago, then the day; a dash for a table never opened. */
export function openedLabel(openedAt: number | undefined, now: number): string {
  if (openedAt === undefined) return '—';
  const age = now - openedAt, date = new Date(openedAt), today = new Date(now);
  if (age < 60_000) return 'Just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min ago`;
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `${Math.floor(age / 3_600_000)} h ago`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return `${date.getDate()} ${months[date.getMonth()]}${date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`}`;
}
