import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
if (existsSync('.env')) process.loadEnvFile('.env');
// Every server test file starts a real server against PostgreSQL, so many files in parallel starve each other's polling
// waits. A run uses at most four workers (POKER_TEST_WORKERS overrides), and scripts/vitest-slot.ts limits how many
// runs share the machine.
const configuredWorkers = Number(process.env.POKER_TEST_WORKERS);
const maxWorkers = Number.isInteger(configuredWorkers) && configuredWorkers >= 1 ? configuredWorkers : Math.min(4, availableParallelism());
export default defineConfig({
  test: {
    testTimeout: 15000, hookTimeout: 15000,
    // `expect.poll` waits for an observable outcome (a job settling, a WebSocket message, a Bot acting). Vitest's default
    // of 1 second is shorter than a loaded machine needs for work that passes alone, so a poll gives up only after 5
    // seconds. A poll that succeeds still returns at once; waits that prove something does NOT happen use their own timers.
    expect: { poll: { timeout: 5000 } },
    maxWorkers,
    globalSetup: ['scripts/vitest-slot.ts'],
    projects: [
      { extends: true, test: { name: 'packages-and-apps', include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'] } },
      // The launcher tests start their own PostgreSQL clusters (initdb, start, stop). They run after every other
      // suite has finished, so those clusters never compete with the shared test database's servers for CPU and memory.
      { extends: true, test: { name: 'scripts', include: ['scripts/test/**/*.test.ts'], sequence: { groupOrder: 1 } } },
    ],
  },
});
