import { decisionSituation } from '@poker/research';
import { historyBreakdownValue, historyBreakdownValues, matchesHistoryFilter, type HistoryBreakdown, type HistoryFilter, type OverallHistoryDecision } from '@poker/contracts';
import type { FrozenEvaluationInput } from './analysis.js';
import { completedHands, tableFormat, type ReadableTable } from './readable-table.js';

/**
 * Every decision the Participant made in a completed Hand of this table, as Overall History lists it (ADR-0041): their
 * own, from the Hands they were dealt into, read from their own Observable Session History. A decision of anyone else's
 * is never in it, and Hands completed or in progress without a decision of theirs add nothing. In decision order,
 * Hand by Hand. The facts (street, Position, pot in big blinds) are Research's, from the decision's recorded state.
 */
export function ownDecisions(table: ReadableTable): OverallHistoryDecision[] {
  const { aggregate, participantId } = table;
  const format = tableFormat(aggregate);
  const decisions: OverallHistoryDecision[] = [];
  for (const { entry, handNumber, completedAt } of completedHands(table)) {
    for (const decision of entry.decisions) {
      if (decision.action.participantId !== participantId) continue;
      const me = decision.state.participants.find(participant => participant.participantId === participantId);
      decisions.push({
        tableSessionId: aggregate.tableSessionId, mode: aggregate.mode, ...format,
        handId: entry.handId, handNumber, ...(completedAt !== undefined ? { completedAt } : {}),
        decisionId: decision.decisionId, action: decision.action.action,
        holeCards: [...me?.holeCards ?? []], board: [...decision.state.board],
        ...decisionSituation(decision, format.stakes.bigBlind),
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

/** One of the Guest's listed decisions, frozen for analysis under the summary's Strategy. */
export interface StudiedDecision { readonly decision: OverallHistoryDecision; readonly input: FrozenEvaluationInput }
/**
 * The frozen sets of an Overall History summary: every decision, in the list's order, and with a breakdown one set per
 * value of that dimension the decisions have, in declared order. Each decision is in exactly one bucket.
 */
export function summarySets(decisions: readonly StudiedDecision[], breakdown?: HistoryBreakdown) {
  const inputs = new Map(decisions.map(studied => [studied.decision, studied.input]));
  const ordered = newestFirst(decisions.map(studied => studied.decision));
  const members = ordered.map(decision => inputs.get(decision)!);
  if (!breakdown) return { members };
  const buckets = historyBreakdownValues[breakdown].flatMap(value => {
    const inBucket = ordered.filter(decision => historyBreakdownValue(breakdown, decision) === value);
    return inBucket.length ? [{ value, members: inBucket.map(decision => inputs.get(decision)!) }] : [];
  });
  return { members, buckets };
}
