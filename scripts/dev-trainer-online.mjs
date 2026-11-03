// Runs `pnpm dev:trainer` with Online Tables (beta) enabled, on any platform.
import { spawn } from 'node:child_process';

const manager = process.env.npm_execpath;
const [command, args] = manager
  ? [process.execPath, [manager, 'dev:trainer']]
  : ['pnpm', ['dev:trainer']];

const child = spawn(command, args, {
  env: { ...process.env, POKER_ONLINE_PLAY: 'true' },
  stdio: 'inherit',
  shell: !manager && process.platform === 'win32',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
