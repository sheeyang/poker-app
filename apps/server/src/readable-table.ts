import type { ObservableHistoryEntry, SavedTable } from '@poker/contracts';
import type { CashGame } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
import { recordedConfiguration } from './projection.js';

/**
 * A table as one Participant reads its history (ADR-0041): its committed record and game, and the Participant whose
 * Observable Session History every read of it is built from.
 */
export interface ReadableTable { readonly participantId: string; readonly aggregate: PersistedTableSession; readonly game: CashGame }

/** The table's format as its history and saved-tables list show it: seat count and stakes, as recorded. */
export function tableFormat(aggregate: PersistedTableSession): { readonly seatCount: number; readonly stakes: NonNullable<SavedTable['stakes']> } {
  const { seatCount, smallBlind, bigBlind, ante } = recordedConfiguration(aggregate.pokerRecord);
  return { seatCount, stakes: { smallBlind, bigBlind, ante } };
}

/** One completed Hand of the Participant's Observable Session History. */
export interface CompletedHand {
  readonly entry: ObservableHistoryEntry & { readonly result: NonNullable<ObservableHistoryEntry['result']> };
  /** The engine's table-wide Hand sequence. */
  readonly handNumber: number;
  /** The server's completion time, absent for a Hand completed before it was recorded. */
  readonly completedAt?: number;
}

/** Every completed Hand of the table in the Participant's Observable Session History, oldest first. */
export function completedHands({ aggregate, game, participantId }: ReadableTable): CompletedHand[] {
  const numbers = new Map(game.getCompletedHands().map(hand => [hand.handId, hand.sequence]));
  const hands: CompletedHand[] = [];
  for (const entry of game.forParticipant(participantId).getView().history) {
    const handNumber = numbers.get(entry.handId);
    if (!entry.result || handNumber === undefined) continue;
    const completedAt = aggregate.handCompletedAt?.[entry.handId];
    hands.push({ entry: entry as CompletedHand['entry'], handNumber, ...(completedAt !== undefined ? { completedAt } : {}) });
  }
  return hands;
}
