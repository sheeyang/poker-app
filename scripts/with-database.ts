import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { cleanup, native } from './postgres-process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryPrefix = 'poker-test-postgres-';
type Binaries = { initdb: string; postgres: string; pg_ctl: string };

async function binaries(): Promise<Binaries> {
  const platforms: Record<string, string[]> = {
    win32: ['x64'], darwin: ['x64', 'arm64'], linux: ['x64', 'arm', 'arm64', 'ia32', 'ppc64'],
  };
  if (!platforms[process.platform]?.includes(process.arch)) {
    throw new Error(`No embedded PostgreSQL binary for ${process.platform}/${process.arch}. Configure an external database URL instead.`);
  }
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  try {
    // Resolve the binary package through its declaring dependency, without loading
    // the wrapper's exit hook (which force-kills PostgreSQL on Windows).
    const require = createRequire(import.meta.resolve('embedded-postgres'));
    const result = await import(pathToFileURL(require.resolve(`@embedded-postgres/${platform}-${process.arch}`)).href) as Binaries;
    if (process.platform !== 'win32') {
      await Promise.all(Object.values(result).filter(value => typeof value === 'string').map(async file => {
        const mode = (await stat(file)).mode;
        if ((mode & 0o111) !== 0o111) await chmod(file, mode | 0o111);
      }));
    }
    return result;
  } catch (error) {
    throw new Error('Cannot load the embedded PostgreSQL binaries. Run pnpm install with optional dependencies and approved install scripts enabled.', { cause: error });
  }
}

async function reservePort(port: number): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(error => {
    throw new Error(`PostgreSQL port ${port} is unavailable. Stop its owning command or set POKER_POSTGRES_PORT to another port.`, { cause: error });
  });
  return { server, port: (server.address() as { port: number }).port };
}

async function releasePort(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function checkConnection(url: string, variable: string) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try { await client.connect(); await client.query('SELECT 1'); }
  catch (error) { throw new Error(`Cannot connect using ${variable}. Fix or unset it; embedded fallback is disabled.`, { cause: error }); }
  finally { await client.end(); }
}

