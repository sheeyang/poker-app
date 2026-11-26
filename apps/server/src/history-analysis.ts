import type { JobHandle, JobResult, JobRunner } from './job-runner.js';

/** The most `history-analysis` jobs one User may have submitted to the JobRunner and not yet settled (ADR-0041). */
export const maximumOutstandingHistoryJobs = 8;

/**
 * Submits `history-analysis` work, the analysis a Table History or Overall History request schedules, under its
 * per-User bound. A User has at most `maximumOutstanding` such jobs in the JobRunner, queued or running; the rest
 * are held here, in the order they were asked for, and each is submitted as one of that User's earlier jobs settles.
 * Held work is not a capacity error: its handle is admitted at once and its result arrives once it has run, so a set
 * of any size completes. The bound is what keeps the JobRunner's queue bounded for this purpose (see `JobRunner`).
 *
 * A job counts until it settles, not until its result: a timed-out job still holds its running slot.
 */
export function createHistoryAnalysisScheduler(runner: JobRunner, maximumOutstanding = maximumOutstandingHistoryJobs) {
  interface Held { submit(): void; cancel(): void }
  const outstanding = new Map<string, number>();
  const held = new Map<string, Held[]>();
  function next(userId: string) {
    const queue = held.get(userId);
    const job = queue?.shift();
    if (queue && !queue.length) held.delete(userId);
    job?.submit();
  }
  return {
    submit<I, O>(userId: string, input: I, execute: (input: I, options: { readonly signal: AbortSignal }) => O | Promise<O>): JobHandle<O> {
      const result = Promise.withResolvers<JobResult<O>>();
      const settled = Promise.withResolvers<void>();
      let handle: JobHandle<O> | undefined, cancelled = false;
      const job: Held = {
        submit() {
          outstanding.set(userId, (outstanding.get(userId) ?? 0) + 1);
          handle = runner.submit('history-analysis', input, execute);
          void handle.result.then(result.resolve);
          void handle.settled.then(() => {
            const count = outstanding.get(userId)! - 1;
            if (count) outstanding.set(userId, count); else outstanding.delete(userId);
            settled.resolve();
            next(userId);
          });
        },
        cancel() {
          if (cancelled) return;
          cancelled = true;
          if (handle) { handle.cancel(); return; }
          const queue = held.get(userId) ?? [];
          queue.splice(queue.indexOf(job), 1);
          if (!queue.length) held.delete(userId);
          result.resolve({ ok: false, code: 'cancelled' });
          settled.resolve();
        },
      };
      if ((outstanding.get(userId) ?? 0) < maximumOutstanding) job.submit();
      else { const queue = held.get(userId) ?? []; queue.push(job); held.set(userId, queue); }
      return { admitted: true, result: result.promise, settled: settled.promise, cancel: () => job.cancel() };
    },
  };
}
export type HistoryAnalysisScheduler = ReturnType<typeof createHistoryAnalysisScheduler>;
