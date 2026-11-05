import { acquireSlot } from './test-slots.js';

/** Vitest global setup: a test run holds one machine-wide slot (see test-slots.ts) from start to finish. */
export default async function setup() {
  const slot = await acquireSlot({
    onWait: holders =>
      console.error(`[test] Waiting for a free test slot, held by ${holders}. Another test run is using the machine; this run starts when it ends. POKER_TEST_SLOTS raises the limit.`),
  });
  return () => slot.release();
}
