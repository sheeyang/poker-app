import { randomUUID } from 'node:crypto';
import { normalizeHistoryFilter, type HistoryBreakdown, type HistoryFilter, type OverallHistoryDecision, type ScoredOverallHistory, type StrategyDescriptor } from '@poker/contracts';
import { admittedByScores, filteredDecisions, inListOrder, newestFirst, ownDecisions, summarySets } from '@poker/research';
import { immutableData } from '@poker/strategies';
import type { TrainerConfigurations } from './trainer-configuration.js';
import type { FrozenEvaluationInput } from './analysis.js';
import type { SharedAnalyses, SharedAnalysis } from './shared-analyses.js';
import type { FrozenHistorySummary } from './overall-history-summaries.js';
import { captureEvaluation } from './capture-evaluation.js';
import { completedHands, historyReader, type ReadableTable } from './readable-table.js';

/** One of the Guest's listed decisions, frozen for analysis under the request's Strategy. */
export interface StudiedDecision { readonly decision: OverallHistoryDecision; readonly input: FrozenEvaluationInput }
/**
 * A score-filtered Overall History request, frozen: the decisions the non-score restrictions of `filter` admit, in the
 * list's order, each with its frozen analysis input. The filter's score ranges are decided by those analyses.
 */
export interface FrozenScoredHistory {
  readonly guestId: string;
  readonly filter: HistoryFilter;
  readonly referenceStrategy: StrategyDescriptor;
  readonly decisions: readonly StudiedDecision[];
}
/** Which decisions of a complete score-filtered list to return. */
export interface ScoredPage { readonly limit: number; readonly offset: number }
interface ScoredRequest { readonly input: FrozenScoredHistory; readonly requestId: string; attemptId: string; readonly members: readonly SharedAnalysis[] }

/**
 * Score-filtered Overall History lists (ADR-0041). Each request's analyses are the Score Summaries' own shared ones, run
 * as the Guest's `history-analysis`, so a decision another request or summary has analyzed is not analyzed again.
 */
export function createScoredHistory(analyses: SharedAnalyses) {
  const requests = new Map<string, ScoredRequest>();
  /** The state of a score-filtered request: Error ahead of Analyzing, and a list only when every analysis has succeeded. */
  const scoredHistory = (request: ScoredRequest, page: ScoredPage): ScoredOverallHistory => {
    const { input, members } = request;
    const identity = { ok: true as const, requestId: request.requestId, attemptId: request.attemptId, filter: input.filter, referenceStrategy: input.referenceStrategy };
    const progress = { succeeded: members.filter(analyses.succeeded).length, total: members.length };
    const failure = members.map(analyses.failed).find(Boolean);
    if (failure) return immutableData({ ...identity, progress, status: 'error', error: failure });
    if (progress.succeeded < progress.total) return immutableData({ ...identity, progress, status: 'pending' });
    const admitted = admittedByScores(input.filter, input.decisions, members.map(member => analyses.scores(member)));
    return immutableData({ ...identity, progress, status: 'complete', total: admitted.length, offset: page.offset, decisions: admitted.slice(page.offset, page.offset + page.limit).map(studied => studied.decision) });
  };
  return {
    /**
     * Starts a score-filtered Overall History request. Every analysis of the non-score set is asked for as the Guest's
     * `history-analysis` (matching analyses and stored results are reused). It answers at once; `read` lists the
     * decisions the score ranges admit only once every one of those analyses has succeeded.
     */
    create(input: FrozenScoredHistory, page: ScoredPage): ScoredOverallHistory {
      const members = analyses.forGuest(input.decisions.map(studied => studied.input), input.guestId);
      const request: ScoredRequest = { input, requestId: randomUUID(), attemptId: randomUUID(), members };
      requests.set(request.requestId, request);
      return scoredHistory(request, page);
    },
    read(requestId: string, guestId: string, page: ScoredPage): ScoredOverallHistory | undefined {
      const request = requests.get(requestId);
      return request?.input.guestId === guestId ? scoredHistory(request, page) : undefined;
    },
    /** Asks again for each failed analysis of the request; the others are not run again. */
    retry(requestId: string, guestId: string, page: ScoredPage): ScoredOverallHistory | undefined {
      const request = requests.get(requestId);
      if (request?.input.guestId !== guestId) return undefined;
      if (request.members.some(member => analyses.failed(member))) request.attemptId = randomUUID();
      for (const member of request.members) if (analyses.failed(member)) analyses.retry(member);
      return scoredHistory(request, page);
    },
  };
}

