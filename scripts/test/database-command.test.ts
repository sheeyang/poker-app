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
console.log('PROBE:' + JSON.stringify({ url, value: result.rows[0].value, note: note.rows[0].name, args: process.argv.slice(2) }));
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

async function eventually(condition: () => boolean | Promise<boolean>, message: () => string) {
  const deadline = Date.now() + 20000;
  while (!(await condition())) {
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
});

test.skipIf(process.platform === 'win32')('Ctrl+C through the package command stops PostgreSQL and releases ownership while retaining development data', async () => {
  const directory = await checkout();
  const command = launch(directory, [], { packageScript: true, env: { POKER_POSTGRES_PORT: String(await freePort()), PROBE_HOLD: '1' } });
  await eventually(() => command.output().includes('PROBE:'), command.output);
  await interrupt(command.child);
  // Windows shells can ask this after delivering Ctrl+C to their command tree.
  if (!command.child.stdin!.destroyed) command.child.stdin!.end('Y\n');
  await command.done;
  await eventually(() => !existsSync(path.join(directory, '.local/postgres/owner.lock')), command.output);
  expect(existsSync(path.join(directory, '.local/postgres/data/postmaster.pid'))).toBe(false);
  expect((await readFile(path.join(directory, '.local/postgres/data/PG_VERSION'), 'utf8')).trim()).toBe('18');
}, 60000);

function result(output: string): { url: string; value: number; note: string | null; args: string[] } {
  return JSON.parse(output.match(/PROBE:(.+)/)![1]);
}

function temporaryData(output: string) {
  return path.dirname(output.match(/; data: (.+)/)![1].trim());
}

test('test invocations have independent databases, ports, and cleanup lifetimes', async () => {
  const directory = await checkout();
  const first = launch(directory, ['test', '--', 'node', 'probe.mjs'], { env: { PROBE_WRITE: '1', PROBE_HOLD: '1', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/development' } });
  await eventually(() => first.output().includes('PROBE:'), first.output);
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
}, 60000);

test('development data survives package command exits and is relative to the checkout', async () => {
  const directory = await checkout();
  const port = String(await freePort());
  const first = launch(directory, [], { packageScript: true, env: { POKER_POSTGRES_PORT: port, PROBE_WRITE: '1' } });
  expect(await first.done).toBe(0);
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(elsewhere);
  const second = launch(directory, ['dev', '--', 'node', 'probe.mjs'], { cwd: elsewhere, env: { POKER_POSTGRES_PORT: port } });
  expect(await second.done).toBe(0);
  expect(result(second.output()).note).toBe('startup_note');
  expect(existsSync(path.join(directory, '.local/postgres/owner.lock'))).toBe(false);
  expect(existsSync(path.join(directory, '.local/postgres/data/postmaster.pid'))).toBe(false);
}, 60000);

test('an explicit test URL takes shell precedence, bypasses local startup, and is left running', async () => {
  const ownerDirectory = await checkout();
  const owner = launch(ownerDirectory, ['test', '--', 'node', 'probe.mjs'], { env: { PROBE_HOLD: '1', PROBE_WRITE: '1' } });
  await eventually(() => owner.output().includes('PROBE:'), owner.output);
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
}, 60000);

test('unreachable configured URLs fail without starting an embedded fallback', async () => {
  const directory = await checkout();
  const command = launch(directory, ['dev', '--', 'node', 'probe.mjs'], { env: { DATABASE_URL: `postgresql://poker:poker@127.0.0.1:${await freePort()}/missing` } });
  expect(await command.done).toBe(1);
  expect(command.output()).toContain('embedded fallback is disabled');
  expect(command.output()).not.toContain('PROBE:');
  expect(existsSync(path.join(directory, '.local'))).toBe(false);
}, 60000);

test('an occupied development port fails without taking over its listener or leaving ownership', async () => {
  const directory = await checkout();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const port = (listener.address() as { port: number }).port;
    const command = launch(directory, ['dev', '--', 'node', 'probe.mjs'], { env: { POKER_POSTGRES_PORT: String(port) } });
    expect(await command.done).toBe(1);
    expect(command.output()).toContain(`PostgreSQL port ${port} is unavailable`);
    expect(listener.listening).toBe(true);
    expect(existsSync(path.join(directory, '.local/postgres/owner.lock'))).toBe(false);
    expect(existsSync(path.join(directory, '.local/postgres/data/PG_VERSION'))).toBe(false);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
}, 60000);

test('a failed child retains its exit status and arguments while its temporary database is removed', async () => {
  const directory = await checkout();
  const command = launch(directory, ['test', '--', 'node', 'probe.mjs', 'argument with spaces', 'literal-$value'], { env: { PROBE_EXIT: '37' } });
  expect(await command.done).toBe(37);
  expect(result(command.output()).args).toEqual(['argument with spaces', 'literal-$value']);
  expect(existsSync(temporaryData(command.output()))).toBe(false);
}, 60000);
