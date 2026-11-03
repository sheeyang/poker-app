// Runs `pnpm dev:trainer` with Online Tables (beta) enabled, on any platform.
import { spawn } from 'node:child_process';

// The running pnpm is a JavaScript entry point, which Node runs, or a native executable such as the standalone
// pnpm.exe on Windows, which runs by itself (as in scripts/with-database.ts).
const manager = process.env.npm_execpath;
const managerIsScript = manager && /\.[cm]?js$/i.test(manager);
const [command, args] = managerIsScript
  ? [process.execPath, [manager, 'dev:trainer']]
  : [manager ?? 'pnpm', ['dev:trainer']];

const child = spawn(command, args, {
  env: { ...process.env, POKER_ONLINE_PLAY: 'true' },
  stdio: 'inherit',
  shell: !manager && process.platform === 'win32',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
