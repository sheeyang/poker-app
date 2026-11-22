import type { JobHandle, JobResult, JobRunner } from './job-runner.js';

/** The most `history-analysis` jobs one Guest may have submitted to the JobRunner and not yet settled (ADR-0041). */
export const maximumOutstandingHistoryJobs = 8;

/**
 * Submits `history-analysis` work, the analysis a Table History or Overall History request schedules, under its
 * per-Guest bound. A Guest has at most `maximumOutstanding` such jobs in the JobRunner, queued or running; the rest
 * are held here, in the order they were asked for, and each is submitted as one of that Guest's earlier jobs settles.
 * Held work is not a capacity error: its handle is admitted at once and its result arrives once it has run, so a set
 * of any size completes. The bound is what keeps the JobRunner's queue bounded for this purpose (see `JobRunner`).
 *
 * A job counts until it settles, not until its result: a timed-out job still holds its running slot.
 */
export function createHistoryAnalysisScheduler(runner: JobRunner, maximumOutstanding = maximumOutstandingHistoryJobs) {
  interface Held { submit(): void; cancel(): void }
  const outstanding = new Map<string, number>();
  const held = new Map<string, Held[]>();
  function next(guestId: string) {
    const queue = held.get(guestId);
    const job = queue?.shift();
    if (queue && !queue.length) held.delete(guestId);
    job?.submit();
  }
  return {
    submit<I, O>(guestId: string, input: I, execute: (input: I, options: { readonly signal: AbortSignal }) => O | Promise<O>): JobHandle<O> {
      const result = Promise.withResolvers<JobResult<O>>();
      const settled = Promise.withResolvers<void>();
      let handle: JobHandle<O> | undefined, cancelled = false;
      const job: Held = {
        submit() {
          outstanding.set(guestId, (outstanding.get(guestId) ?? 0) + 1);
          handle = runner.submit('history-analysis', input, execute);
          void handle.result.then(result.resolve);
          void handle.settled.then(() => {
            const count = outstanding.get(guestId)! - 1;
            if (count) outstanding.set(guestId, count); else outstanding.delete(guestId);
            settled.resolve();
            next(guestId);
          });
        },
        cancel() {
          if (cancelled) return;
          cancelled = true;
          if (handle) { handle.cancel(); return; }
          const queue = held.get(guestId) ?? [];
          queue.splice(queue.indexOf(job), 1);
          if (!queue.length) held.delete(guestId);
          result.resolve({ ok: false, code: 'cancelled' });
          settled.resolve();
        },
      };
      if ((outstanding.get(guestId) ?? 0) < maximumOutstanding) job.submit();
      else { const queue = held.get(guestId) ?? []; queue.push(job); held.set(guestId, queue); }
      return { admitted: true, result: result.promise, settled: settled.promise, cancel: () => job.cancel() };
    },
  };
}
export type HistoryAnalysisScheduler = ReturnType<typeof createHistoryAnalysisScheduler>;