async function run() {
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const mode = process.argv[2];
  const args = process.argv.slice(3);
  while (args[0] === '--') args.shift();
  if (!['dev', 'test'].includes(mode) || args.length === 0) {
    throw new Error('Usage: with-database.ts <dev|test> -- <command> [arguments]');
  }
  const variable = mode === 'dev' ? 'DATABASE_URL' : 'TEST_DATABASE_URL';
  const configured = process.env[variable];
  let child: ChildProcess | undefined;
  let signal: NodeJS.Signals | undefined;
  let directory: string | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let reserved: Server | undefined;
  let tools: Binaries | undefined;
  let startAttempted = false;
  let pendingNative: number | undefined;
  let cleanupCompletion: Promise<void> | undefined;
  function beginCleanup() {
    if (!cleanupCompletion && tools && directory) {
      const worker = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/postgres-process.ts'), tools.pg_ctl, directory, mode, String(process.pid), String(pendingNative ?? '')], {
        cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
      });
      cleanupCompletion = new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Database shutdown failed. Inspect ${directory}/cleanup-error.log and follow the manual cleanup instructions.`)));
      });
      void cleanupCompletion.catch(() => {});
    }
    return cleanupCompletion;
  }
  const cancellation = Promise.withResolvers<number>();
  const interrupted = (received: NodeJS.Signals) => {
    signal ??= received;
    // Console Ctrl+C reaches Windows children directly. ChildProcess.kill on
    // Windows would forcibly terminate them instead of delivering SIGINT.
    if (process.platform !== 'win32') child?.kill(received);
    if (process.platform === 'win32' && lock) {
      // Start synchronously from the signal handler so the shell cannot kill
      // this launcher between receiving Ctrl+C and delegating its cleanup.
      void lock?.close();
      beginCleanup();
    }
    child?.unref();
    cancellation.resolve(received === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    if (configured !== undefined) {
      if (!configured.trim()) throw new Error(`${variable} is empty. Unset it to use embedded PostgreSQL.`);
      await checkConnection(configured, variable);
      console.log(`[database] Using configured ${variable}; database lifecycle is external.`);
    } else {
      tools = await binaries();
      directory = mode === 'dev' ? path.join(root, '.local/postgres') : await mkdtemp(path.join(tmpdir(), temporaryPrefix));
      await mkdir(directory, { recursive: true });
      try { lock = await open(path.join(directory, 'owner.lock'), 'wx'); }
      catch (error) { throw new Error(`Database directory is already owned: ${directory}. Finish its command, or follow docs/local-development.md after a crash.`, { cause: error }); }
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      if (signal) return 130;
      const data = path.join(directory, 'data');
      if (existsSync(path.join(data, 'postmaster.pid'))) {
        throw new Error(`A PostgreSQL PID file already exists in ${data}. Check its process and follow the manual crash-cleanup instructions.`);
      }
      const requested = mode === 'test' ? 0 : Number(process.env.POKER_POSTGRES_PORT ?? '54329');
      if (!Number.isInteger(requested) || requested < (mode === 'test' ? 0 : 1) || requested > 65535) {
        throw new Error('POKER_POSTGRES_PORT must be an integer from 1 to 65535.');
      }
      const reservation = await reservePort(requested);
      reserved = reservation.server;
      if (signal) return 130;
      const port = reservation.port;
      const nativeEnvironment = { ...process.env, LC_ALL: 'C', LC_MESSAGES: 'C' };
      if (!existsSync(path.join(data, 'PG_VERSION'))) {
        const passwordFile = path.join(directory, 'password');
        const password = await open(passwordFile, 'wx', 0o600);
        try {
          await password.writeFile('poker\n');
          await password.close();
          if (signal) return 130;
          console.log('[database] Initializing PostgreSQL 18...');
          await native(tools.initdb, ['-D', data, '--username=poker', '--auth=password', `--pwfile=${passwordFile}`, '--locale=C', '--encoding=UTF8'], nativeEnvironment, pid => { pendingNative = pid; });
          pendingNative = undefined;
        } finally { await password.close(); await rm(passwordFile, { force: true }); }
      }
      if (signal) return 130;
      const version = (await readFile(path.join(data, 'PG_VERSION'), 'utf8')).trim();
      if (version !== '18') throw new Error(`Development data is PostgreSQL ${version}; these binaries require major 18. Preserve the data and handle the version change explicitly.`);
      await releasePort(reserved);
      reserved = undefined;
      if (signal) return 130;
      startAttempted = true;
      await native(tools.pg_ctl, ['-D', data, '-l', path.join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -c max_connections=200`, '-w', '-t', '30', 'start'], nativeEnvironment, pid => { pendingNative = pid; });
      pendingNative = undefined;
      if (signal) return 130;
      const database = mode === 'dev' ? 'poker' : 'poker_test';
      const client = new Client({ connectionString: `postgresql://poker:poker@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        if (!(await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount) {
          await client.query(`CREATE DATABASE "${database}"`);
        }
      } finally { await client.end(); }
      process.env[variable] = `postgresql://poker:poker@127.0.0.1:${port}/${database}`;
      console.log(`[database] PostgreSQL 18 ready on 127.0.0.1:${port}; data: ${data}`);
      console.log(`[database] Bundled pg_ctl: ${tools.pg_ctl}`);
    }
    if (signal) return 130;
    const program = args.shift()!;
    const manager = program === 'pnpm' ? process.env.npm_execpath : undefined;
    const managerIsScript = manager && /\.[cm]?js$/i.test(manager);
    const executable = managerIsScript ? process.execPath : manager ?? program;
    const commandArgs = managerIsScript ? [manager!, ...args] : args;
    child = spawn(executable, commandArgs, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
    const exited = new Promise<number>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code, childSignal) => resolve(signal || childSignal ? 130 : code ?? 1));
    });
    return await Promise.race([exited, cancellation.promise]);
  } finally {
    if (reserved) await releasePort(reserved);
    if (lock) await lock.close();
    if (tools && directory && lock && (startAttempted || cleanupCompletion)) {
      try {
        if (process.platform === 'win32') await beginCleanup();
        else await cleanup(tools.pg_ctl, directory, mode === 'test', process.pid);
        console.log('[database] PostgreSQL shut down gracefully.');
      } catch (error) {
        console.error(`[database] Shutdown failed; retain ${directory} and follow the manual cleanup instructions.`);
        process.exitCode = 1;
        console.error(error);
      }
    } else {
      if (lock && directory) await unlink(path.join(directory, 'owner.lock'));
      if (mode === 'test' && directory) {
        if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith(temporaryPrefix)) {
          throw new Error('Refusing to remove a directory outside the owned temporary database location.');
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

run().then(code => { process.exitCode ||= code; }).catch(error => {
  console.error(`[database] ${error.message}`);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
});
