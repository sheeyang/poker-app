import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A machine-wide limit on concurrent test runs, shared by every checkout and worktree through the temporary
 * directory. Each run takes one slot file for its lifetime. When all slots are taken, a run waits, so parallel
 * agents queue instead of starving each other's database startup and polling waits.
 *
 * It throttles; it does not guard correctness. Reclaiming an abandoned slot is not atomic, so in a rare race two
 * runs can share a slot, which only means a little less throttling.
 */
export type Slot = { release(): Promise<void> };

export type SlotOptions = {
  /** Where slot files live. Defaults to a fixed directory in the OS temporary directory, so all checkouts share it. */
  directory?: string;
  /** How many runs may hold a slot at once. Defaults to POKER_TEST_SLOTS, or 2. */
  slots?: number;
  /** A slot held longer than this is treated as abandoned even if its process is alive (a reused process ID). */
  maxAgeMs?: number;
  pollMs?: number;
  /** Called once, when every slot is busy, with a description of who holds them. */
  onWait?: (holders: string) => void;
};

type Holder = { pid: number; startedAt: number; token: string };

const defaultSlots = 2;
const defaultMaxAgeMs = 30 * 60_000;

export function configuredSlots(environment: NodeJS.ProcessEnv = process.env) {
  const value = Number(environment.POKER_TEST_SLOTS);
  return Number.isInteger(value) && value >= 1 ? value : defaultSlots;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The slot's holder; `null` when the slot is free, `undefined` when its file is unreadable. */
async function read(file: string): Promise<Holder | null | undefined> {
  try {
    const record = JSON.parse(await readFile(file, 'utf8')) as Holder;
    return Number.isInteger(record.pid) && Number.isFinite(record.startedAt) ? record : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/** Takes `file` if nobody has it. The record is written beside it first and linked into place, so the slot is never visible half-written. */
async function claim(directory: string, file: string): Promise<Holder | undefined> {
  const record: Holder = { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
  const staging = path.join(directory, `.claim-${record.token}`);
  await writeFile(staging, JSON.stringify(record));
  try {
    await link(staging, file);
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  } finally {
    await rm(staging, { force: true });
  }
}

export async function acquireSlot(options: SlotOptions = {}): Promise<Slot> {
  const directory = options.directory ?? path.join(tmpdir(), 'poker-test-slots');
  const slots = options.slots ?? configuredSlots();
  const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs;
  const pollMs = options.pollMs ?? 500;
  await mkdir(directory, { recursive: true });
  let reported = false;
  for (;;) {
    const holders: string[] = [];
    for (let index = 0; index < slots; index++) {
      const file = path.join(directory, `slot-${index}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const mine = await claim(directory, file);
        if (mine) {
          let released = false;
          return {
            async release() {
              if (released) return;
              released = true;
              // Another run may have reclaimed this slot after the age limit; only remove it if it is still ours.
              const current = await read(file);
              if (current?.token === mine.token) await rm(file, { force: true });
            },
          };
        }
        const holder = await read(file);
        // Freed between the failed claim and this read: claim it again, and leave the file alone.
        if (holder === null) continue;
        if (holder && alive(holder.pid) && Date.now() - holder.startedAt <= maxAgeMs) {
          holders.push(`pid ${holder.pid} (${Math.round((Date.now() - holder.startedAt) / 1000)} s)`);
          break;
        }
        // Abandoned: its process has exited, it outlived the age limit, or it is unreadable. Clear it and claim again.
        await rm(file, { force: true });
      }
    }
    if (!reported) {
      reported = true;
      options.onWait?.(holders.join(', '));
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
