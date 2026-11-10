import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { native } from './postgres-process.js';

/**
 * The development runs on this machine. Every `pnpm dev` run registers itself here, keeps a heartbeat, and watches for a
 * stop marker, so `dev:stop` can end it gracefully (signals cannot on Windows) and `dev:status` can say where it is.
 * A run that died without cleaning up is found here too, and its database and directory are removed.
 */
export interface RunRecord {
  id: string;
  pid: number;
  startedAt: number;
  checkout: string;
  webUrl?: string;
  apiUrl?: string;
  dataDir?: string;
  pgCtl?: string;
}
/** live: its launcher is running and beating. stalled: the process exists but is not beating. dead: the process is gone. */
export type RunState = 'live' | 'stalled' | 'dead';

const freshMs = 15_000;
const root = fileURLToPath(new URL('../', import.meta.url));
// The folder can be moved (the tests do), so that a test never sees or stops the runs of the person running it.
const directory = () => process.env.POKER_DEV_RUNS_DIR ?? path.join(tmpdir(), 'poker-dev-runs');
const recordFile = (id: string) => path.join(directory(), `${id}.json`);
const stopFile = (id: string) => path.join(directory(), `${id}.stop`);

export async function writeRecord(record: RunRecord) {
  await mkdir(directory(), { recursive: true });
  await writeFile(recordFile(record.id), JSON.stringify(record));
}
export async function touchRecord(id: string) {
  const now = new Date();
  await utimes(recordFile(id), now, now).catch(() => {});
}
export const stopRequested = (id: string) => existsSync(stopFile(id));
export async function removeRun(id: string) {
  await rm(recordFile(id), { force: true });
  await rm(stopFile(id), { force: true });
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function listRuns(): Promise<Array<RunRecord & { state: RunState; heartbeatAgeMs: number }>> {
  const names = await readdir(directory()).catch(() => [] as string[]);
  const runs: Array<RunRecord & { state: RunState; heartbeatAgeMs: number }> = [];
  for (const name of names.filter(entry => entry.endsWith('.json'))) {
    try {
      const file = path.join(directory(), name);
      const record = JSON.parse(await readFile(file, 'utf8')) as RunRecord;
      const age = Date.now() - (await stat(file)).mtimeMs;
      runs.push({ ...record, heartbeatAgeMs: age, state: !alive(record.pid) ? 'dead' : age <= freshMs ? 'live' : 'stalled' });
    } catch { /* a record being written or removed right now */ }
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}

const sameCheckout = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const age = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;

/** Removes a run whose launcher is gone: stops its PostgreSQL if one still runs, then deletes its directory and record. */
async function reap(run: RunRecord) {
  if (run.dataDir) {
    const pidFile = path.join(run.dataDir, 'postmaster.pid');
    if (existsSync(pidFile) && run.pgCtl) {
      try { await native(run.pgCtl, ['-D', run.dataDir, '-m', 'fast', '-w', '-t', '30', 'stop']); }
      catch (error) {
        // A leftover pid file with no process behind it is not a running database.
        const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
        if (alive(pid)) throw error;
      }
    }
    const folder = path.dirname(run.dataDir);
    if (path.dirname(folder) !== path.resolve(tmpdir()) || !/^poker-dev-postgres-/.test(path.basename(folder))) {
      throw new Error(`Refusing to remove ${folder}: it is not an owned development database directory.`);
    }
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  await removeRun(run.id);
}

async function waitForExit(id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(recordFile(id))) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return !existsSync(recordFile(id));
}

async function status(json: boolean) {
  const runs = await listRuns();
  if (json) { console.log(JSON.stringify(runs, null, 2)); return 0; }
  if (!runs.length) { console.log('No development runs.'); return 0; }
  for (const run of runs) {
    console.log(`${run.id}  ${run.state.padEnd(7)}  ${age(Date.now() - run.startedAt).padStart(7)}  ${run.webUrl ?? '-'}  ${run.apiUrl ?? '-'}  ${run.checkout}`);
  }
  return 0;
}

/** `dev:stop` stops this checkout's runs, `dev:stop <id>` one run, `dev:stop --all` every run on the machine. */
async function stop(args: string[]) {
  const all = args.includes('--all'), id = args.find(arg => !arg.startsWith('--'));
  const runs = (await listRuns()).filter(run => id ? run.id === id : all || sameCheckout(run.checkout, root));
  if (!runs.length) { console.log(id ? `No development run ${id}.` : all ? 'No development runs.' : 'No development runs for this checkout. Use --all to stop every run on this machine.'); return id ? 1 : 0; }
  let failed = false;
  await Promise.all(runs.map(async run => {
    const label = `${run.id}${run.webUrl ? ` (${run.webUrl})` : ''}`;
    try {
      if (run.state === 'dead') { await reap(run); console.log(`Cleaned up crashed run ${label}.`); return; }
      await writeFile(stopFile(run.id), '');
      if (await waitForExit(run.id, 60_000)) console.log(`Stopped ${label}.`);
      else {
        failed = true;
        console.error(`Run ${label} did not stop within 60 s (launcher pid ${run.pid}, ${run.state}). It may be paused. Check it, then run dev:stop again.`);
      }
    } catch (error) {
      failed = true;
      console.error(`Could not stop ${label}: ${(error as Error).message}`);
    }
  }));
  return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2);
  const run = command === 'status' ? status(rest.includes('--json')) : command === 'stop' ? stop(rest) : Promise.reject(new Error('Usage: dev-runs.ts <status [--json]|stop [id|--all]>'));
  run.then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
