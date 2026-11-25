import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { baselinePlayingStrategy, type ProgressUpdate, type ScoreSummary } from '@poker/contracts';
import { followedTableSummary } from '../src/table-history.js';
import { afterProgress, afterResponse, createRequestFollower } from '../src/request-progress.js';

// A table's Score Summaries (a Hand's, the Session's, Table History's) on the user channel: the same client rules as
// Overall History's requests, followed under the `summary` resource, with nothing read on a timer.
afterEach(() => { vi.useRealTimers(); });

const identity = { ok: true as const, tableSessionId: 'table-1', requestId: 'request-1', capturedPokerRevision: 1, decisionIds: [], decisionCount: 5, referenceStrategy: baselinePlayingStrategy, scope: 'table-session' as const };
const pending = (succeeded: number, attemptId = 'attempt-1'): ScoreSummary => ({ ...identity, attemptId, status: 'pending', progress: { succeeded, total: 5 } });
const failed = (succeeded: number): ScoreSummary => ({ ...identity, attemptId: 'attempt-1', status: 'error', progress: { succeeded, total: 5 }, error: { code: 'failed', message: 'An analysis failed.' } });
const complete = (attemptId = 'attempt-1'): ScoreSummary => ({ ...identity, attemptId, status: 'complete', progress: { succeeded: 5, total: 5 }, averages: { decisionScore: 1, actionRankScore: 1 } });
const progress = (succeeded: number, requestId = 'request-1', resource: 'summary' | 'overall-history-summary' = 'summary'): ProgressUpdate => ({ type: 'progress', progress: [{ resource, requestId, succeeded, total: 5 }] });
/** What the server publishes when a table summary completes or fails: an analysis update of the `summary` resource. */
const notice = (status: 'complete' | 'error', requestId = 'request-1', resource: 'summary' | 'analysis' = 'summary') => ({ type: 'analysis-update' as const, tableSessionId: 'table-1', resource, requestId, attemptId: 'attempt-1', status });

function follow(first: ScoreSummary) {
  let server = first;
  const asked: string[] = [];
  const follower = createRequestFollower({
    model: followedTableSummary,
    create: () => { asked.push('create'); return Promise.resolve(server); },
    read: () => { asked.push('read'); return Promise.resolve(server); },
    retry: () => { asked.push('retry'); return Promise.resolve(server); },
  });
  follower.start();
  return { follower, asked, set(next: ScoreSummary) { server = next; }, shown: () => follower.snapshot().data };
}

test('a pending table summary follows progress: its count rises, and a stale lower one or one for another request changes nothing', () => {
  const held = pending(2);
  expect(afterProgress(followedTableSummary, held, progress(4))).toMatchObject({ status: 'pending', progress: { succeeded: 4, total: 5 } });
  expect(afterProgress(followedTableSummary, held, progress(1))).toBe(held);
  expect(afterProgress(followedTableSummary, held, progress(2))).toBe(held);
  expect(afterProgress(followedTableSummary, held, progress(4, 'request-2'))).toBe(held);
  // Another resource's count under the same request ID is not this summary's.
  expect(afterProgress(followedTableSummary, held, progress(4, 'request-1', 'overall-history-summary'))).toBe(held);
  // A read that left the server before the count did never lowers what is shown.
  expect(afterResponse(followedTableSummary, pending(4), pending(3))).toEqual(pending(4));
});

test('a late progress message after completion or failure is ignored, and a Retry or a pending read follows progress again', async () => {
  const f = follow(pending(1));
  await vi.waitFor(() => expect(f.shown()).toBeDefined());
  f.set(complete());
  f.follower.notice(notice('complete'));
  await vi.waitFor(() => expect(f.shown()?.status).toBe('complete'));
  f.follower.progress(progress(3));
  expect(f.shown()).toEqual(complete());
  const g = follow(failed(4));
  await vi.waitFor(() => expect(g.shown()?.status).toBe('error'));
  g.follower.progress(progress(5));
  expect(g.shown()).toEqual(failed(4));
  g.set(pending(4, 'attempt-2'));
  await g.follower.retry();
  g.follower.progress(progress(5));
  expect(g.shown()).toMatchObject({ status: 'pending', progress: { succeeded: 5, total: 5 } });
});

test("nothing is read while a table summary is pending, however long; its notices read it once, to complete, to Error, and after a Retry", async () => {
  vi.useFakeTimers();
  const f = follow(pending(0));
  await vi.advanceTimersByTimeAsync(0);
  for (let second = 1; second <= 4; second++) { f.follower.progress(progress(second)); await vi.advanceTimersByTimeAsync(15_000); }
  expect(f.asked).toEqual(['create']);
  expect(f.shown()?.progress).toEqual({ succeeded: 4, total: 5 });
  // Another request's notice, and an analysis' (not a summary's), read nothing.
  f.follower.notice(notice('complete', 'request-2'));
  f.follower.notice(notice('complete', 'request-1', 'analysis'));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.asked).toEqual(['create']);
  f.set(failed(4));
  f.follower.notice(notice('error'));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.asked).toEqual(['create', 'read']);
  expect(f.shown()?.status).toBe('error');
  f.set(pending(4, 'attempt-2'));
  await f.follower.retry();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.asked).toEqual(['create', 'read', 'retry']);
  f.set(complete('attempt-2'));
  f.follower.notice(notice('complete'));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.asked).toEqual(['create', 'read', 'retry', 'read']);
  expect(f.shown()).toMatchObject({ status: 'complete', attemptId: 'attempt-2' });
  f.follower.ready();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.asked.filter(kind => kind === 'read')).toHaveLength(2);
});

test('no web code polls: nothing in the web app or its client reads on a timer', () => {
  const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
  const roots = [join(__dirname, '../src'), join(__dirname, '../../../packages/client/src')];
  const files = roots.flatMap(sources);
  expect(files.length).toBeGreaterThan(20);
  expect(files.some(file => /polled-request/.test(file))).toBe(false);
  for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/refetchInterval|setInterval|usePolledRequest|polled-request/);
});
