import { randomUUID } from 'node:crypto';
import type { AnalysisFailureCode, DecisionAnalysis, ScoreAverages } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { calculateScoreSummary } from '@poker/research';
import type { AnalysisSchedule, createAnalysis, FrozenEvaluationInput } from './analysis.js';
import type { JobHandle, JobRunner } from './job-runner.js';
import type { HistoryAnalysisScheduler } from './history-analysis.js';
export interface Failure { readonly code: AnalysisFailureCode; readonly message: string }
export interface Dependency {
  readonly input: FrozenEvaluationInput; readonly consumers: Set<Entry>; state?: DecisionAnalysis; failure?: Failure;
  running: boolean; queued: boolean; retryRequested: boolean; starting: boolean; observedAttempt?: string;
  readonly settlements: Map<string, Promise<void>>; readonly settledAttempts: Set<string>;
  /** Set once a history summary needs it: then it runs as that Guest's `history-analysis`, outside this coordinator's bound. */
  guestId?: string;
  /** Whether it holds one of this coordinator's own admission places. */
  counted: boolean;
  /** Whether it is counted as succeeded in its consumers' running totals (`Entry.succeeded`). */
  tallied: boolean;
}
export type Outcome =
  | { readonly status: 'empty' | 'pending' }
  | { readonly status: 'complete'; readonly averages: ScoreAverages }
  | { readonly status: 'error'; readonly error: Failure }
  /** A set that takes no mean (`Entry.list`): every analysis of it has succeeded. */
  | { readonly status: 'succeeded' };
/** Where a summary's results are accepted, whose bound its jobs run under, and whom its states are told. */
export interface Owner {
  /** Applies `change` when the summary's results may still be accepted; whether it was applied. */
  accept(change: () => boolean): Promise<boolean>;
  /** The Guest whose `history-analysis` bound a history summary's jobs run under; absent for a table's own summary. */
  readonly guestId?: string;
  /** The entry left pending: complete, error, or decided empty by its score ranges. Once per attempt. */
  notify(entry: Entry): void;
  /** One of the entry's analyses succeeded (or stopped counting as succeeded): its running total changed. */
  progress?(entry: Entry): void;
}
/**
 * One ordinary Score Summary over a frozen set: a table's Hand or Session summary, or one set of a history request.
 * The score-filtered list is one too, taking no mean (`list`), so it shares every rule of a summary's state.
 */
export interface Entry {
  readonly owner: Owner; attempt: string; outcome: Outcome; readonly members: readonly Dependency[]; aggregating: boolean; notified?: string;
  /** A score-filtered summary's ranges: once every member has succeeded, the mean covers only the members they admit. */
  readonly admits?: (scores: ScoreAverages) => boolean;
  /** How many members `admits` let in, once decided. */
  admitted?: number;
  /** A set read as a list rather than summarized: once every member has succeeded it is `succeeded`, with no mean. */
  readonly list?: true;
  /** The running total: how many members have succeeded, kept as each settles and never recounted. */
  succeeded: number;
}
/** One analysis the coordinator shares between every request that needs it; opaque outside this module. */
export type SharedAnalysis = Dependency;
/** What a set of a Guest's analyses is followed as: a summary, with or without score ranges, or the score-filtered list. */
export interface GuestSet { readonly admits?: (scores: ScoreAverages) => boolean; readonly list?: true }
/**
 * How far an entry has got, from its running total: every member once it is decided (complete, empty or succeeded),
 * however a member's state has moved since.
 */
export function progressOf(entry: Entry): { readonly succeeded: number; readonly total: number } {
  const total = entry.members.length;
  return { succeeded: entry.outcome.status === 'pending' || entry.outcome.status === 'error' ? entry.succeeded : total, total };
}
/** A succeeded member's scores. */
export const scoresOfMember = (member: SharedAnalysis): ScoreAverages | undefined => member.state?.status === 'complete' ? member.state.scores : undefined;
/**
 * The analyses every Score Summary shares: one coordinator over the application's existing runner, so a decision that
 * more than one request needs is analyzed once. A table's summaries from play are admitted under this coordinator's
 * own small bound as `summary-analysis`. A summary from history, Table History's (a compared Strategy's and a former
 * Participant's included) and every Overall History summary, has its analyses submitted at once as the Guest's
 * `history-analysis`, whose per-Guest bound (`history`) holds back the rest of a large set without a capacity
 * error, so its progress covers the whole set. The table summaries, the Overall History summaries and the
 * score-filtered list are built on it. Each entry keeps a running total of its succeeded members, moved as each one
 * settles, which its owner hears of (`Owner.progress`) and every count is read from.
 */
