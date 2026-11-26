import { randomUUID } from 'node:crypto';
import type { HistoryBreakdown, HistoryFilter, HistoryScoreSummary, OverallHistorySummary, OverallHistoryUpdate, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { scoreAdmission } from '@poker/research';
import type { FrozenEvaluationInput } from './analysis.js';
import type { AcceptTableJobResult } from './mutations.js';
import type { ProgressChannel } from './progress.js';
import { progressOf, type Entry, type Owner, type SharedAnalysisCoordinator } from './shared-analyses.js';
/**
 * An Overall History summary request, frozen (ADR-0041): the Guest's own decisions across every table they may read, as
 * `filter` declared them under one Strategy, and, with a breakdown, the same decisions in one set per bucket. Only that
 * Guest reads or retries it. Its members may come from many tables: each carries its own table and Participant.
 */
export interface FrozenHistorySummary {
  readonly guestId: string;
  readonly filter: HistoryFilter;
  readonly breakdown?: HistoryBreakdown;
  readonly referenceStrategy: StrategyDescriptor;
  readonly members: readonly FrozenEvaluationInput[];
  readonly buckets?: readonly { readonly value: string; readonly members: readonly FrozenEvaluationInput[] }[];
}
/** Where a Guest's Overall History requests are told of: their notices, and their pending counts. */
export interface GuestDelivery {
  /** Sends a notice on the Guest's user channel, to every connection of theirs and nobody else's. */
  readonly publish: (guestId: string, update: OverallHistoryUpdate) => void;
  readonly progress: ProgressChannel;
}
/** A Participant at a table: whose results a history summary's decisions are accepted for. */
interface Membership { readonly tableSessionId: string; readonly participantId: string }
/** The distinct memberships the decisions of `members` come from, each once. */
function membershipsOf(members: readonly FrozenEvaluationInput[]): Membership[] {
  const byTable = new Map<string, Set<string>>();
  for (const { identity } of members) byTable.set(identity.tableSessionId, (byTable.get(identity.tableSessionId) ?? new Set()).add(identity.participantId));
  return [...byTable].flatMap(([tableSessionId, participants]) => [...participants].map(participantId => ({ tableSessionId, participantId })));
}
interface HistoryRequest { readonly input: FrozenHistorySummary; readonly requestId: string; attemptId: string; whole: Entry; buckets: readonly { readonly value: string; readonly entry: Entry }[] }
/**
 * Overall History Score Summaries (ADR-0041): the Guest's own decisions across every table they may read. Every
 * analysis they need is asked for as the Guest's `history-analysis`; the shared analyses are reused. While the whole
 * set's summary is pending its count travels on the Guest's progress channel, and each summary of the request, the
 * whole set's and every bucket's, publishes its completion or failure.
 */
export function createOverallHistorySummaries(shared: SharedAnalysisCoordinator, acceptJobResult: AcceptTableJobResult, delivery: GuestDelivery) {
  const { reduce, forGuest, retryEntry } = shared;
  const historyRequests = new Map<string, HistoryRequest>();
  const historySummary = (entry: Entry): HistoryScoreSummary => {
    const decisionCount = entry.admits ? entry.admitted : entry.members.length;
    return immutableData({ ...(decisionCount === undefined ? {} : { decisionCount }), progress: progressOf(entry), ...entry.outcome } as HistoryScoreSummary);
  };
  const overallSummary = (request: HistoryRequest): OverallHistorySummary => immutableData({
    ok: true as const, requestId: request.requestId, attemptId: request.attemptId, filter: request.input.filter,
    ...(request.input.breakdown ? { breakdown: request.input.breakdown } : {}), referenceStrategy: request.input.referenceStrategy,
    summary: historySummary(request.whole),
    ...(request.input.breakdown ? { buckets: request.buckets.map(bucket => ({ value: bucket.value, summary: historySummary(bucket.entry) })) } : {}),
  });
  /** The request's count is the whole set's summary's, which every bucket's analyses are part of. */
  function follow(request: HistoryRequest) {
    if (request.whole.outcome.status !== 'pending') return;
    delivery.progress.follow(request.input.guestId, { resource: 'overall-history-summary', requestId: request.requestId, count: () => progressOf(request.whole) });
  }
  return {
    /**
     * Starts an Overall History summary request. Every analysis it needs is asked for as the Guest's `history-analysis`,
     * reusing any matching analysis or stored result; the per-Guest bound holds back the rest. It answers at once; its
     * count travels on the Guest's progress channel while it runs, each of its summaries publishes its completion or
     * failure, and `readHistory` reads it. Its results are accepted only while every table its decisions come from still
     * accepts its Participant's results, each checked as `acceptJobResult` checks one table's. With score ranges, every
     * summary of it waits for all of its set's analyses and then covers only the decisions the ranges admit.
     */
    createHistory(input: FrozenHistorySummary): OverallHistorySummary {
      const admits = scoreAdmission(input.filter);
      const memberships = membershipsOf(input.members);
      const guestId = input.guestId;
      // Readable before its sets are followed, so every notice names a request that can be read.
      const request = { input, requestId: randomUUID(), attemptId: randomUUID() } as HistoryRequest;
      historyRequests.set(request.requestId, request);
      const owner: Owner & { readonly guestId: string } = {
        guestId,
        async accept(change) {
          for (const { tableSessionId, participantId } of memberships) if (!await acceptJobResult(tableSessionId, participantId, () => true)) return false;
          return change();
        },
        notify: entry => {
          if (entry === request.whole) delivery.progress.settled(guestId, request.requestId);
          delivery.publish(guestId, { type: 'overall-history-update', resource: 'overall-history-summary', requestId: request.requestId, attemptId: request.attemptId, status: entry.outcome.status === 'error' ? 'error' : 'complete' });
        },
        progress: entry => { if (entry === request.whole && entry.outcome.status === 'pending') delivery.progress.changed(guestId, request.requestId); },
      };
      // Each bucket's decisions are among the whole set's, so asking for the whole set asks for every one of them.
      request.whole = forGuest(owner, input.members, { admits });
      request.buckets = (input.buckets ?? []).map(bucket => ({ value: bucket.value, entry: forGuest(owner, bucket.members, { admits }) }));
      follow(request);
      return overallSummary(request);
    },
    readHistory(requestId: string, guestId: string): OverallHistorySummary | undefined {
      const request = historyRequests.get(requestId);
      return request?.input.guestId === guestId ? overallSummary(request) : undefined;
    },
    /** Retries every failed summary of the request, asking again for each failed analysis it needs; its count is followed again. */
    retryHistory(requestId: string, guestId: string): OverallHistorySummary | undefined {
      const request = historyRequests.get(requestId);
      if (request?.input.guestId !== guestId) return undefined;
      const entries = [request.whole, ...request.buckets.map(bucket => bucket.entry)];
      if (entries.map(retryEntry).some(Boolean)) request.attemptId = randomUUID();
      follow(request);
      for (const entry of entries) void reduce(entry);
      return overallSummary(request);
    },
  };
}
