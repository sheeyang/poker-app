import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function native(program: string, args: string[], env = process.env, started?: (pid: number) => void) {
  await new Promise<void>((resolve, reject) => {
    const command = spawn(program, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    if (command.pid) started?.(command.pid);
    let errors = '';
    command.stderr.on('data', chunk => { errors += chunk.toString(); });
    command.once('error', reject);
    // A Windows daemon can inherit pipes after pg_ctl exits. Wait for the
    // command's exit rather than for every inherited pipe to close.
    command.once('exit', code => {
      command.stderr.destroy();
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(program)} failed (${code}): ${errors.trim()}`));
    });
  });
}

export async function cleanup(pgCtl: string, directory: string, temporary: boolean, owner: number, pendingNative?: number) {
  const marker = path.join(directory, 'owner.lock');
  const recorded = JSON.parse(await readFile(marker, 'utf8')) as { pid: number };
  if (recorded.pid !== owner) throw new Error('Database ownership changed; refusing cleanup.');
  // Ctrl+C during initialization/startup must wait for the already dispatched
  // native operation before stopping PostgreSQL or removing temporary files.
  const deadline = Date.now() + 60000;
  while (pendingNative) {
    try { process.kill(pendingNative, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
      throw error;
    }
    if (Date.now() > deadline) throw new Error('Native PostgreSQL startup has not finished; preserve its directory for manual cleanup.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await rm(path.join(directory, 'password'), { force: true });
  const data = path.join(directory, 'data');
  if (existsSync(path.join(data, 'postmaster.pid'))) {
    await native(pgCtl, ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
  }
  await unlink(marker);
  if (temporary) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('poker-test-postgres-')) {
      throw new Error('Refusing to remove a directory outside the owned temporary database location.');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Internal shutdown worker, not a recovery command. On Windows a command shell
// can terminate its child during Ctrl+C before asynchronous cleanup finishes.
// This worker is launched only for normal shutdown / handled errors, never in
// response to a crash or a disconnected parent.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [pgCtl, directory, mode, owner, pendingNative] = process.argv.slice(2);
  cleanup(pgCtl, directory, mode === 'test', Number(owner), Number(pendingNative) || undefined).catch(async error => {
    await writeFile(path.join(directory, 'cleanup-error.log'), String(error)).catch(() => {});
    process.exitCode = 1;
  });
}