export function createSharedAnalyses(analysis: ReturnType<typeof createAnalysis>, runner: JobRunner, history?: HistoryAnalysisScheduler) {
  const dependencies = new Map<string, Dependency>();
  const waiting: (Dependency | Entry)[] = [];
  /** Each Guest's history admissions, one at a time, so a large set never floods the database. */
  const admissions = new Map<string, Promise<void>>();
  const maximumOutstanding = 2;
  const batchSize = 2;
  let outstanding = 0;
  let stopped = false;
  let pumping: Promise<void> | undefined;
  /** Tells the owner its entry left pending: called only on that change, so an entry empty from the start is never told. */
  function terminal(entry: Entry) {
    if (stopped || entry.outcome.status === 'pending' || entry.notified === entry.attempt) return;
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
        if (!entry.admitted) { entry.outcome = { status: 'empty' }; terminal(entry); return true; }
      }
      if (entry.list) { entry.outcome = { status: 'succeeded' }; terminal(entry); return true; }
      entry.aggregating = true;
      if (entry.owner.guestId) aggregate(entry, false); else { waiting.push(entry); schedule(); }
      return true;
    });
  }
  /** A dependency's state moved: its consumers' running totals follow it, and each consumer may settle. */
  function changed(dependency: Dependency) {
    const now = succeeded(dependency);
    if (now !== dependency.tallied) {
      dependency.tallied = now;
      for (const entry of dependency.consumers) {
        entry.succeeded += now ? 1 : -1;
        try { entry.owner.progress?.(entry); } catch { /* HTTP state remains readable. */ }
      }
    }
    for (const entry of dependency.consumers) void reduce(entry);
  }
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
      if (!dependency) { dependency = { input: member, consumers: new Set(), running: false, queued: false, retryRequested: false, starting: false, settlements: new Map(), settledAttempts: new Set(), counted: false, tallied: false }; dependencies.set(key, dependency); }
      if (guestId) dependency.guestId ??= guestId;
      return dependency;
    });
  }
  function entryOf(owner: Owner, members: readonly Dependency[], { admits, list }: GuestSet = {}): Entry {
    const entry: Entry = {
      owner, attempt: randomUUID(), outcome: { status: members.length ? 'pending' : 'empty' }, members, aggregating: false,
      ...(admits ? { admits } : {}), ...(admits && !members.length ? { admitted: 0 } : {}), ...(list ? { list } : {}),
      // Counted once, as the entry starts; from then on it moves only as a member settles.
      succeeded: members.filter(member => member.tallied).length,
    };
    for (const member of members) member.consumers.add(entry);
    return entry;
  }
  /**
   * A set of the Guest's analyses, followed as one entry of `owner`'s: each analysis is asked for as their
   * `history-analysis` unless it has already succeeded (matching analyses and stored results are reused), and an entry
   * whose members have all settled already can settle now.
   */
  function forGuest(owner: Owner & { readonly guestId: string }, inputs: readonly FrozenEvaluationInput[], set: GuestSet = {}): Entry {
    const members = dependenciesOf(inputs, owner.guestId);
    const entry = entryOf(owner, members, set);
    for (const member of members) if (!succeeded(member)) ask(member);
    void reduce(entry);
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
  return {
    succeeded, ask, watch, reduce, pump, dependenciesOf, entryOf, forGuest, retryEntry,
    stop() { stopped = true; waiting.length = 0; },
  };
}
export type SharedAnalysisCoordinator = ReturnType<typeof createSharedAnalyses>;
