import type { ObservableHandReplay, TableHandReplay, TableHistory } from '@poker/contracts';
import { tableHandReplay, tableHistoryHands } from '@poker/research';
import { findBinding, isPlayer } from './aggregate.js';
import { completedHands, historyViewer, seatsAndStakes, type ReadableTable } from './readable-table.js';

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
  const left = aggregate.closed || isPlayer(binding) && binding.membership !== 'joined';
  return {
    tableSessionId: aggregate.tableSessionId, viewerParticipantId: participantId,
    mode: aggregate.mode, ...seatsAndStakes(aggregate),
    ...(left ? { left: true as const } : {}), ...(aggregate.closed ? { closed: true as const } : {}),
    hands: tableHistoryHands(completedHands(table), historyViewer(table)),
  };
}

/**
 * One completed Hand's Replay Steps for one Participant (ADR-0041), as the engine projects them, built by Research
 * (`tableHandReplay`) with the Hand's list row; `undefined` when `handId` is not a completed Hand of the table.
 */
export function handReplay(table: ReadableTable, handId: string): TableHandReplay | undefined {
  let replay: ObservableHandReplay;
  try { replay = table.game.forParticipant(table.participantId).getReplay(handId); } catch (error) { if (error instanceof RangeError) return undefined; throw error; }
  const viewer = historyViewer(table);
  const hand = tableHistoryHands(completedHands(table), viewer).find(row => row.handId === handId);
  return hand && tableHandReplay(replay, hand, viewer);
}

/**
 * The reads of Table History: the list and one Hand's Replay Steps, each for a User who may read the table (ADR-0041).
 * `readableTable` is the one rule for that, so no read loads a table.
 */
export function createTableHistoryReads(readableTable: (id: string, userId: string) => Promise<ReadableTable | undefined>) {
  return {
    /** The Table History list for a User who may read this table's history; `undefined` for anyone else. */
    async readHistory(id: string, userId: string): Promise<TableHistory | undefined> {
      const table = await readableTable(id, userId);
      return table && tableHistory(table);
    },
    /**
     * One completed Hand's Replay Steps, under the same rule as the list: `undefined` for a User who may not read the
     * table, `'hand-not-found'` when the Hand is not a completed Hand of it.
     */
    async readReplay(id: string, userId: string, handId: string): Promise<TableHandReplay | 'hand-not-found' | undefined> {
      const table = await readableTable(id, userId);
      return table && (handReplay(table, handId) ?? 'hand-not-found');
    },
  };
}
