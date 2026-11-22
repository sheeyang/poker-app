import type { Card, ObservableTableSession, TableHistoryHand } from '@poker/contracts';
import { actionWindowOpen, deadlineCountdown } from './presentation.js';
import { chips } from './table-model.js';
import { tablePath } from './table-address.js';

/** One completed Hand as the Table History list shows it. Pure: the server alone decides what each viewer may see. */
export interface HandRow {
  readonly key: string;
  readonly handNumber: number;
  /** "Hand 37": the table-wide number, the same for every viewer. */
  readonly label: string;
  /** When it completed; absent for a Hand completed before completion times were recorded. */
  readonly completed: string | undefined;
  /** Everyone dealt in, the viewer as "You"; cards only where the viewer may see them. */
  readonly players: readonly { readonly participantId: string; readonly name: string; readonly cards: readonly Card[] | undefined }[];
  readonly board: readonly Card[];
  /** "You won 70 · Rex won 70". */
  readonly result: string;
  readonly ending: 'Showdown' | 'No showdown';
  /** The viewer was dealt in, so made decisions in this Hand. */
  readonly dealtIn: boolean;
}

/** "Nov 22, 2:05 PM" in the viewer's zone (or `zone`); nothing for a Hand without a completion time. */
export function completedLabel(at: number | undefined, zone?: string): string | undefined {
  return at === undefined ? undefined : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }).format(at);
}

/** The Hands of a Table History as list rows, newest first. */
export function handRows(hands: readonly TableHistoryHand[], viewerParticipantId: string): HandRow[] {
  return [...hands].sort((a, b) => b.handNumber - a.handNumber).map(hand => {
    const name = (participantId: string, fallback = '') => participantId === viewerParticipantId ? 'You' : hand.dealtIn.find(player => player.participantId === participantId)?.name ?? fallback;
    const won = new Map<string, number>();
    for (const payout of hand.payouts) won.set(payout.participantId, (won.get(payout.participantId) ?? 0) + payout.amount);
    return {
      key: hand.handId, handNumber: hand.handNumber, label: `Hand ${hand.handNumber}`, completed: completedLabel(hand.completedAt),
      players: hand.dealtIn.map(player => ({ participantId: player.participantId, name: name(player.participantId, player.name), cards: player.holeCards })),
      board: hand.board,
      result: [...won].map(([participantId, amount]) => `${name(participantId)} won ${chips(amount)}`).join(' · '),
      ending: hand.showdown ? 'Showdown' : 'No showdown',
      dealtIn: hand.viewerDealtIn,
    };
  });
}

/**
 * The bar that follows a viewer through Table History while they are seated: it appears whenever their Action Window
 * opens, names the way back to the table, and carries the seconds left to their Action Deadline, which never pauses.
 * Undefined while it is not their turn.
 */
export function returnBar(table: ObservableTableSession, serverNow: number): { readonly href: string; readonly countdown?: number } | undefined {
  const seated = table.view.state.participants.some(participant => participant.participantId === table.viewerParticipantId && participant.seat !== null);
  if (!seated || !actionWindowOpen(table, table.viewerParticipantId, serverNow)) return undefined;
  const countdown = deadlineCountdown(table, serverNow);
  return { href: tablePath(table.mode, table.tableSessionId), ...(countdown !== undefined ? { countdown } : {}) };
}
