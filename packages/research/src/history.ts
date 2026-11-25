import { hasScoreFilter, historyBreakdownValues, type DecisionFacts, type DecisionId, type HistoryBreakdown, type HistoryFilter, type NumberRange, type ObservableHandReplay, type ObservableHistoryEntry, type ObservableSessionHistory, type OverallHistoryDecision, type ParticipantId, type ScoreAverages, type ScoreSummaryScope, type Stakes, type TableHandReplay, type TableHistoryHand, type TableMode, type TableSessionId } from '@poker/contracts';
import { decisionSituation } from './decision-facts.js';

/**
 * The history computations of Table History and Overall History (ADR-0041), as plain functions over participant-safe
 * inputs: one Participant's Observable Session History, the engine's Replay Steps for them, and the table's public facts.
 * None of them sees an unrevealed hole card, a burn card, the deck or the master seed. The server authorizes the read,
 * reads the table, chooses each request's Strategy and caches and schedules the analyses; Research decides what the
 * history says.
 */

/** One completed Hand of a Participant's Observable Session History. */
export interface CompletedHand {
  readonly entry: ObservableHistoryEntry & { readonly result: NonNullable<ObservableHistoryEntry['result']> };
  /** The engine's table-wide Hand sequence. */
  readonly handNumber: number;
  /** The server's completion time, absent for a Hand completed before it was recorded. */
  readonly completedAt?: number;
}

/** A table as one Participant reads its history: its public facts, and the Participant every read is built for. */
export interface HistoryReader {
  readonly tableSessionId: TableSessionId;
  readonly mode: TableMode;
  /** The reading Participant. */
  readonly participantId: ParticipantId;
  readonly seatCount: number;
  readonly stakes: Stakes;
  /** Everyone who has had a place at the table, by name; anyone missing shows no name. */
  readonly names: ReadonlyMap<ParticipantId, string>;
  /** Every Participant at the table who is a Bot, removed Bots included. */
  readonly bots: ReadonlySet<ParticipantId>;
}

/**
 * The Table History list's rows: one per completed Hand, in the order given (oldest first). Each shows who was dealt in,
 * in seat order, with only the hole cards the reader's history holds (their own, and a showdown's reveals in its own
 * Hand's result), the final board and the payouts.
 */
export function tableHistoryHands(hands: readonly CompletedHand[], reader: HistoryReader): TableHistoryHand[] {
  return hands.map(({ entry, handNumber, completedAt }): TableHistoryHand => {
    const { result } = entry;
    const dealt = result.participants.filter(player => player.inHand).sort((a, b) => a.handSeat! - b.handSeat!);
    return {
      handId: entry.handId, handNumber, ...(completedAt !== undefined ? { completedAt } : {}),
      dealtIn: dealt.map(player => ({ participantId: player.participantId, name: reader.names.get(player.participantId) ?? '', ...(player.holeCards ? { holeCards: [...player.holeCards] } : {}) })),
      viewerDealtIn: dealt.some(player => player.participantId === reader.participantId),
      board: [...result.board],
      showdown: dealt.filter(player => !player.folded).length > 1,
      payouts: (result.payouts ?? []).map(payout => ({ participantId: payout.participantId, amount: payout.amount })),
    };
  });
}

/**
 * One completed Hand replayed for the reader: the engine's Replay Steps as they may see them, with the Hand's list row
 * and everyone seated at any step, by name and whether they are a Bot, in seat order at their first step (departed
 * Guests and removed Bots included), so the Trainer can draw it without the live table. Only a seated Participant acts,
 * so every step's actor is among them.
 */
export function tableHandReplay(replay: ObservableHandReplay, hand: TableHistoryHand, reader: HistoryReader): TableHandReplay {
  const seats = new Map<ParticipantId, number>();
  for (const step of replay.steps) for (const p of step.state.participants) if (p.seat !== null && !seats.has(p.participantId)) seats.set(p.participantId, p.seat);
  const participants = [...seats].sort((a, b) => a[1] - b[1]).map(([id]) => ({ participantId: id, name: reader.names.get(id) ?? '', bot: reader.bots.has(id) }));
  return { ...replay, tableSessionId: reader.tableSessionId, mode: reader.mode, viewerParticipantId: reader.participantId, hand, participants };
}

/**
 * Every decision the reader made in the completed Hands given, as Overall History lists it: their own, from the Hands
 * they were dealt into. A decision of anyone else's is never in it, and a Hand without a decision of theirs adds nothing.
 * In decision order, Hand by Hand. The facts (street, Position, pot in big blinds) come from the decision's recorded state.
 */
export function ownDecisions(hands: readonly CompletedHand[], reader: HistoryReader): OverallHistoryDecision[] {
  const { participantId, seatCount, stakes } = reader;
  const decisions: OverallHistoryDecision[] = [];
  for (const { entry, handNumber, completedAt } of hands) {
    for (const decision of entry.decisions) {
      if (decision.action.participantId !== participantId) continue;
      const me = decision.state.participants.find(participant => participant.participantId === participantId);
      decisions.push({
        tableSessionId: reader.tableSessionId, mode: reader.mode, seatCount, stakes,
        handId: entry.handId, handNumber, ...(completedAt !== undefined ? { completedAt } : {}),
        decisionId: decision.decisionId, action: decision.action.action,
        holeCards: [...me?.holeCards ?? []], board: [...decision.state.board],
        ...decisionSituation(decision, stakes.bigBlind),
      });
    }
  }
  return decisions;
}

