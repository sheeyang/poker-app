import { randomUUID } from 'node:crypto';
import type { HistoryFilter, OverallHistoryDecision, ScoredOverallHistory, StrategyDescriptor } from '@poker/contracts';
import { admittedByScores } from '@poker/research';
import { immutableData } from '@poker/strategies';
import type { FrozenEvaluationInput } from './analysis.js';
import type { SharedAnalyses, SharedAnalysis } from './summaries.js';

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
