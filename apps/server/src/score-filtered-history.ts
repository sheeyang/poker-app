import { randomUUID } from 'node:crypto';
import type { HistoryFilter, OverallHistoryDecision, ScoredOverallHistory, StrategyDescriptor } from '@poker/contracts';
import { admittedByScores } from '@poker/research';
import { immutableData } from '@poker/strategies';
import type { FrozenEvaluationInput } from './analysis.js';
import { pendingRequest, type GuestDelivery } from './pending-request.js';
import { progressOf, scoresOfMember, type Entry, type SharedAnalysisCoordinator } from './shared-analyses.js';

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
interface ScoredRequest { readonly input: FrozenScoredHistory; readonly requestId: string; entry: Entry; follow: () => void }

/**
 * Score-filtered Overall History lists (ADR-0041). Each request is a set of the Score Summaries' own shared analyses, run
 * as the Guest's `history-analysis`, so a decision another request or summary has analyzed is not analyzed again. It
 * follows a summary's rules, being one that takes no mean: Error ahead of Analyzing, an Error kept until a Retry, and
 * its count from the same running total. While it is pending its count travels on the Guest's progress channel, and it
 * publishes its completion or failure.
 */
export function createScoreFilteredHistory({ reduce, forGuest, retryEntry }: SharedAnalysisCoordinator, delivery: GuestDelivery) {
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
  return {
    /**
     * Starts a score-filtered Overall History request. Every analysis of the non-score set is asked for as the Guest's
     * `history-analysis` (matching analyses and stored results are reused). It answers at once; `read` lists the
     * decisions the score ranges admit only once every one of those analyses has succeeded.
     */
    create(input: FrozenScoredHistory, page: ScoredPage): ScoredOverallHistory {
      const guestId = input.guestId, requestId = randomUUID();
      const { owner, follow } = pendingRequest({
        guestId, requestId, resource: 'overall-history-scored', progress: delivery.progress, runAs: guestId,
        // Deciding the list accepts no result into any table: nothing is written.
        accept: async change => change(),
        publish: entry => delivery.publish(guestId, { type: 'overall-history-update', resource: 'overall-history-scored', requestId, attemptId: entry.attempt, status: entry.outcome.status === 'error' ? 'error' : 'complete' }),
      });
      // Readable before its set is followed, so even a notice sent at once names a request that can be read.
      const request = { input, requestId } as ScoredRequest;
      requests.set(requestId, request);
      request.entry = forGuest(owner, input.decisions.map(studied => studied.input), { list: true });
      request.follow = () => follow(request.entry);
      request.follow();
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
      request.follow();
      void reduce(request.entry);
      return scoredHistory(request, page);
    },
  };
}
