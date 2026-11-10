import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const checkouts: string[] = [];
const commands: ChildProcess[] = [];
const probe = `
import { Client } from 'pg';
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const client = new Client({ connectionString: url });
await client.connect();
const result = await client.query('SELECT 42 AS value');
if (process.env.PROBE_WRITE === '1') await client.query('CREATE TABLE startup_note (value text)');
const note = await client.query("SELECT to_regclass('startup_note') AS name");
await client.end();
console.log('PROBE:' + JSON.stringify({ url, value: result.rows[0].value, note: note.rows[0].name, ports: [process.env.PORT, process.env.POKER_WEB_PORT], args: process.argv.slice(2) }));
if (process.env.PROBE_HOLD === '1') process.stdin.resume();
process.exitCode = Number(process.env.PROBE_EXIT ?? 0);
`;

async function checkout() {
  const directory = await mkdtemp(path.join(tmpdir(), 'poker-launcher-test-'));
  checkouts.push(directory);
  await mkdir(path.join(directory, 'scripts'));
  for (const entry of await readdir(path.join(root, 'scripts'))) {
    if (entry.endsWith('.ts')) await cp(path.join(root, 'scripts', entry), path.join(directory, 'scripts', entry));
  }
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(directory, 'probe.mjs'), probe);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    type: 'module', packageManager: 'pnpm@11.25.0',
    scripts: { fixture: 'node --import tsx scripts/with-database.ts dev -- node probe.mjs' },
  }));
  return directory;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function launch(directory: string, args: string[], options: { packageScript?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  Object.assign(env, options.env);
  const manager = options.packageScript ? process.env.npm_execpath : undefined;
  if (options.packageScript && !manager) throw new Error('Run command-boundary tests through pnpm test.');
  const managerIsScript = manager && /\.[cm]?js$/i.test(manager);
  const program = manager && !managerIsScript ? manager : process.execPath;
  const commandArgs = manager ? [...(managerIsScript ? [manager] : []), 'run', 'fixture'] : ['--import', 'tsx', path.join(directory, 'scripts/with-database.ts'), ...args];
  const child = spawn(program, commandArgs, { cwd: options.cwd ?? directory, env, detached: true, windowsHide: true, stdio: 'pipe' });
  commands.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk.toString(); });
  child.stderr!.on('data', chunk => { output += chunk.toString(); });
  const done = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  return { child, done, output: () => output };
}

/**
 * Each test and the cleanup hook allow a minute: starting or stopping a nested PostgreSQL cluster (initdb, start,
 * shutdown) can take tens of seconds on a loaded machine. A wait gives up inside that allowance, so its failure
 * shows the command's output rather than a bare timeout.
 */
