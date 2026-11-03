import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  test: {
    testTimeout: 15000, hookTimeout: 15000,
    projects: [
      { extends: true, test: { name: 'packages-and-apps', include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'] } },
      // The launcher tests start their own PostgreSQL clusters (initdb, start, stop). They run after every other
      // suite has finished, so those clusters never compete with the shared test database's servers for CPU and memory.
      { extends: true, test: { name: 'scripts', include: ['scripts/test/**/*.test.ts'], sequence: { groupOrder: 1 } } },
    ],
  },
});
