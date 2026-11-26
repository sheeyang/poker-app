import { expect, test } from 'vitest';
import { JobRunner, type JobPurpose } from '../src/job-runner.js';

// The server-owned scheduling policy (ADR-0019, as amended by ADR-0041), seen through the order jobs start in.
test('queued jobs start by purpose: play and live study first, then post-action and summaries, then history-analysis, then simulation', async () => {
  const runner = new JobRunner({ concurrency: 1, maximumQueued: 16 });
  const started: JobPurpose[] = [];
  const blocker = Promise.withResolvers<void>();
  const first = runner.submit('interactive-analysis', null, () => blocker.promise);
  const purposes: JobPurpose[] = ['simulation', 'history-analysis', 'bulk-research', 'summary-analysis', 'automatic-analysis', 'interactive-analysis', 'live-analysis'];
  const handles = purposes.map(purpose => runner.submit(purpose, null, () => { started.push(purpose); }));
  expect(handles.every(handle => handle.admitted)).toBe(true);
  blocker.resolve();
  await Promise.all([first, ...handles].map(handle => handle.settled));
  // FIFO within a priority: `bulk-research` was submitted after `history-analysis`, at the same priority 3.
  expect(started).toEqual(['interactive-analysis', 'live-analysis', 'summary-analysis', 'automatic-analysis', 'history-analysis', 'bulk-research', 'simulation']);
  await runner.close();
});
