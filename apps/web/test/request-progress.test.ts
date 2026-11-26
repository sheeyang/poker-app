import { afterEach, expect, test, vi } from 'vitest';
import { baselinePlayingStrategy, type HistoryScoreSummary, type OverallHistorySummary, type ProgressUpdate, type ScoredOverallHistory } from '@poker/contracts';
import { followedScored, followedSummary } from '../src/overall-history.js';
import { afterProgress, afterResponse, createRequestFollower } from '../src/request-progress.js';

afterEach(() => { vi.useRealTimers(); });

const identity = { ok: true as const, requestId: 'request-1', attemptId: 'attempt-1', filter: { decisionScore: { min: 0.5 } }, referenceStrategy: baselinePlayingStrategy };
const pending = (succeeded: number, attemptId = 'attempt-1'): ScoredOverallHistory => ({ ...identity, attemptId, status: 'pending', progress: { succeeded, total: 5 } });
const failed = (succeeded: number): ScoredOverallHistory => ({ ...identity, status: 'error', progress: { succeeded, total: 5 }, error: { code: 'failed', message: 'An analysis failed.' } });
const listed: ScoredOverallHistory = { ...identity, status: 'complete', progress: { succeeded: 5, total: 5 }, total: 0, offset: 0, decisions: [] };
const progress = (succeeded: number, requestId = 'request-1', resource: 'overall-history-scored' | 'overall-history-summary' = 'overall-history-scored'): ProgressUpdate => ({ type: 'progress', progress: [{ resource, requestId, succeeded, total: 5 }] });
const notice = (status: 'complete' | 'error', requestId = 'request-1') => ({ type: 'overall-history-update' as const, resource: 'overall-history-scored' as const, requestId, attemptId: 'attempt-1', status });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * A follower over a fake server: `server` is what the next answer says, and every request it is asked is counted. A
 * request may be held (`hold`), so it answers only when released, as a slow response would.
 */
function follow(first: ScoredOverallHistory) {
  let server = first;
  const asked: string[] = [];
  const held: { kind: string; release: () => void }[] = [];
  let holding: string | undefined;
  const answer = (kind: string, value: () => ScoredOverallHistory) => {
    asked.push(kind);
    if (holding !== kind) return Promise.resolve(value());
    holding = undefined;
    const answered = value();
    return new Promise<ScoredOverallHistory>(resolve => held.push({ kind, release: () => resolve(answered) }));
  };
  const follower = createRequestFollower({
    model: followedScored,
    create: () => answer('create', () => server),
    read: () => answer('read', () => server),
    retry: () => answer('retry', () => server),
  });
  follower.start();
  return {
    follower, asked,
    set(next: ScoredOverallHistory) { server = next; },
    /** The next request of this kind answers with what the server says now, but only once released. */
    hold(kind: string) { holding = kind; },
    release(kind: string) { const index = held.findIndex(each => each.kind === kind); held.splice(index, 1)[0]!.release(); },
    shown: () => follower.snapshot().data,
    reads: () => asked.filter(kind => kind === 'read').length,
  };
}

test('a late progress message after completion or failure is ignored', async () => {
  const f = follow(pending(1));
  await settle();
  f.follower.progress(progress(3));
  expect(f.shown()).toMatchObject({ status: 'pending', progress: { succeeded: 3, total: 5 } });
  f.set(listed);
  f.follower.notice(notice('complete'));
  await settle();
  expect(f.shown()).toEqual(listed);
  // A count sent before the list was decided, arriving after it.
  f.follower.progress(progress(4));
  expect(f.shown()).toEqual(listed);
  // Held as failed, too.
  const g = follow(failed(2));
  await settle();
  g.follower.progress(progress(4));
  expect(g.shown()).toEqual(failed(2));
  // Another request's count, or another resource's, is not this one's.
  const h = follow(pending(1));
  await settle();
  h.follower.progress(progress(4, 'request-2'));
  h.follower.progress(progress(4, 'request-1', 'overall-history-summary'));
  expect(h.shown()).toEqual(pending(1));
});

test("a stale lower count, from a message or from a read already on its way, never lowers the count on show", async () => {
  const f = follow(pending(1));
  await settle();
  f.follower.progress(progress(4));
  f.follower.progress(progress(2));
  expect(f.shown()?.progress).toEqual({ succeeded: 4, total: 5 });
  // A read that left the server at 3 arrives after the message said 4: still pending, still 4.
  f.set(pending(3));
  f.follower.ready();
  await settle();
  expect(f.shown()).toMatchObject({ status: 'pending', progress: { succeeded: 4, total: 5 } });
  // The pure rules agree.
  expect(afterProgress(followedScored, pending(4), progress(2))).toEqual(pending(4));
  expect(afterResponse(followedScored, pending(4), pending(3))).toEqual(pending(4));
  expect(afterResponse(followedScored, pending(3), pending(4))).toEqual(pending(4));
});

