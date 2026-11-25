import type { ObservableHandReplay, TableHandReplay, TableHistory } from '@poker/contracts';
import { tableHandReplay, tableHistoryHands } from '@poker/research';
import { findBinding, isHuman } from './aggregate.js';
import { completedHands, historyReader, tableFormat, type ReadableTable } from './readable-table.js';

/**
 * The Table History list for one Participant: every completed Hand of the Table Session, oldest first (ADR-0040).
 * It is built only from that Participant's Observable Session History, so it shows public information for every Hand
 * plus their own hole cards, and any cards a showdown revealed in its own Hand's result. The Hand number is the
 * engine's table-wide sequence; the completion time is the server's, recorded beside the poker record, and absent
 * for a Hand completed before it was recorded. Research builds the rows (`tableHistoryHands`).
 */
export function tableHistory(table: ReadableTable): TableHistory {
  const { aggregate, participantId } = table;
  const binding = findBinding(aggregate, participantId);
  const left = aggregate.closed || isHuman(binding) && binding.membership !== 'joined';
  return {
    tableSessionId: aggregate.tableSessionId, viewerParticipantId: participantId,
    mode: aggregate.mode, ...tableFormat(aggregate),
    ...(left ? { left: true as const } : {}), ...(aggregate.closed ? { closed: true as const } : {}),
    hands: tableHistoryHands(completedHands(table), historyReader(table)),
  };
}

/**
 * One completed Hand's Replay Steps for one Participant (ADR-0041), as the engine projects them, built by Research
 * (`tableHandReplay`) with the Hand's list row; `undefined` when `handId` is not a completed Hand of the table.
 */
export function handReplay(table: ReadableTable, handId: string): TableHandReplay | undefined {
  let replay: ObservableHandReplay;
  try { replay = table.game.forParticipant(table.participantId).getReplay(handId); } catch (error) { if (error instanceof RangeError) return undefined; throw error; }
  const reader = historyReader(table);
  const hand = tableHistoryHands(completedHands(table), reader).find(row => row.handId === handId);
  return hand && tableHandReplay(replay, hand, reader);
}
