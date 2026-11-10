import type { ObservableTableSession, SavedTable, SavedTables } from '@poker/contracts';
import { actionWindowOpen, payoutEnded, presentTable } from './presentation.js';
import { afterHandRequestLabel, afterHandRequestOf, selfService, type Availability } from './self-service.js';
import { chips, tableFormat } from './table-model.js';
import { tablePath } from './table-address.js';

/**
 * The Guest's Current Table, from their saved tables: the one Online Table they are at and have not left. Undefined
 * while they are at none, or the list has not been read.
 */
export function currentTableId(saved: readonly SavedTable[] | undefined): string | undefined {
  return saved?.find(table => table.mode === 'online' && !table.left)?.tableSessionId;
}

/** The saved tables once the server says the Guest is no longer at `tableSessionId`: it stays listed, as left. */
export function withMembershipEnded(saved: SavedTables | undefined, tableSessionId: string): SavedTables | undefined {
  return saved && { ...saved, tables: saved.tables.map(table => table.tableSessionId === tableSessionId ? { ...table, left: true } : table) };
}

/** What the Current Table banner says, in the order it says it. */
export interface CurrentTableBanner {
  /** The table's address, for Back to game. */
  readonly href: string;
  /** The table by its Table Owner, "Sam’s table" or "Your table"; "Your turn at Sam’s table" while it is. */
  readonly heading: string;
  /** Format and stakes: "6-max · 10 / 20". */
  readonly format: string;
  /** "Hand 14 in progress" or "Between hands". */
  readonly hand: string;
  /** "2,140 chips", or "Watching" without a Seat. */
  readonly stack: string;
  /** The viewer's Action Window is open now. */
  readonly yourTurn: boolean;
  /** The viewer's pending Leave Table or Removal, in words: "Leaving after this hand". */
  readonly pending: string | undefined;
  /** A Hand is in progress until its payout phase ends: Leave Table then waits for it. */
  readonly handOpen: boolean;
  /** What Leave game does now, as Leave Table at the table would. */
  readonly leave: Availability;
}

/**
 * The Current Table banner, from that table's observable state as the live subscription keeps it, on the page at
 * `pathname`, at server time `serverNow`. Undefined when it does not show: there is no Current Table, or the page is
 * the Current Table's own. Pure, so the banner says exactly what the table at its own page would.
 */
export function currentTableBanner(table: ObservableTableSession | undefined, pathname: string, serverNow: number): CurrentTableBanner | undefined {
  if (table?.mode !== 'online') return undefined;
  const [, , pageTable] = pathname.split('/');
  if (pageTable === table.tableSessionId) return undefined;
  const { view, viewerParticipantId: viewer } = table;
  const owner = table.bindings.find(binding => binding.participantId === table.ownerParticipantId);
  const handOpen = view.state.status === 'active-hand' || !payoutEnded(table, serverNow);
  const handIndex = view.history.findIndex(hand => hand.handId === view.state.handId);
  // The stack as the table shows it now: a Hand still paying out has not paid the viewer yet.
  const me = presentTable(table, serverNow).view.state.participants.find(participant => participant.participantId === viewer);
  const pending = afterHandRequestOf(table, viewer);
  const { configuration } = view;
  const yourTurn = actionWindowOpen(table, viewer, serverNow);
  const name = viewer === table.ownerParticipantId || !owner ? 'your table' : `${owner.name}’s table`;
  return {
    href: tablePath('online', table.tableSessionId),
    heading: yourTurn ? `Your turn at ${name}` : name[0]!.toUpperCase() + name.slice(1),
    format: `${tableFormat(configuration.seatCount)} · ${chips(configuration.smallBlind)} / ${chips(configuration.bigBlind)}`,
    hand: handOpen ? `Hand ${handIndex >= 0 ? handIndex + 1 : view.history.length + 1} in progress` : 'Between hands',
    stack: me?.seat != null ? `${chips(me.stack)} chips` : 'Watching',
    yourTurn,
    pending: pending === 'leave-table' || pending === 'remove' ? afterHandRequestLabel(pending) : undefined,
    handOpen,
    leave: selfService(table, handOpen).leaveTable,
  };
}
