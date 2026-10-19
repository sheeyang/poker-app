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
export interface JobHandle<T> { readonly result: Promise<JobResult<T>>; cancel(): void }
/** One bounded owner for server computation. Logical timeout never releases running capacity. */
export class JobRunner {
  private readonly concurrency: number;
  private readonly maximumQueued: number;
  private readonly timeoutMs: number;
  private stopped = false;
  private readonly waiting: { readonly priority: number; start(): void; cancel(): void }[] = [];
  private readonly running = new Set<{ cancel(): void; settled: Promise<void> }>();
  constructor(options: JobRunnerOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.maximumQueued = options.maximumQueued ?? 16;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (![this.concurrency, this.maximumQueued, this.timeoutMs].every(Number.isSafeInteger) || this.concurrency < 1 || this.maximumQueued < 0 || this.timeoutMs < 1) throw new Error('Invalid JobRunner limits.');
  }
  submit<I, O>(purpose: JobPurpose, input: I, execute: (input: I, options: { readonly signal: AbortSignal }) => O | Promise<O>): JobHandle<O> {
    if (this.stopped || (this.running.size >= this.concurrency && this.waiting.length >= this.maximumQueued)) return { result: Promise.resolve({ ok: false, code: this.stopped ? 'cancelled' : 'capacity' }), cancel() {} };
    const snapshot = immutableData(input);
    const output = Promise.withResolvers<JobResult<O>>();
    const controller = new AbortController();
    let finished = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: JobResult<O>) => { if (finished) return; finished = true; clearTimeout(timer); output.resolve(result); };
    const task = {
      priority: jobPriorities[purpose],
      start: () => {
        if (finished) return;
        started = true;
        const settled = Promise.withResolvers<void>();
        const active = { cancel: task.cancel, settled: settled.promise };
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
        if (!started) { const index = this.waiting.indexOf(task); if (index >= 0) this.waiting.splice(index, 1); this.drain(); }
      },
    };
    // Inserting after equal priorities preserves FIFO without changing a submitted priority.
    const next = this.waiting.findIndex(waiting => waiting.priority > task.priority);
    if (next < 0) this.waiting.push(task);
    else this.waiting.splice(next, 0, task);
    this.drain();
    return { result: output.promise, cancel: task.cancel };
  }
  private drain() { while (!this.stopped && this.running.size < this.concurrency && this.waiting.length) this.waiting.shift()!.start(); }
  async close(): Promise<void> {
    this.stopped = true;
    for (const task of [...this.waiting]) task.cancel();
    for (const task of this.running) task.cancel();
    await Promise.all([...this.running].map(task => task.settled));
  }
}