test('a Retry, and an HTTP read that shows the request pending, resume following its progress', async () => {
  const f = follow(pending(1));
  await settle();
  f.set(failed(4));
  f.follower.notice(notice('error'));
  await settle();
  expect(f.shown()).toEqual(failed(4));
  f.follower.progress(progress(5));
  expect(f.shown()).toEqual(failed(4));
  // Retry answers pending, in a new attempt: its count is followed again.
  f.set(pending(4, 'attempt-2'));
  await f.follower.retry();
  expect(f.shown()).toEqual(pending(4, 'attempt-2'));
  f.follower.progress(progress(5));
  expect(f.shown()?.progress).toEqual({ succeeded: 5, total: 5 });
  // A read that shows it pending again (held as failed, then read pending) does the same.
  const g = follow(failed(2));
  await settle();
  g.set(pending(2, 'attempt-2'));
  g.follower.notice(notice('error'));
  await settle();
  g.follower.progress(progress(3));
  expect(g.shown()).toMatchObject({ status: 'pending', progress: { succeeded: 3, total: 5 } });
  // A failed read during the Retry answer's wait never replaces it: the read leaves before, so it is read again after.
  const h = follow(pending(1));
  await settle();
  h.set(failed(4));
  h.hold('read');
  h.follower.notice(notice('error'));
  h.set(pending(4, 'attempt-2'));
  const retried = h.follower.retry();
  h.release('read');
  await retried;
  await settle();
  expect(h.shown()).toEqual(pending(4, 'attempt-2'));
});

test('nothing is read while pending, however long it runs; each notice reads it once, reaching complete, Error and Retry', async () => {
  vi.useFakeTimers();
  const f = follow(pending(0));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.asked).toEqual(['create']);
  // A minute of progress messages, and nothing else.
  for (let second = 1; second <= 4; second++) { f.follower.progress(progress(second)); await vi.advanceTimersByTimeAsync(15_000); }
  expect(f.asked).toEqual(['create']);
  expect(f.shown()?.progress).toEqual({ succeeded: 4, total: 5 });
  // The failure notice reads it once: Error.
  f.set(failed(4));
  f.follower.notice(notice('error'));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.asked).toEqual(['create', 'read']);
  expect(f.shown()?.status).toBe('error');
  // Retry, then nothing until the completion notice, which reads it once: complete.
  f.set(pending(4, 'attempt-2'));
  await f.follower.retry();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.asked).toEqual(['create', 'read', 'retry']);
  f.set({ ...listed, attemptId: 'attempt-2' });
  f.follower.notice(notice('complete'));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.asked).toEqual(['create', 'read', 'retry', 'read']);
  expect(f.shown()).toMatchObject({ status: 'complete', attemptId: 'attempt-2' });
  // Settled: nothing more is read, even when the channel is ready again.
  f.follower.ready();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.reads()).toBe(2);
});

test('after the user channel is ready again, a pending request is read once over HTTP', async () => {
  const f = follow(pending(1));
  await settle();
  f.set(pending(3));
  f.follower.ready();
  await settle();
  expect(f.reads()).toBe(1);
  expect(f.shown()?.progress).toEqual({ succeeded: 3, total: 5 });
  // Ready while a read is on its way: one more read after it, not one each.
  f.hold('read');
  f.follower.ready();
  f.follower.ready();
  f.follower.ready();
  f.set(listed);
  f.release('read');
  await settle();
  expect(f.reads()).toBe(3);
  expect(f.shown()).toEqual(listed);
});

test('a notice, or readiness, that arrives while the request is still being asked for is not lost', async () => {
  const f = follow(pending(0));
  // The answer to the request itself is on its way: hold it (`follow` asked already, so ask again).
  f.hold('create');
  f.follower.again();
  f.follower.notice(notice('complete'));
  f.set(listed);
  f.release('create');
  await settle();
  // It answered pending, from before its completion: read once, and complete.
  expect(f.reads()).toBe(1);
  expect(f.shown()).toEqual(listed);
});

test('a summary request is followed by its whole set: its count, and every bucket still Analyzing for a reconnect', () => {
  const summary = (status: 'pending' | 'complete', succeeded: number): HistoryScoreSummary => status === 'pending' ? { status, decisionCount: 5, progress: { succeeded, total: 5 } } : { status, decisionCount: 5, progress: { succeeded, total: 5 }, averages: { decisionScore: 1, actionRankScore: 1 } };
  const request = (whole: HistoryScoreSummary, bucket: HistoryScoreSummary): OverallHistorySummary => ({ ok: true, requestId: 'request-1', attemptId: 'attempt-1', filter: {}, breakdown: 'street', referenceStrategy: baselinePlayingStrategy, summary: whole, buckets: [{ value: 'flop', summary: bucket }] });
  const running = request(summary('pending', 2), summary('pending', 0));
  expect(afterProgress(followedSummary, running, progress(3, 'request-1', 'overall-history-summary'))?.summary.progress).toEqual({ succeeded: 3, total: 5 });
  // The count is the whole set's: a bucket's own stands as read.
  expect(afterProgress(followedSummary, running, progress(3, 'request-1', 'overall-history-summary'))?.buckets).toEqual(running.buckets);
  // The whole set complete with a bucket still Analyzing: no count follows, but there is still something to read.
  const wholeDone = request(summary('complete', 5), summary('pending', 1));
  expect(followedSummary.pending(wholeDone)).toBe(false);
  expect(followedSummary.settled(wholeDone)).toBe(false);
  expect(afterProgress(followedSummary, wholeDone, progress(4, 'request-1', 'overall-history-summary'))).toBe(wholeDone);
  expect(followedSummary.settled(request(summary('complete', 5), summary('complete', 1)))).toBe(true);
});
