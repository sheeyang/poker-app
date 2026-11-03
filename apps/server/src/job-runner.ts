import { immutableData } from '@poker/strategies';

export type JobPurpose = 'bot-decision' | 'live-analysis' | 'interactive-analysis' | 'automatic-analysis' | 'summary-analysis' | 'bulk-research' | 'simulation';
/** Server-owned scheduling policy. Lower numeric priorities dispatch first; starvation is permitted. */
const jobPriorities: Readonly<Record<JobPurpose, number>> = Object.freeze({
  'bot-decision': 0,
  'live-analysis': 1,
  'interactive-analysis': 1,
  'automatic-analysis': 2,
  'summary-analysis': 2,
  'bulk-research': 3,
  simulation: 3,
});

export type JobFailureCode = 'capacity' | 'cancelled' | 'timeout' | 'failed' | 'incompatible' | 'invalid-policy' | 'selection-failed';
export type JobResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: JobFailureCode };
export class JobFailure extends Error { constructor(readonly code: JobFailureCode) { super(code); } }
export interface JobRunnerOptions { readonly concurrency?: number; readonly maximumQueued?: number; readonly timeoutMs?: number }
export interface JobHandle<T> { readonly admitted: boolean; readonly result: Promise<JobResult<T>>; readonly settled: Promise<void>; cancel(): void }
/** A Bot decision advances play, so analysis must never delay or refuse it (ADR-0019, as amended by ADR-0032). */
const advancesPlay = (purpose: JobPurpose) => purpose === 'bot-decision';
/**
 * One bounded owner for server computation. Logical timeout never releases running capacity.
 *
 * Every purpose shares `concurrency` running slots by priority, and one more slot is reserved for Bot decisions, so
 * analysis filling the others never delays one. Bot decisions are also admitted whatever the queue holds: a table has
 * at most one outstanding Bot decision, which bounds them, while `maximumQueued` bounds everything else.
 */
export class JobRunner {
  private readonly concurrency: number;
  private readonly maximumQueued: number;
  private readonly timeoutMs: number;
  private stopped = false;
  private readonly waiting: { readonly priority: number; readonly purpose: JobPurpose; start(): void; cancel(): void }[] = [];
  private readonly running = new Set<{ readonly purpose: JobPurpose; cancel(): void; settled: Promise<void> }>();
  /**
   * Whether a job of `purpose` may start now. At most `concurrency` jobs other than Bot decisions run, and at most
   * `concurrency + 1` in all, so one slot is always left for a Bot decision.
   */
  private canStart(purpose: JobPurpose): boolean {
    return this.running.size < this.concurrency + 1 && (advancesPlay(purpose) || [...this.running].filter(job => !advancesPlay(job.purpose)).length < this.concurrency);
  }
  constructor(options: JobRunnerOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.maximumQueued = options.maximumQueued ?? 16;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (![this.concurrency, this.maximumQueued, this.timeoutMs].every(Number.isSafeInteger) || this.concurrency < 1 || this.maximumQueued < 0 || this.timeoutMs < 1) throw new Error('Invalid JobRunner limits.');
  }
  submit<I, O>(purpose: JobPurpose, input: I, execute: (input: I, options: { readonly signal: AbortSignal }) => O | Promise<O>): JobHandle<O> {
    const full = !advancesPlay(purpose) && !this.canStart(purpose) && this.waiting.filter(job => !advancesPlay(job.purpose)).length >= this.maximumQueued;
    if (this.stopped || full) return { admitted: false, result: Promise.resolve({ ok: false, code: this.stopped ? 'cancelled' : 'capacity' }), settled: Promise.resolve(), cancel() {} };
    const snapshot = immutableData(input);
    const output = Promise.withResolvers<JobResult<O>>();
    const settled = Promise.withResolvers<void>();
    const controller = new AbortController();
    let finished = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: JobResult<O>) => { if (finished) return; finished = true; clearTimeout(timer); output.resolve(result); };
    const task = {
      priority: jobPriorities[purpose],
      purpose,
      start: () => {
        if (finished) return;
        started = true;
        const active = { purpose, cancel: task.cancel, settled: settled.promise };
        this.running.add(active);
        timer = setTimeout(() => { finish({ ok: false, code: 'timeout' }); controller.abort(); }, this.timeoutMs);
        // Only the bounded baseline and cooperative async backends run in-process.
        // Arbitrary CPU backends require a worker adapter; timers cannot preempt synchronous JS.
        void Promise.resolve().then(() => execute(snapshot, { signal: controller.signal })).then(value => {
          if (!finished) finish({ ok: true, value: immutableData(value) });
        }).catch(error => finish({ ok: false, code: error instanceof JobFailure ? error.code : 'failed' })).finally(() => {
          clearTimeout(timer);
          this.running.delete(active);
          settled.resolve();
          this.drain();
        });
      },
      cancel: () => {
        finish({ ok: false, code: 'cancelled' });
        controller.abort();
        if (!started) { const index = this.waiting.indexOf(task); if (index >= 0) this.waiting.splice(index, 1); settled.resolve(); this.drain(); }
      },
    };
    // Inserting after equal priorities preserves FIFO without changing a submitted priority.
    const next = this.waiting.findIndex(waiting => waiting.priority > task.priority);
    if (next < 0) this.waiting.push(task);
    else this.waiting.splice(next, 0, task);
    this.drain();
    return { admitted: true, result: output.promise, settled: settled.promise, cancel: task.cancel };
  }
  /** Starts waiting jobs in priority order while they may start. Bot decisions come first, so none waits behind analysis. */
  private drain() { while (!this.stopped && this.waiting.length && this.canStart(this.waiting[0]!.purpose)) this.waiting.shift()!.start(); }
  async close(): Promise<void> {
    this.stopped = true;
    for (const task of [...this.waiting]) task.cancel();
    for (const task of this.running) task.cancel();
    await Promise.all([...this.running].map(task => task.settled));
  }
}
