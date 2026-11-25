import { randomUUID } from 'node:crypto';
import { normalizeHistoryFilter, type HistoryBreakdown, type HistoryFilter, type OverallHistoryDecision, type ScoredOverallHistory, type StrategyDescriptor, type TrainerConfiguration } from '@poker/contracts';
import { admittedByScores, filteredDecisions, inListOrder, newestFirst, ownDecisions, summarySets } from '@poker/research';
import { immutableData } from '@poker/strategies';
import type { FrozenEvaluationInput } from './analysis.js';
import { progressOf, scoresOfMember, type Entry, type Owner, type SharedAnalysisCoordinator } from './shared-analyses.js';
import type { FrozenHistorySummary, GuestDelivery } from './overall-history-summaries.js';
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
interface ScoredRequest { readonly input: FrozenScoredHistory; readonly requestId: string; entry: Entry }

/**
 * Score-filtered Overall History lists (ADR-0041). Each request is a set of the Score Summaries' own shared analyses, run
 * as the Guest's `history-analysis`, so a decision another request or summary has analyzed is not analyzed again. It
 * follows a summary's rules, being one that takes no mean: Error ahead of Analyzing, an Error kept until a Retry, and
 * its count from the same running total. While it is pending its count travels on the Guest's progress channel, and it
 * publishes its completion or failure.
 */
export function createScoredHistory({ reduce, forGuest, retryEntry }: SharedAnalysisCoordinator, delivery: GuestDelivery) {
  const requests = new Map<string, ScoredRequest>();
  /** The state of a score-filtered request: Error ahead of Analyzing, and a list only when every analysis has succeeded. */
  const scoredHistory = (request: ScoredRequest, page: ScoredPage): ScoredOverallHistory => {
    const { input, entry } = request;
    const identity = { ok: true as const, requestId: request.requestId, attemptId: entry.attempt, filter: input.filter, referenceStrategy: input.referenceStrategy, progress: progressOf(entry) };
    if (entry.outcome.status === 'error') return immutableData({ ...identity, status: 'error', error: entry.outcome.error });
    if (entry.outcome.status === 'pending') return immutableData({ ...identity, status: 'pending' });
    const admitted = admittedByScores(input.filter, input.decisions, entry.members.map(scoresOfMember));
    return immutableData({ ...identity, status: 'complete', total: admitted.length, offset: page.offset, decisions: admitted.slice(page.offset, page.offset + page.limit).map(studied => studied.decision) });
  };
  function follow(request: ScoredRequest) {
    if (request.entry.outcome.status !== 'pending') return;
    delivery.progress.follow(request.input.guestId, { resource: 'overall-history-scored', requestId: request.requestId, count: () => progressOf(request.entry) });
  }
  return {
    /**
     * Starts a score-filtered Overall History request. Every analysis of the non-score set is asked for as the Guest's
     * `history-analysis` (matching analyses and stored results are reused). It answers at once; `read` lists the
     * decisions the score ranges admit only once every one of those analyses has succeeded.
     */
    create(input: FrozenScoredHistory, page: ScoredPage): ScoredOverallHistory {
      const guestId = input.guestId, requestId = randomUUID();
      const owner: Owner & { readonly guestId: string } = {
        guestId,
        // Deciding the list accepts no result into any table: nothing is written.
        accept: async change => change(),
        notify: entry => {
          delivery.progress.settled(guestId, requestId);
          delivery.publish(guestId, { type: 'overall-history-update', resource: 'overall-history-scored', requestId, attemptId: entry.attempt, status: entry.outcome.status === 'error' ? 'error' : 'complete' });
        },
        progress: entry => { if (entry.outcome.status === 'pending') delivery.progress.changed(guestId, requestId); },
      };
      // Readable before its set is followed, so even a notice sent at once names a request that can be read.
      const request = { input, requestId } as ScoredRequest;
      requests.set(requestId, request);
      request.entry = forGuest(owner, input.decisions.map(studied => studied.input), { list: true });
      follow(request);
      return scoredHistory(request, page);
    },
    read(requestId: string, guestId: string, page: ScoredPage): ScoredOverallHistory | undefined {
      const request = requests.get(requestId);
      return request?.input.guestId === guestId ? scoredHistory(request, page) : undefined;
    },
    /** Asks again for each failed analysis of the request, in a new attempt; the others are not run again. */
    retry(requestId: string, guestId: string, page: ScoredPage): ScoredOverallHistory | undefined {
      const request = requests.get(requestId);
      if (request?.input.guestId !== guestId) return undefined;
      retryEntry(request.entry);
      follow(request);
      void reduce(request.entry);
      return scoredHistory(request, page);
    },
  };
}

/** What Overall History capture reads: the Guest's tables, how a Guest may read one, and their Trainer Configuration. */
export interface OverallHistorySources {
  /** The tables the Guest has ever been a Participant at, in any status. */
  participations(userId: string): Promise<readonly { readonly tableSessionId: string }[]>;
  readableTable(id: string, userId: string): Promise<ReadableTable | undefined>;
  trainerConfigurations: { current(userId: string): Promise<TrainerConfiguration> };
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
    const referenceStrategy = strategy ? immutableData(strategy) : (await trainerConfigurations.current(userId)).referenceStrategy;
    const decisions = await studiedDecisions(userId, filter, referenceStrategy);
    return immutableData({ guestId: userId, filter: normalizeHistoryFilter(filter), ...(breakdown ? { breakdown } : {}), referenceStrategy, ...summarySets(decisions, breakdown) });
  }
  /**
   * A score-filtered Overall History request, frozen: every decision the non-score restrictions of `filter` admit, in the
   * list's order, each frozen for analysis under the Guest's Reference Strategy now (or the supported `strategy`). The
   * score ranges are applied afterwards, to the finished analyses, by the coordinator.
   */
  async function captureScoredHistory(userId: string, filter: HistoryFilter, strategy?: StrategyDescriptor): Promise<FrozenScoredHistory> {
    const referenceStrategy = strategy ? immutableData(strategy) : (await trainerConfigurations.current(userId)).referenceStrategy;
    const decisions = await studiedDecisions(userId, filter, referenceStrategy);
    return immutableData({ guestId: userId, filter: normalizeHistoryFilter(filter), referenceStrategy, decisions: inListOrder(decisions) });
  }
  return { readOverallHistory, captureOverallHistorySummary, captureScoredHistory };
}
