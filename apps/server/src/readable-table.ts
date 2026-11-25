import type { SavedTable } from '@poker/contracts';
import type { CashGame } from '@poker/engine';
import type { CompletedHand, HistoryReader } from '@poker/research';
import { isBot, type PersistedTableSession } from './aggregate.js';
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

/**
 * The participant-safe facts Research reads the table's history with: its public facts, the names of everyone who has
 * had a place there and which of them are Bots (a removed Bot's binding stays), and the reader.
 */
export function historyReader({ aggregate, participantId }: ReadableTable): HistoryReader {
  const names = new Map<string, string>(), bots = new Set<string>();
  for (const binding of aggregate.bindings) {
    if (!names.has(binding.participantId)) names.set(binding.participantId, binding.name);
    if (isBot(binding)) bots.add(binding.participantId);
  }
  return { tableSessionId: aggregate.tableSessionId, mode: aggregate.mode, participantId, ...tableFormat(aggregate), names, bots };
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
