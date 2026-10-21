import { randomUUID } from 'node:crypto';
import type { AnalysisFailureCode, AnalysisUpdate, DecisionAnalysis, ScoreSummary, ScoreSummaryScope, ScoreSummaryIdentity, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { calculateScoreSummary } from '@poker/research';
import type { createAnalysis, FrozenEvaluationInput } from './analysis.js';
import type { JobRunner } from './job-runner.js';
import type { AcceptTableJobResult } from './mutations.js';
interface FrozenSummaryMetadata {
  readonly ownerUserId: string; readonly tableSessionId: string;
  readonly capturedPokerRevision: number; readonly referenceStrategy: StrategyDescriptor; readonly decisionIds: readonly string[];
  readonly members: readonly FrozenEvaluationInput[];
}
export type FrozenScoreSummary = FrozenSummaryMetadata & ScoreSummaryScope;
interface Failure { readonly code: AnalysisFailureCode; readonly message: string }
interface Dependency { readonly input: FrozenEvaluationInput; readonly consumers: Set<Entry>; state?: DecisionAnalysis; failure?: Failure; running: boolean; queued: boolean; retryRequested: boolean; starting: boolean; observedAttempt?: string; readonly settlements: Map<string, Promise<void>>; readonly settledAttempts: Set<string> }
interface Entry { readonly input: FrozenScoreSummary; identity: ScoreSummaryIdentity; state: ScoreSummary; readonly members: readonly Dependency[]; aggregating: boolean; notified?: string }
/** All scopes/owners share this one bounded coordinator and the application's existing runner. */
export function createScoreSummaries(analysis: ReturnType<typeof createAnalysis>, runner: JobRunner, publish: (ownerUserId: string, update: AnalysisUpdate) => void, acceptJobResult: AcceptTableJobResult) {
  const requests = new Map<string, Entry>();
  const dependencies = new Map<string, Dependency>();
  const waiting: (Dependency | Entry)[] = [];
  const maximumOutstanding = 2;
  const batchSize = 2;
  let outstanding = 0;
  let stopped = false;
  let pumping: Promise<void> | undefined;
  function terminal(entry: Entry) {
    if (stopped || entry.state.status === 'pending' || entry.state.status === 'empty' || entry.notified === entry.state.attemptId) return;
    entry.notified = entry.state.attemptId;
    try { publish(entry.input.ownerUserId, { type: 'analysis-update', resource: 'summary', tableSessionId: entry.state.tableSessionId, requestId: entry.state.requestId, attemptId: entry.state.attemptId, status: entry.state.status }); } catch { /* HTTP state remains readable. */ }
  }
  async function reduce(entry: Entry) {
    const attemptId = entry.state.attemptId;
    await acceptJobResult(entry.input.tableSessionId, entry.input.ownerUserId, () => {
      if (stopped || entry.state.attemptId !== attemptId || entry.state.status !== 'pending') return false;
      const failure = entry.members.map(member => member.retryRequested || member.starting ? undefined : member.failure ?? (member.state?.status === 'error' ? member.state.error : undefined)).find(Boolean);
      if (failure) { entry.state = immutableData({ ...entry.identity, status: 'error', error: failure }); terminal(entry); return true; }
      if (entry.members.some(member => member.retryRequested || member.starting || member.state?.status !== 'complete')) return true;
      if (!entry.aggregating) { entry.aggregating = true; waiting.push(entry); schedule(); }
      return true;
    });
  }
  function changed(dependency: Dependency) { for (const entry of dependency.consumers) void reduce(entry); }
  function schedule() { if (!stopped) queueMicrotask(() => { void pump(); }); }
  async function release(dependency: Dependency, state?: DecisionAnalysis) {
    await Promise.all(dependency.settlements.values());
    if (state && dependency.observedAttempt !== state.attemptId || !dependency.running) return;
    dependency.running = false; outstanding--;
    if (dependency.retryRequested && !stopped && !dependency.queued) { dependency.queued = true; waiting.push(dependency); }
    schedule();
  }
  function watch(dependency: Dependency, state: DecisionAnalysis) {
    dependency.observedAttempt = state.attemptId; dependency.state = state;
    dependency.settlements.set(state.attemptId, analysis.waitForSettlement(state.tableSessionId, state.requestId, dependency.input.ownerUserId, state.attemptId).then(() => { dependency.settledAttempts.add(state.attemptId); }));
    changed(dependency); void observe(dependency, state);
  }
  async function observe(dependency: Dependency, initial: DecisionAnalysis) {
    try {
      const result = initial.status === 'pending' ? await analysis.waitForResult(initial.tableSessionId, initial.requestId, dependency.input.ownerUserId) : initial;
      if (stopped || !result || dependency.observedAttempt !== initial.attemptId) return;
      if (result.attemptId !== initial.attemptId) { watch(dependency, result); return; }
      if (result.status === 'complete' && dependency.input.acceptedAction && !result.scores) {
        dependency.state = undefined;
        if (!dependency.running && !dependency.queued) { dependency.queued = true; waiting.push(dependency); schedule(); }
      } else dependency.state = result;
      changed(dependency);
    } catch { dependency.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be read.' }; changed(dependency); }
    finally { await release(dependency, initial); }
  }
  async function admit(dependency: Dependency) {
    dependency.queued = false; dependency.running = true; dependency.starting = true;
    const retry = dependency.retryRequested;
    const previous = dependency.state;
    // A failed attempt discovered through another consumer must settle before this coordinator retries it.
    if (retry && previous?.status === 'error' && !dependency.settledAttempts.has(previous.attemptId)) { dependency.starting = false; watch(dependency, previous); return; }
    dependency.retryRequested = false;
    try {
      if (retry && previous?.status === 'error') await analysis.retry(previous.tableSessionId, previous.requestId, dependency.input.ownerUserId);
      const state = await analysis.getOrStart(dependency.input, 'summary-analysis');
      dependency.failure = undefined; dependency.starting = false; watch(dependency, state);
    }
    catch { dependency.starting = false; dependency.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be loaded.' }; changed(dependency); await release(dependency); }
  }
  async function aggregate(entry: Entry) {
    const attemptId = entry.state.attemptId;
    const scores = entry.members.flatMap(member => member.state?.status === 'complete' && member.state.scores ? [member.state.scores] : []);
    const handle = runner.submit('summary-analysis', scores, calculateScoreSummary);
    const completion = handle.result.then(result => acceptJobResult(entry.input.tableSessionId, entry.input.ownerUserId, () => {
      if (stopped || entry.state.attemptId !== attemptId || entry.state.status !== 'pending') return false;
      entry.state = immutableData(result.ok && result.value ? { ...entry.identity, status: 'complete', averages: result.value } : { ...entry.identity, status: 'error', error: { code: result.ok ? 'failed' : result.code, message: 'The summary could not complete.' } });
      terminal(entry); return true;
    })).finally(async () => { await handle.settled; outstanding--; schedule(); });
    void completion;
  }
  async function pump(): Promise<void> {
    if (pumping) return pumping;
    const operation = (async () => {
      for (let admitted = 0; !stopped && outstanding < maximumOutstanding && waiting.length && admitted < batchSize; admitted++) {
        const task = waiting.shift()!; outstanding++;
        if ('consumers' in task) await admit(task); else await aggregate(task);
      }
    })();
    pumping = operation;
    try { await operation; } finally { if (pumping === operation) pumping = undefined; if (waiting.length && outstanding < maximumOutstanding) schedule(); }
  }
  return {
    async create(input: FrozenScoreSummary): Promise<ScoreSummary> {
      const { ownerUserId: _owner, members: _members, ...metadata } = input;
      const identity = immutableData({ ok: true as const, ...metadata, requestId: randomUUID(), attemptId: randomUUID(), decisionCount: input.decisionIds.length });
      const members = input.members.map(member => {
        const key = analysis.matchingKey(member);
        let dependency = dependencies.get(key);
        if (!dependency) { dependency = { input: member, consumers: new Set(), running: false, queued: false, retryRequested: false, starting: false, settlements: new Map(), settledAttempts: new Set() }; dependencies.set(key, dependency); }
        return dependency;
      });
      // Inspect every existing match without submitting missing work or changing its purpose.
      // Passive observations also expose failures beyond the globally bounded admission batch.
      for (const member of members) {
        try {
          const current = await analysis.lookup(member.input);
          member.failure = undefined;
          if (current) {
            if (!member.state || current.attemptId !== member.state.attemptId || current.status !== member.state.status) watch(member, current);
          } else if (!member.running && !member.queued) { member.state = undefined; member.queued = true; waiting.push(member); }
        } catch { member.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be loaded.' }; }
      }
      const entry: Entry = { input, identity, state: immutableData({ ...identity, status: input.members.length ? 'pending' as const : 'empty' as const }), members, aggregating: false };
      requests.set(identity.requestId, entry); for (const member of members) member.consumers.add(entry);
      if (members.length) { await reduce(entry); await pump(); await reduce(entry); }
      return entry.state;
    },
    async retry(tableSessionId: string, requestId: string, ownerUserId: string): Promise<ScoreSummary | undefined> {
      const entry = requests.get(requestId);
      if (!entry || entry.input.ownerUserId !== ownerUserId || entry.state.tableSessionId !== tableSessionId) return undefined;
      if (entry.state.status !== 'error') return entry.state;
      entry.identity = immutableData({ ...entry.identity, attemptId: randomUUID() });
      entry.state = immutableData({ ...entry.identity, status: 'pending' }); entry.aggregating = false;
      for (const member of entry.members) {
        if (member.failure || member.state?.status === 'error') {
          member.retryRequested = true;
          if (!member.running && !member.queued) { member.queued = true; waiting.push(member); }
        }
      }
      await reduce(entry); await pump(); await reduce(entry); return entry.state;
    },
    read(tableSessionId: string, requestId: string, ownerUserId: string) {
      const entry = requests.get(requestId);
      return entry?.input.ownerUserId === ownerUserId && entry.state.tableSessionId === tableSessionId ? entry.state : undefined;
    },
    stop() { stopped = true; waiting.length = 0; },
  };
}
