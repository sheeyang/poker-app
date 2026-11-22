import { decisionSituation } from '@poker/research';
import { matchesHistoryFilter, type HistoryFilter, type OverallHistoryDecision } from '@poker/contracts';
import type { CashGame } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
import { recordedConfiguration } from './projection.js';

/**
 * Every decision the Participant made in a completed Hand of this table, as Overall History lists it (ADR-0041): their
 * own, from the Hands they were dealt into, read from their own Observable Session History. A decision of anyone else's
 * is never in it, and Hands completed or in progress without a decision of theirs add nothing. In decision order,
 * Hand by Hand. The facts (street, Position, pot in big blinds) are Research's, from the decision's recorded state.
 */
export function ownDecisions(aggregate: PersistedTableSession, game: CashGame, participantId: string): OverallHistoryDecision[] {
  const { seatCount, smallBlind, bigBlind, ante } = recordedConfiguration(aggregate.pokerRecord);
  const numbers = new Map(game.getCompletedHands().map(hand => [hand.handId, hand.sequence]));
  const decisions: OverallHistoryDecision[] = [];
  for (const entry of game.forParticipant(participantId).getView().history) {
    const handNumber = numbers.get(entry.handId);
    if (!entry.result || handNumber === undefined) continue;
    const completedAt = aggregate.handCompletedAt?.[entry.handId];
    for (const decision of entry.decisions) {
      if (decision.action.participantId !== participantId) continue;
      const me = decision.state.participants.find(participant => participant.participantId === participantId);
      decisions.push({
        tableSessionId: aggregate.tableSessionId, mode: aggregate.mode, seatCount, stakes: { smallBlind, bigBlind, ante },
        handId: entry.handId, handNumber, ...(completedAt !== undefined ? { completedAt } : {}),
        decisionId: decision.decisionId, action: decision.action.action,
        holeCards: [...me?.holeCards ?? []], board: [...decision.state.board],
        ...decisionSituation(decision, bigBlind),
      });
    }
  }
  return decisions;
}

/**
 * Overall History's order: the most recently completed Hand first, Hands without a completion time after those that have
 * one, and decisions in the order they were made within a Hand. `decisions` arrive grouped by table, in decision order.
 */
export function newestFirst(decisions: readonly OverallHistoryDecision[]): OverallHistoryDecision[] {
  return decisions.map((decision, index) => ({ decision, index }))
    .sort((a, b) => (b.decision.completedAt ?? -1) - (a.decision.completedAt ?? -1) || (a.decision.tableSessionId < b.decision.tableSessionId ? -1 : a.decision.tableSessionId > b.decision.tableSessionId ? 1 : 0) || b.decision.handNumber - a.decision.handNumber || a.index - b.index)
    .map(({ decision }) => decision);
}
/** The decisions that pass every non-score restriction of `filter`. */
export const filtered = (decisions: readonly OverallHistoryDecision[], filter: HistoryFilter): OverallHistoryDecision[] => decisions.filter(decision => matchesHistoryFilter(filter, decision));
