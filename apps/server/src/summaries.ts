import { randomUUID } from 'node:crypto';
import { hasScoreFilter, matchesScoreFilter, type AnalysisFailureCode, AnalysisUpdate, DecisionAnalysis, HistoryBreakdown, HistoryFilter, HistoryScoreSummary, OverallHistorySummary, ScoreAverages, ScoreSummary, ScoreSummaryScope, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { calculateScoreSummary } from '@poker/research';
import type { AnalysisSchedule, createAnalysis, FrozenEvaluationInput } from './analysis.js';
import type { JobHandle, JobRunner } from './job-runner.js';
import type { AcceptTableJobResult } from './mutations.js';
import type { HistoryAnalysisScheduler } from './history-analysis.js';
/** `participantId` keys the summary: only that Participant's Human Controller reads or retries it. */
interface FrozenSummaryMetadata {
  readonly participantId: string; readonly tableSessionId: string;
  readonly capturedPokerRevision: number; readonly referenceStrategy: StrategyDescriptor; readonly decisionIds: readonly string[];
  readonly members: readonly FrozenEvaluationInput[];
  /**
   * The Guest whose `history-analysis` runs it, when it is study from history (Table History, a compared Strategy, a
   * former Participant): then its analyses and mean run under that Guest's bound, never as `summary-analysis`.
   */
  readonly historyGuestId?: string;
}
export type FrozenScoreSummary = FrozenSummaryMetadata & ScoreSummaryScope;
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
interface Failure { readonly code: AnalysisFailureCode; readonly message: string }
/** A Participant at a table: whose results a history summary's decisions are accepted for. */
interface Membership { readonly tableSessionId: string; readonly participantId: string }
/** The distinct memberships the decisions of `members` come from, each once. */
function membershipsOf(members: readonly FrozenEvaluationInput[]): Membership[] {
  const byTable = new Map<string, Set<string>>();
  for (const { identity } of members) byTable.set(identity.tableSessionId, (byTable.get(identity.tableSessionId) ?? new Set()).add(identity.participantId));
  return [...byTable].flatMap(([tableSessionId, participants]) => [...participants].map(participantId => ({ tableSessionId, participantId })));
}
interface Dependency {
  readonly input: FrozenEvaluationInput; readonly consumers: Set<Entry>; state?: DecisionAnalysis; failure?: Failure;
  running: boolean; queued: boolean; retryRequested: boolean; starting: boolean; observedAttempt?: string;
  readonly settlements: Map<string, Promise<void>>; readonly settledAttempts: Set<string>;
  /** Set once a history summary needs it: then it runs as that Guest's `history-analysis`, outside this coordinator's bound. */
  guestId?: string;
  /** Whether it holds one of this coordinator's own admission places. */
  counted: boolean;
}
type Outcome = { readonly status: 'empty' | 'pending' } | { readonly status: 'complete'; readonly averages: ScoreAverages } | { readonly status: 'error'; readonly error: Failure };
/** Where a summary's results are accepted, whose bound its jobs run under, and whom its terminal state is told. */
interface Owner {
  /** Applies `change` when the summary's results may still be accepted; whether it was applied. */
  accept(change: () => boolean): Promise<boolean>;
  /** The Guest whose `history-analysis` bound a history summary's jobs run under; absent for a table's own summary. */
  readonly guestId?: string;
  notify(entry: Entry): void;
}
/** One ordinary Score Summary over a frozen set: a table's Hand or Session summary, or one set of a history request. */
interface Entry {
  readonly owner: Owner; attempt: string; outcome: Outcome; readonly members: readonly Dependency[]; aggregating: boolean; notified?: string;
  /** A score-filtered summary's ranges: once every member has succeeded, the mean covers only the members they admit. */
  readonly admits?: (scores: ScoreAverages) => boolean;
  /** How many members `admits` let in, once decided. */
  admitted?: number;
}
interface TableRequest { readonly input: FrozenScoreSummary; identity: Omit<ScoreSummary, 'status'>; readonly entry: Entry }
interface HistoryRequest { readonly input: FrozenHistorySummary; requestId: string; attemptId: string; readonly whole: Entry; readonly buckets: readonly { readonly value: string; readonly entry: Entry }[] }
/** One analysis the coordinator shares between every request that needs it; opaque outside this module. */
export type SharedAnalysis = Dependency;
/**
 * The coordinator's shared analyses, for a request that reads them itself rather than summarizing them (the
 * score-filtered list, `createScoredHistory`).
 */
export interface SharedAnalyses {
  /** The shared analyses of `inputs`, each asked for as the Guest's `history-analysis` unless it has already succeeded. */
  forGuest(inputs: readonly FrozenEvaluationInput[], guestId: string): readonly SharedAnalysis[];
  succeeded(analysis: SharedAnalysis): boolean;
  failed(analysis: SharedAnalysis): Failure | undefined;
  /** A succeeded analysis's scores. */
  scores(analysis: SharedAnalysis): ScoreAverages | undefined;
  /** Asks again for a failed analysis. */
  retry(analysis: SharedAnalysis): void;
}
/**
 * All scopes/owners share this one coordinator and the application's existing runner. A table's summaries from play are
 * admitted under this coordinator's own small bound as `summary-analysis`. A summary from history, Table History's (a
 * compared Strategy's and a former Participant's included) and every Overall History summary, has its analyses submitted
 * at once as the Guest's `history-analysis`, whose per-Guest bound (`history`) holds back the rest of a large set
 * without a capacity error, so its progress covers the whole set.
 */
export function createScoreSummaries(analysis: ReturnType<typeof createAnalysis>, runner: JobRunner, publish: (participantId: string, update: AnalysisUpdate) => void, acceptJobResult: AcceptTableJobResult, history?: HistoryAnalysisScheduler) {
  const requests = new Map<string, TableRequest>();
  const historyRequests = new Map<string, HistoryRequest>();
  const dependencies = new Map<string, Dependency>();
  const waiting: (Dependency | Entry)[] = [];
  /** Each Guest's history admissions, one at a time, so a large set never floods the database. */
  const admissions = new Map<string, Promise<void>>();
  const maximumOutstanding = 2;
  const batchSize = 2;
  let outstanding = 0;
  let stopped = false;
  let pumping: Promise<void> | undefined;
  function terminal(entry: Entry) {
    if (stopped || entry.outcome.status === 'pending' || entry.outcome.status === 'empty' || entry.notified === entry.attempt) return;
    entry.notified = entry.attempt;
    try { entry.owner.notify(entry); } catch { /* HTTP state remains readable. */ }
  }
  const failed = (member: Dependency) => member.retryRequested || member.starting ? undefined : member.failure ?? (member.state?.status === 'error' ? member.state.error : undefined);
  const succeeded = (member: Dependency) => !member.retryRequested && !member.starting && member.state?.status === 'complete';
  /** What a pending summary can do next: wait, fail, or take its mean. */
  const next = (entry: Entry) => entry.members.some(member => failed(member)) ? 'error' : entry.members.every(succeeded) ? 'aggregate' : 'wait';
  async function reduce(entry: Entry) {
    const attempt = entry.attempt;
    if (stopped || entry.outcome.status !== 'pending' || next(entry) === 'wait' || entry.aggregating) return;
    await entry.owner.accept(() => {
      if (stopped || entry.attempt !== attempt || entry.outcome.status !== 'pending') return false;
      const failure = entry.members.map(failed).find(Boolean);
      if (failure) { entry.outcome = immutableData({ status: 'error', error: failure }); terminal(entry); return true; }
      if (next(entry) !== 'aggregate' || entry.aggregating) return true;
      if (entry.admits) {
        entry.admitted = scoresOf(entry).length;
        if (!entry.admitted) { entry.outcome = { status: 'empty' }; return true; }
      }
      entry.aggregating = true;
      if (entry.owner.guestId) aggregate(entry, false); else { waiting.push(entry); schedule(); }
      return true;
    });
  }
  function changed(dependency: Dependency) { for (const entry of dependency.consumers) void reduce(entry); }
  function schedule() { if (!stopped) queueMicrotask(() => { void pump(); }); }
  /** Asks for a dependency's analysis: as its Guest's `history-analysis` at once, otherwise in this coordinator's turn. */
  function ask(dependency: Dependency) {
    if (stopped || dependency.running) return;
    const guestId = dependency.guestId;
    if (!guestId) { if (!dependency.queued) { dependency.queued = true; waiting.push(dependency); schedule(); } return; }
    if (dependency.queued) { waiting.splice(waiting.indexOf(dependency), 1); dependency.queued = false; }
    dependency.running = true;
    const admission = (admissions.get(guestId) ?? Promise.resolve()).then(() => admit(dependency, false));
    admissions.set(guestId, admission);
    void admission.finally(() => { if (admissions.get(guestId) === admission) admissions.delete(guestId); });
  }
  async function release(dependency: Dependency, state?: DecisionAnalysis) {
    await Promise.all(dependency.settlements.values());
    if (state && dependency.observedAttempt !== state.attemptId || !dependency.running) return;
    dependency.running = false;
    if (dependency.counted) { dependency.counted = false; outstanding--; }
    if (dependency.retryRequested && !stopped) ask(dependency);
    schedule();
  }
  function watch(dependency: Dependency, state: DecisionAnalysis) {
    dependency.observedAttempt = state.attemptId; dependency.state = state;
    dependency.settlements.set(state.attemptId, analysis.waitForSettlement(state.tableSessionId, state.requestId, dependency.input.identity.participantId, state.attemptId).then(() => { dependency.settledAttempts.add(state.attemptId); }));
    changed(dependency); void observe(dependency, state);
  }
  async function observe(dependency: Dependency, initial: DecisionAnalysis) {
    try {
      const result = initial.status === 'pending' ? await analysis.waitForResult(initial.tableSessionId, initial.requestId, dependency.input.identity.participantId) : initial;
      if (stopped || !result || dependency.observedAttempt !== initial.attemptId) return;
      if (result.attemptId !== initial.attemptId) { watch(dependency, result); return; }
      if (result.status === 'complete' && dependency.input.acceptedAction && !result.scores) {
        dependency.state = undefined;
        if (!dependency.running) ask(dependency);
      } else dependency.state = result;
      changed(dependency);
    } catch { dependency.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be read.' }; changed(dependency); }
    finally { await release(dependency, initial); }
  }
  async function admit(dependency: Dependency, counted: boolean) {
    if (stopped) { dependency.running = false; return; }
    dependency.queued = false; dependency.running = true; dependency.counted = counted; dependency.starting = true;
    const retry = dependency.retryRequested;
    const previous = dependency.state;
    // A failed attempt discovered through another consumer must settle before this coordinator retries it.
    if (retry && previous?.status === 'error' && !dependency.settledAttempts.has(previous.attemptId)) { dependency.starting = false; watch(dependency, previous); return; }
    dependency.retryRequested = false;
    const schedule: AnalysisSchedule = dependency.guestId ? { purpose: 'history-analysis', guestId: dependency.guestId } : 'summary-analysis';
    try {
      if (retry && previous?.status === 'error') await analysis.retry(previous.tableSessionId, previous.requestId, dependency.input.identity.participantId);
      const state = await analysis.getOrStart(dependency.input, schedule);
      dependency.failure = undefined; dependency.starting = false; watch(dependency, state);
    }
    catch { dependency.starting = false; dependency.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be loaded.' }; changed(dependency); await release(dependency); }
  }
  /** Takes the mean once every analysis has succeeded: in this coordinator's turn for a table, as `history-analysis` for a Guest. */
  /** The scores a summary's mean is taken over: every member's, or with score ranges those the ranges admit. */
  const scoresOf = (entry: Entry) => entry.members.flatMap(member => member.state?.status === 'complete' && member.state.scores && (!entry.admits || entry.admits(member.state.scores)) ? [member.state.scores] : []);
  function aggregate(entry: Entry, counted: boolean) {
    const attempt = entry.attempt;
    const scores = scoresOf(entry);
    const guestId = entry.owner.guestId;
    const handle: JobHandle<ScoreAverages | undefined> = guestId && history ? history.submit(guestId, scores, calculateScoreSummary) : runner.submit('summary-analysis', scores, calculateScoreSummary);
    const completion = handle.result.then(result => entry.owner.accept(() => {
      if (stopped || entry.attempt !== attempt || entry.outcome.status !== 'pending') return false;
      entry.outcome = immutableData(result.ok && result.value ? { status: 'complete', averages: result.value } : { status: 'error', error: { code: result.ok ? 'failed' : result.code, message: 'The summary could not complete.' } });
      terminal(entry); return true;
    })).finally(async () => { await handle.settled; if (counted) outstanding--; schedule(); });
    void completion;
  }
  async function pump(): Promise<void> {
    if (pumping) return pumping;
    const operation = (async () => {
      for (let admitted = 0; !stopped && outstanding < maximumOutstanding && waiting.length && admitted < batchSize; admitted++) {
        const task = waiting.shift()!; outstanding++;
        if ('consumers' in task) await admit(task, true); else aggregate(task, true);
      }
    })();
    pumping = operation;
    try { await operation; } finally { if (pumping === operation) pumping = undefined; if (waiting.length && outstanding < maximumOutstanding) schedule(); }
  }
  /** The shared dependencies for a set's members; a history summary's are run as its Guest's `history-analysis` from now on. */
  function dependenciesOf(members: readonly FrozenEvaluationInput[], guestId?: string): Dependency[] {
    return members.map(member => {
      const key = analysis.matchingKey(member);
      let dependency = dependencies.get(key);
      if (!dependency) { dependency = { input: member, consumers: new Set(), running: false, queued: false, retryRequested: false, starting: false, settlements: new Map(), settledAttempts: new Set(), counted: false }; dependencies.set(key, dependency); }
      if (guestId) dependency.guestId ??= guestId;
      return dependency;
    });
  }
  function entryOf(owner: Owner, members: readonly Dependency[], admits?: (scores: ScoreAverages) => boolean): Entry {
    const entry: Entry = { owner, attempt: randomUUID(), outcome: { status: members.length ? 'pending' : 'empty' }, members, aggregating: false, ...(admits ? { admits } : {}), ...(admits && !members.length ? { admitted: 0 } : {}) };
    for (const member of members) member.consumers.add(entry);
    return entry;
  }
  /** Starts a Retry of a failed summary: a new attempt, and every failed analysis it needs asked for again. */
  function retryEntry(entry: Entry) {
    if (entry.outcome.status !== 'error') return false;
    entry.attempt = randomUUID(); entry.outcome = { status: 'pending' }; entry.aggregating = false; entry.admitted = undefined;
    for (const member of entry.members) {
      if (member.failure || member.state?.status === 'error') { member.retryRequested = true; ask(member); }
    }
    return true;
  }
  const tableSummary = (request: TableRequest): ScoreSummary => immutableData({ ...request.identity, attemptId: request.entry.attempt, ...request.entry.outcome } as ScoreSummary);
  const historySummary = (entry: Entry): HistoryScoreSummary => {
    const total = entry.members.length;
    const decided = entry.outcome.status === 'complete' || entry.outcome.status === 'empty';
    const decisionCount = entry.admits ? entry.admitted : total;
    return immutableData({ ...(decisionCount === undefined ? {} : { decisionCount }), progress: { succeeded: decided ? total : entry.members.filter(succeeded).length, total }, ...entry.outcome } as HistoryScoreSummary);
  };
  const analyses: SharedAnalyses = {
    forGuest(inputs, guestId) {
      const members = dependenciesOf(inputs, guestId);
      for (const member of members) if (!succeeded(member)) ask(member);
      return members;
    },
    succeeded, failed,
    scores: member => member.state?.status === 'complete' ? member.state.scores : undefined,
    retry(member) { member.retryRequested = true; ask(member); },
  };
  const overallSummary = (request: HistoryRequest): OverallHistorySummary => immutableData({
    ok: true as const, requestId: request.requestId, attemptId: request.attemptId, filter: request.input.filter,
    ...(request.input.breakdown ? { breakdown: request.input.breakdown } : {}), referenceStrategy: request.input.referenceStrategy,
    summary: historySummary(request.whole),
    ...(request.input.breakdown ? { buckets: request.buckets.map(bucket => ({ value: bucket.value, summary: historySummary(bucket.entry) })) } : {}),
  });
  return {
    async create(input: FrozenScoreSummary): Promise<ScoreSummary> {
      const { participantId: _participant, members: _members, historyGuestId, ...metadata } = input;
      const requestId = randomUUID();
      const owner: Owner = {
        ...(historyGuestId ? { guestId: historyGuestId } : {}),
        accept: change => acceptJobResult(input.tableSessionId, input.participantId, change),
        notify: entry => publish(input.participantId, { type: 'analysis-update', resource: 'summary', tableSessionId: input.tableSessionId, requestId, attemptId: entry.attempt, status: entry.outcome.status as 'complete' | 'error' }),
      };
      const members = dependenciesOf(input.members, historyGuestId);
      const entry = entryOf(owner, members);
      const request: TableRequest = { input, identity: immutableData({ ok: true as const, ...metadata, requestId, attemptId: entry.attempt, decisionCount: input.decisionIds.length }), entry };
      // Inspect every existing match without submitting missing work or changing its purpose.
      // Passive observations also expose failures beyond the globally bounded admission batch.
      for (const member of members) {
        try {
          const current = await analysis.lookup(member.input);
          member.failure = undefined;
          if (current) {
            if (!member.state || current.attemptId !== member.state.attemptId || current.status !== member.state.status) watch(member, current);
          } else if (!member.running && !member.queued) { member.state = undefined; ask(member); }
        } catch { member.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be loaded.' }; }
      }
      requests.set(requestId, request);
      if (members.length) { await reduce(entry); await pump(); await reduce(entry); }
      return tableSummary(request);
    },
    async retry(tableSessionId: string, requestId: string, participantId: string): Promise<ScoreSummary | undefined> {
      const request = requests.get(requestId);
      if (!request || request.input.participantId !== participantId || request.input.tableSessionId !== tableSessionId) return undefined;
      if (!retryEntry(request.entry)) return tableSummary(request);
      await reduce(request.entry); await pump(); await reduce(request.entry); return tableSummary(request);
    },
    read(tableSessionId: string, requestId: string, participantId: string) {
      const request = requests.get(requestId);
      return request?.input.participantId === participantId && request.input.tableSessionId === tableSessionId ? tableSummary(request) : undefined;
    },
    /**
     * Starts an Overall History summary request. Every analysis it needs is asked for as the Guest's `history-analysis`,
     * reusing any matching analysis or stored result; the per-Guest bound holds back the rest. It answers at once, and
     * `readHistory` reports its progress. Its results are accepted only while every table its decisions come from still
     * accepts its Participant's results, each checked as `acceptJobResult` checks one table's. With score ranges, every
     * summary of it waits for all of its set's analyses and then covers only the decisions the ranges admit.
     */
    createHistory(input: FrozenHistorySummary): OverallHistorySummary {
      const admits = hasScoreFilter(input.filter) ? (scores: ScoreAverages) => matchesScoreFilter(input.filter, scores) : undefined;
      const memberships = membershipsOf(input.members);
      const owner: Owner = {
        guestId: input.guestId,
        async accept(change) {
          for (const { tableSessionId, participantId } of memberships) if (!await acceptJobResult(tableSessionId, participantId, () => true)) return false;
          return change();
        },
        notify: () => {},
      };
      const members = dependenciesOf(input.members, input.guestId);
      const request: HistoryRequest = {
        input, requestId: randomUUID(), attemptId: randomUUID(), whole: entryOf(owner, members, admits),
        buckets: (input.buckets ?? []).map(bucket => ({ value: bucket.value, entry: entryOf(owner, dependenciesOf(bucket.members, input.guestId), admits) })),
      };
      historyRequests.set(request.requestId, request);
      for (const member of members) if (!succeeded(member)) ask(member);
      // Members another summary already holds may have settled: those summaries can complete now.
      for (const entry of [request.whole, ...request.buckets.map(bucket => bucket.entry)]) void reduce(entry);
      return overallSummary(request);
    },
    readHistory(requestId: string, guestId: string): OverallHistorySummary | undefined {
      const request = historyRequests.get(requestId);
      return request?.input.guestId === guestId ? overallSummary(request) : undefined;
    },
    /** Retries every failed summary of the request, asking again for each failed analysis it needs. */
    retryHistory(requestId: string, guestId: string): OverallHistorySummary | undefined {
      const request = historyRequests.get(requestId);
      if (request?.input.guestId !== guestId) return undefined;
      const entries = [request.whole, ...request.buckets.map(bucket => bucket.entry)];
      if (entries.map(retryEntry).some(Boolean)) request.attemptId = randomUUID();
      for (const entry of entries) void reduce(entry);
      return overallSummary(request);
    },
    /** The shared analyses, for the score-filtered list (`createScoredHistory`). */
    analyses,
    stop() { stopped = true; waiting.length = 0; },
  };
}