/** What Overall History capture reads: the Guest's tables, how a Guest may read one, and their Trainer Configuration. */
export interface OverallHistorySources {
  /** The tables the Guest has ever been a Participant at, in any status. */
  participations(userId: string): Promise<readonly { readonly tableSessionId: string }[]>;
  readableTable(id: string, userId: string): Promise<ReadableTable | undefined>;
  trainerConfigurations: Pick<TrainerConfigurations, 'studyStrategy'>;
}

/**
 * Overall History's capture (ADR-0041): the Guest's own decisions across every table they may read, listed, and frozen
 * for a summary request or a score-filtered list. Each table is read through `readableTable`, so nothing is loaded.
 */
export function createOverallHistory({ participations, readableTable, trainerConfigurations }: OverallHistorySources) {
  /**
   * The Guest-scoped Overall History (ADR-0041): every decision the Guest made, in a Hand they were dealt into, at any table
   * they may read, passing the non-score restrictions of `filter`, the newest Hand first. The tables are those of the
   * membership index in any status, and each is read through `readableTable`, the one rule for reading a table's history,
   * so it never loads a table and shows no decision of anyone else's.
   */
  async function readOverallHistory(userId: string, filter: HistoryFilter): Promise<OverallHistoryDecision[]> {
    const decisions: OverallHistoryDecision[] = [];
    for (const { tableSessionId } of await participations(userId)) {
      const table = await readableTable(tableSessionId, userId);
      if (table) decisions.push(...ownDecisions(completedHands(table), historyReader(table)));
    }
    return newestFirst(filteredDecisions(decisions, filter));
  }
  /**
   * An Overall History Score Summary request, frozen (ADR-0041): the decisions `readOverallHistory` lists for `filter`,
   * each frozen for analysis under the Guest's Reference Strategy now, or under the supported `strategy` named instead,
   * and with `breakdown` the same decisions in one set per bucket. Each table is read as its history is, so it loads
   * nothing.
   */
  async function studiedDecisions(userId: string, filter: HistoryFilter, referenceStrategy: StrategyDescriptor): Promise<StudiedDecision[]> {
    const decisions: StudiedDecision[] = [];
    for (const { tableSessionId } of await participations(userId)) {
      const table = await readableTable(tableSessionId, userId);
      if (!table) continue;
      const current = table.game.forParticipant(table.participantId).getView();
      for (const decision of filteredDecisions(ownDecisions(completedHands(table), historyReader(table)), filter)) {
        const input = captureEvaluation(table, table.participantId, decision.decisionId, referenceStrategy, current);
        if (input?.acceptedAction) decisions.push({ decision, input });
      }
    }
    return decisions;
  }
  async function captureOverallHistorySummary(userId: string, filter: HistoryFilter, breakdown?: HistoryBreakdown, strategy?: StrategyDescriptor): Promise<FrozenHistorySummary> {
    const referenceStrategy = await trainerConfigurations.studyStrategy(userId, strategy);
    const decisions = await studiedDecisions(userId, filter, referenceStrategy);
    return immutableData({ guestId: userId, filter: normalizeHistoryFilter(filter), ...(breakdown ? { breakdown } : {}), referenceStrategy, ...summarySets(decisions, breakdown) });
  }
  /**
   * A score-filtered Overall History request, frozen: every decision the non-score restrictions of `filter` admit, in the
   * list's order, each frozen for analysis under the Guest's Reference Strategy now (or the supported `strategy`). The
   * score ranges are applied afterwards, to the finished analyses, by the coordinator.
   */
  async function captureScoredHistory(userId: string, filter: HistoryFilter, strategy?: StrategyDescriptor): Promise<FrozenScoredHistory> {
    const referenceStrategy = await trainerConfigurations.studyStrategy(userId, strategy);
    const decisions = await studiedDecisions(userId, filter, referenceStrategy);
    return immutableData({ guestId: userId, filter: normalizeHistoryFilter(filter), referenceStrategy, decisions: inListOrder(decisions) });
  }
  return { readOverallHistory, captureOverallHistorySummary, captureScoredHistory };
}