const allowanceMs = 60000;
const waitMs = 45000;
/** Waits for `condition`. With `command`, a command that exits first fails the wait at once: it can no longer satisfy it. */
async function eventually(condition: () => boolean | Promise<boolean>, message: () => string, command?: { child: ChildProcess }) {
  const deadline = Date.now() + waitMs;
  while (!(await condition())) {
    if (command && (command.child.exitCode !== null || command.child.signalCode !== null) && !(await condition())) throw new Error('The command exited first.\n' + message());
    if (Date.now() > deadline) throw new Error(message());
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function interrupt(child: ChildProcess) {
  if (process.platform === 'win32') {
    // Headless Windows children have no console to receive Ctrl+C. Close the
    // probe's input here; verify real console Ctrl+C separately in a terminal.
    child.stdin?.end();
  } else {
    process.kill(-child.pid!, 'SIGINT');
  }
}

afterEach(async () => {
  for (const child of commands.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      await interrupt(child);
      await eventually(() => child.exitCode !== null || child.signalCode !== null, () => 'Command did not finish cleanup.');
    }
  }
  for (const directory of checkouts.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('poker-launcher-test-')) {
      throw new Error('Refusing to remove a directory outside the owned fixture location.');
    }
    if (existsSync(path.join(directory, '.local/postgres/data/postmaster.pid'))) throw new Error(`Preserving running database: ${directory}`);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, allowanceMs);

test.skipIf(process.platform === 'win32')('Ctrl+C through the package command stops PostgreSQL and removes the throwaway database', async () => {
  const directory = await checkout();
  const command = launch(directory, [], { packageScript: true, env: { PROBE_HOLD: '1' } });
  await eventually(() => command.output().includes('PROBE:'), command.output, command);
  const data = temporaryData(command.output());
  await interrupt(command.child);
  // Windows shells can ask this after delivering Ctrl+C to their command tree.
  if (!command.child.stdin!.destroyed) command.child.stdin!.end('Y\n');
  await command.done;
  await eventually(() => !existsSync(data), command.output);
  expect(existsSync(path.join(directory, '.local'))).toBe(false);
}, allowanceMs);

function result(output: string): { url: string; value: number; note: string | null; ports: [string | undefined, string | undefined]; args: string[] } {
  return JSON.parse(output.match(/PROBE:(.+)/)![1]);
}

function temporaryData(output: string) {
  return path.dirname(output.match(/; data: (.+)/)![1].trim());
}

test('test invocations have independent databases, ports, and cleanup lifetimes', async () => {
  const directory = await checkout();
  const first = launch(directory, ['test', '--', 'node', 'probe.mjs'], { env: { PROBE_WRITE: '1', PROBE_HOLD: '1', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/development' } });
  await eventually(() => first.output().includes('PROBE:'), first.output, first);
  const second = launch(directory, ['test', '--', 'node', 'probe.mjs']);
  expect(await second.done).toBe(0);
  expect(result(first.output()).note).toBe('startup_note');
  expect(result(second.output()).note).toBe(null);
  expect(result(first.output()).url).not.toBe(result(second.output()).url);
  expect(existsSync(temporaryData(second.output()))).toBe(false);
  expect(existsSync(temporaryData(first.output()))).toBe(true);
  first.child.stdin!.end();
  expect(await first.done).toBe(0);
  expect(existsSync(temporaryData(first.output()))).toBe(false);
}, allowanceMs);

test('development runs are isolated by default: parallel runs get their own database and ports, and leave nothing behind', async () => {
  const directory = await checkout();
  const first = launch(directory, ['dev', '--', 'node', 'probe.mjs'], { env: { PROBE_WRITE: '1', PROBE_HOLD: '1' } });
  await eventually(() => first.output().includes('PROBE:'), first.output, first);
  const second = launch(directory, ['dev', '--', 'node', 'probe.mjs']);
  expect(await second.done).toBe(0);
  expect(result(first.output()).note).toBe('startup_note');
  expect(result(second.output()).note).toBe(null);
  expect(result(first.output()).url).not.toBe(result(second.output()).url);
  const [api, web] = result(first.output()).ports;
  expect(api).toMatch(/^\d+$/);
  expect(web).toMatch(/^\d+$/);
  expect(first.output()).toContain(`Web: http://127.0.0.1:${web}/`);
  expect(result(second.output()).ports).not.toEqual([api, web]);
  expect(existsSync(path.join(directory, '.local'))).toBe(false);
  expect(existsSync(temporaryData(second.output()))).toBe(false);
  expect(existsSync(temporaryData(first.output()))).toBe(true);
  first.child.stdin!.end();
  expect(await first.done).toBe(0);
  expect(existsSync(temporaryData(first.output()))).toBe(false);
}, allowanceMs);

test('an explicit test URL takes shell precedence, bypasses local startup, and is left running', async () => {
  const ownerDirectory = await checkout();
  const owner = launch(ownerDirectory, ['test', '--', 'node', 'probe.mjs'], { env: { PROBE_HOLD: '1', PROBE_WRITE: '1' } });
  await eventually(() => owner.output().includes('PROBE:'), owner.output, owner);
  const directory = await checkout();
  await writeFile(path.join(directory, '.env'), 'TEST_DATABASE_URL=postgresql://bad:bad@127.0.0.1:1/not_used\n');
  const url = result(owner.output()).url;
  for (let attempt = 0; attempt < 2; attempt++) {
    const consumer = launch(directory, ['test', '--', 'node', 'probe.mjs'], { env: { TEST_DATABASE_URL: url } });
    expect(await consumer.done).toBe(0);
    expect(result(consumer.output()).note).toBe('startup_note');
    expect(consumer.output()).toContain('database lifecycle is external');
    expect(consumer.output()).not.toContain('; data:');
  }
  expect(existsSync(path.join(directory, '.local'))).toBe(false);
  owner.child.stdin!.end();
  expect(await owner.done).toBe(0);
}, allowanceMs);

test('unreachable configured URLs fail without starting an embedded fallback', async () => {
  const directory = await checkout();
  const command = launch(directory, ['dev', '--', 'node', 'probe.mjs'], { env: { DATABASE_URL: `postgresql://poker:poker@127.0.0.1:${await freePort()}/missing` } });
  expect(await command.done).toBe(1);
  expect(command.output()).toContain('embedded fallback is disabled');
  expect(command.output()).not.toContain('PROBE:');
  expect(existsSync(path.join(directory, '.local'))).toBe(false);
}, allowanceMs);

test('a failed child retains its exit status and arguments while its temporary database is removed', async () => {
  const directory = await checkout();
  const command = launch(directory, ['test', '--', 'node', 'probe.mjs', 'argument with spaces', 'literal-$value'], { env: { PROBE_EXIT: '37' } });
  expect(await command.done).toBe(37);
  expect(result(command.output()).args).toEqual(['argument with spaces', 'literal-$value']);
  expect(existsSync(temporaryData(command.output()))).toBe(false);
}, allowanceMs);