/**
 * The reader's own decisions a table-scoped Score Summary covers: in one Hand, or in every completed Hand of the Table
 * Session, in decision order.
 */
export function ownDecisionIds(history: ObservableSessionHistory, participantId: ParticipantId, scope: ScoreSummaryScope): DecisionId[] {
  return history.filter(hand => scope.scope === 'table-session' ? hand.result !== undefined : hand.handId === scope.handId)
    .flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === participantId).map(decision => decision.decisionId));
}

const listOrder = (a: { readonly decision: OverallHistoryDecision; readonly index: number }, b: { readonly decision: OverallHistoryDecision; readonly index: number }) =>
  (b.decision.completedAt ?? -1) - (a.decision.completedAt ?? -1)
  || (a.decision.tableSessionId < b.decision.tableSessionId ? -1 : a.decision.tableSessionId > b.decision.tableSessionId ? 1 : 0)
  || b.decision.handNumber - a.decision.handNumber
  || a.index - b.index;
/** Decisions, each with what was frozen for it, in Overall History's order (`newestFirst`). */
export function inListOrder<T extends { readonly decision: OverallHistoryDecision }>(studied: readonly T[]): T[] {
  return studied.map((item, index) => ({ item, decision: item.decision, index })).sort(listOrder).map(({ item }) => item);
}
/**
 * Overall History's order: the most recently completed Hand first, Hands without a completion time after those that have
 * one, and decisions in the order they were made within a Hand. `decisions` arrive grouped by table, in decision order.
 */
export function newestFirst(decisions: readonly OverallHistoryDecision[]): OverallHistoryDecision[] {
  return inListOrder(decisions.map(decision => ({ decision }))).map(({ decision }) => decision);
}

const within = (range: NumberRange | undefined, value: number) => !range || (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
/**
 * Whether a decision's recorded facts pass every non-score restriction of the filter. A date restriction excludes an
 * undated Hand. The score ranges are not recorded facts, so they never decide it.
 */
export function matchesHistoryFilter(filter: HistoryFilter, facts: DecisionFacts): boolean {
  return (!filter.street?.length || filter.street.includes(facts.street))
    && (!filter.position?.length || filter.position.includes(facts.position))
    && (!filter.action?.length || filter.action.includes(facts.action.type))
    && (!filter.mode?.length || filter.mode.includes(facts.mode))
    && (!filter.completed || facts.completedAt !== undefined && within(filter.completed, facts.completedAt))
    && within(filter.pot, facts.potBigBlinds);
}
/** The decisions that pass every non-score restriction of `filter`, in the order given. */
export const filteredDecisions = <T extends DecisionFacts>(decisions: readonly T[], filter: HistoryFilter): T[] => decisions.filter(decision => matchesHistoryFilter(filter, decision));

/** Whether a decision's two scores pass the filter's score ranges (inclusive); a filter with none admits everything. */
export const matchesScoreFilter = (filter: HistoryFilter, scores: ScoreAverages): boolean =>
  within(filter.decisionScore, scores.decisionScore) && within(filter.actionRankScore, scores.actionRankScore);
/**
 * Which scores a filter's ranges admit, for a summary that covers only the decisions they let in once every analysis
 * has succeeded; `undefined` when the filter has no score range, so every decision of the set counts.
 */
export const scoreAdmission = (filter: HistoryFilter): ((scores: ScoreAverages) => boolean) | undefined =>
  hasScoreFilter(filter) ? scores => matchesScoreFilter(filter, scores) : undefined;
/**
 * Of a set whose analyses have all finished, the members the filter's score ranges admit, in order: `scores` holds each
 * member's scores, at the same index. A member with no scores is never admitted.
 */
export function admittedByScores<T>(filter: HistoryFilter, members: readonly T[], scores: readonly (ScoreAverages | undefined)[]): T[] {
  return members.filter((_, index) => { const score = scores[index]; return !!score && matchesScoreFilter(filter, score); });
}

/** The bucket a decision falls in under a breakdown: its street, Position, action type or table mode. */
export const historyBreakdownValue = (breakdown: HistoryBreakdown, facts: DecisionFacts): string => breakdown === 'action' ? facts.action.type : facts[breakdown];
/** The frozen sets of an Overall History summary, as `summarySets` returns them. */
export interface SummarySets<T> {
  readonly members: T[];
  readonly buckets?: { readonly value: string; readonly members: T[] }[];
}
/**
 * The frozen sets of an Overall History summary: every decision's frozen input, in the list's order, and with a
 * breakdown one set per value of that dimension the decisions have, in declared order. Each decision is in exactly one
 * bucket. `input` is whatever was frozen for the decision; Research only places it.
 */
export function summarySets<T>(decisions: readonly { readonly decision: OverallHistoryDecision; readonly input: T }[], breakdown?: HistoryBreakdown): SummarySets<T> {
  const ordered = inListOrder(decisions);
  const members = ordered.map(studied => studied.input);
  if (!breakdown) return { members };
  const buckets = historyBreakdownValues[breakdown].flatMap(value => {
    const inBucket = ordered.filter(studied => historyBreakdownValue(breakdown, studied.decision) === value);
    return inBucket.length ? [{ value, members: inBucket.map(studied => studied.input) }] : [];
  });
  return { members, buckets };
}
