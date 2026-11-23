import type { ObservableHandReplay, TableHandReplay, TableHistory, TableHistoryHand } from '@poker/contracts';
import { findBinding, isHuman } from './aggregate.js';
import { completedHands, tableFormat, type ReadableTable } from './readable-table.js';

/**
 * The Table History list for one Participant: every completed Hand of the Table Session, oldest first (ADR-0040).
 * It is built only from that Participant's Observable Session History, so it shows public information for every Hand
 * plus their own hole cards, and any cards a showdown revealed in its own Hand's result. The Hand number is the
 * engine's table-wide sequence; the completion time is the server's, recorded beside the poker record, and absent
 * for a Hand completed before it was recorded.
 *
 * Later reads of a Hand (its Replay Steps) take their rows from the same place: `handsOf`.
 */
export function tableHistory(table: ReadableTable): TableHistory {
  const { aggregate, participantId } = table;
  const binding = findBinding(aggregate, participantId);
  const left = aggregate.closed || isHuman(binding) && binding.membership !== 'joined';
  return {
    tableSessionId: aggregate.tableSessionId, viewerParticipantId: participantId,
    mode: aggregate.mode, ...tableFormat(aggregate),
    ...(left ? { left: true as const } : {}), ...(aggregate.closed ? { closed: true as const } : {}),
    hands: handsOf(table),
  };
}
export function handsOf(table: ReadableTable): TableHistoryHand[] {
  const { aggregate, participantId } = table;
  return completedHands(table).map(({ entry, handNumber, completedAt }): TableHistoryHand => {
    const { result } = entry;
    const dealt = result.participants.filter(player => player.inHand).sort((a, b) => a.handSeat! - b.handSeat!);
    return {
      handId: entry.handId, handNumber, ...(completedAt !== undefined ? { completedAt } : {}),
      dealtIn: dealt.map(player => ({ participantId: player.participantId, name: findBinding(aggregate, player.participantId)?.name ?? '', ...(player.holeCards ? { holeCards: [...player.holeCards] } : {}) })),
      viewerDealtIn: dealt.some(player => player.participantId === participantId),
      board: [...result.board],
      showdown: dealt.filter(player => !player.folded).length > 1,
      payouts: (result.payouts ?? []).map(payout => ({ participantId: payout.participantId, amount: payout.amount })),
    };
  });
}

/**
 * One completed Hand's Replay Steps for one Participant (ADR-0041), as the engine projects them, with the Hand's list
 * row and the names of everyone seated in it; `undefined` when `handId` is not a completed Hand of the table.
 */
export function handReplay(table: ReadableTable, handId: string): TableHandReplay | undefined {
  const { aggregate, game, participantId } = table;
  let replay: ObservableHandReplay;
  try { replay = game.forParticipant(participantId).getReplay(handId); } catch (error) { if (error instanceof RangeError) return undefined; throw error; }
  const hand = handsOf(table).find(row => row.handId === handId);
  if (!hand) return undefined;
  const seats = new Map<string, number>();
  for (const step of replay.steps) for (const p of step.state.participants) if (p.seat !== null && !seats.has(p.participantId)) seats.set(p.participantId, p.seat);
  const players = [...seats].sort((a, b) => a[1] - b[1]).map(([id]) => ({ participantId: id, name: findBinding(aggregate, id)?.name ?? '' }));
  return { ...replay, tableSessionId: aggregate.tableSessionId, mode: aggregate.mode, viewerParticipantId: participantId, hand, players };
}
