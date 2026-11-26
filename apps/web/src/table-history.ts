import type { Card, ObservableTableSession, ScoreSummary, TableHistory, TableHistoryHand, TableHistoryOutcome } from '@poker/contracts';
import { actionWindowOpen, deadlineCountdown } from './presentation.js';
import { chips } from './table-model.js';
import { tablePath } from './table-address.js';
import type { Followed } from './request-progress.js';

/** One completed Hand as the Table History list shows it. Pure: the server alone decides what each viewer may see. */
export interface HandRow {
  readonly key: string;
  readonly handNumber: number;
  /** "Hand 37": the table-wide number, the same for every viewer. */
  readonly label: string;
  /** When it completed; absent for a Hand completed before completion times were recorded. */
  readonly completed: string | undefined;
  /** Everyone dealt in, the viewer as "You"; cards only where the viewer may see them, and none while the Hand is concealed. */
  readonly participants: readonly { readonly participantId: string; readonly name: string; readonly cards: readonly Card[] | undefined }[];
  /**
   * The Hand is being replayed and has not reached its result step: its row then gives only its number, completion time and
   * who was dealt in, so the list never shows what the replay has not yet reached (Story 21). Its `board`, `result` and
   * `ending` are absent.
   */
  readonly concealed: boolean;
  readonly board: readonly Card[] | undefined;
  /** "You won 70 · Rex won 70". */
  readonly result: string | undefined;
  readonly ending: 'Showdown' | 'No showdown' | undefined;
  /** The viewer was dealt in, so made decisions in this Hand. */
  readonly dealtIn: boolean;
}

/** "Nov 22, 2:05 PM" in the viewer's zone (or `zone`); nothing for a Hand without a completion time. */
export function completedLabel(at: number | undefined, zone?: string): string | undefined {
  return at === undefined ? undefined : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }).format(at);
}

/** "You won 70 · Rex won 70": each winner's share of the payouts, named by `nameOf`. */
export function resultLabel(payouts: TableHistoryOutcome['payouts'], nameOf: (participantId: string) => string): string {
  const won = new Map<string, number>();
  for (const payout of payouts) won.set(payout.participantId, (won.get(payout.participantId) ?? 0) + payout.amount);
  return [...won].map(([participantId, amount]) => `${nameOf(participantId)} won ${chips(amount)}`).join(' · ');
}

/**
 * The Hands of a Table History as list rows, newest first. `concealed` names the Hand being replayed whose result step has
 * not been reached: its row shows only its number, completion time and who was dealt in, with no cards, board or result.
 * Every other row is unchanged.
 */
export function handRows(hands: readonly TableHistoryHand[], viewerParticipantId: string, concealed?: string): HandRow[] {
  return [...hands].sort((a, b) => b.handNumber - a.handNumber).map(hand => {
    const name = (participantId: string, fallback = '') => participantId === viewerParticipantId ? 'You' : hand.dealtIn.find(dealt => dealt.participantId === participantId)?.name ?? fallback;
    const hidden = hand.handId === concealed;
    return {
      key: hand.handId, handNumber: hand.handNumber, label: `Hand ${hand.handNumber}`, completed: completedLabel(hand.completedAt),
      participants: hand.dealtIn.map(dealt => ({ participantId: dealt.participantId, name: name(dealt.participantId, dealt.name), cards: hidden ? undefined : dealt.holeCards })),
      concealed: hidden,
      board: hidden ? undefined : hand.board,
      result: hidden ? undefined : resultLabel(hand.payouts, name),
      ending: hidden ? undefined : hand.showdown ? 'Showdown' : 'No showdown',
      dealtIn: hand.viewerDealtIn,
    };
  });
}

/**
 * Why the viewer of a Table History cannot play at its table, if they cannot: they are a former Participant, or it is a
 * Closed Table, which nobody can join or play at again (ADR-0041). Either way they still read every Hand.
 */
export function historyStanding(history: TableHistory): { readonly kind: 'left' | 'closed'; readonly title: string; readonly detail: string } | undefined {
  if (history.closed) return { kind: 'closed', title: 'This table is closed.', detail: 'Nobody can join or play here again. Its hands stay here for everyone who played.' };
  if (history.left) return { kind: 'left', title: 'You’re no longer at this table.', detail: 'Every hand stays here for you, including hands played after you left. Its Join Link returns you to play.' };
  return undefined;
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

/**
 * A table's Score Summary (a Hand's, the Session's, or Table History's) as the Trainer follows it on the user channel:
 * Analyzing with its count until it is complete, empty or in Error, which only a Retry moves on from.
 */
export const followedTableSummary: Followed<ScoreSummary> = {
  resource: 'summary',
  pending: summary => summary.status === 'pending',
  settled: summary => summary.status !== 'pending',
  count: summary => summary.progress,
  withCount: (summary, progress) => ({ ...summary, progress }),
};
