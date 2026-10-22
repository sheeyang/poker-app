import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'], testTimeout: 15000, hookTimeout: 15000 } });
