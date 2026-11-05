import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { acquireSlot, type Slot } from '../test-slots.js';

let directory: string;
const held: Slot[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'poker-slots-test-'));
});

afterEach(async () => {
  await Promise.all(held.splice(0).map(slot => slot.release()));
  await rm(directory, { recursive: true, force: true });
});

async function take(options: Parameters<typeof acquireSlot>[0] = {}) {
  const slot = await acquireSlot({ directory, pollMs: 10, ...options });
  held.push(slot);
  return slot;
}

/** Resolves true when `promise` settles within `ms`, false when it is still pending. */
async function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))]);
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid!;
}

test('grants as many slots as configured immediately, and makes the next caller wait', async () => {
  const first = await take({ slots: 2 });
  await take({ slots: 2 });
  const third = acquireSlot({ directory, slots: 2, pollMs: 10 });
  expect(await settlesWithin(third, 150)).toBe(false);
  await first.release();
  held.push(await third);
});

test('a released slot goes to the waiting caller', async () => {
  const first = await take({ slots: 1 });
  const waiting = acquireSlot({ directory, slots: 1, pollMs: 10 });
  expect(await settlesWithin(waiting, 100)).toBe(false);
  await first.release();
  held.push(await waiting);
  expect(await readdir(directory)).toHaveLength(1);
});

test('release removes the slot and can be repeated', async () => {
  const slot = await take({ slots: 1 });
  expect(await readdir(directory)).toHaveLength(1);
  await slot.release();
  await slot.release();
  expect(await readdir(directory)).toHaveLength(0);
});

test('a slot held by a process that no longer exists is reclaimed', async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'slot-0'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() }));
  expect(await settlesWithin(take({ slots: 1 }), 1000)).toBe(true);
});

test('a slot older than the age limit is reclaimed even when its process is alive', async () => {
  await writeFile(path.join(directory, 'slot-0'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 }));
  expect(await settlesWithin(take({ slots: 1, maxAgeMs: 1000 }), 1000)).toBe(true);
});

test('an unreadable slot file is treated as abandoned', async () => {
  await writeFile(path.join(directory, 'slot-0'), 'not json');
  expect(await settlesWithin(take({ slots: 1 }), 1000)).toBe(true);
});

test('callers waiting for a slot report who holds the busy ones', async () => {
  await take({ slots: 1 });
  const reports: string[] = [];
  const waiting = acquireSlot({ directory, slots: 1, pollMs: 10, onWait: holders => reports.push(holders) });
  expect(await settlesWithin(waiting, 100)).toBe(false);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain(String(process.pid));
  await held[0].release();
  held.push(await waiting);
});
