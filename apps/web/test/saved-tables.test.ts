import { describe, expect, it } from 'vitest';
import type { ObservableTableSession, SavedTable } from '@poker/contracts';
import { liveDetails, openedLabel, savedRows } from '../src/saved-tables.js';

const stakes = { smallBlind: 10, bigBlind: 20, ante: 0 };
const practice = (id: string, openedAt?: number): SavedTable => ({ tableSessionId: id, mode: 'practice', seatCount: 6, stakes, ...(openedAt !== undefined ? { openedAt } : {}) });
const online = (id: string, left = false, openedAt?: number): SavedTable => ({ tableSessionId: id, mode: 'online', seatCount: 6, stakes, ...(left ? { left: true as const } : {}), ...(openedAt !== undefined ? { openedAt } : {}) });

describe('the saved rows of one mode', () => {
  it('lists only that mode, a Practice Table as Continue', () => {
    const rows = savedRows([practice('p'), online('o')], 'practice');
    expect(rows).toEqual([{ kind: 'practice', tableSessionId: 'p', seatCount: 6, name: '6-max Hold’em', blinds: '10 / 20', action: 'Continue', status: 'Practice' }]);
  });

  it('shows an Online Table the Guest is not at as "Not at this table", returning them to its address', () => {
    const [row] = savedRows([online('o', true)], 'online');
    expect(row).toMatchObject({ kind: 'away', action: 'Return to table', status: 'Not at this table', tableSessionId: 'o' });
    expect(row).not.toHaveProperty('live');
  });

  it('gives only the Current Table its live details, and Back to game', () => {
    const live = { handInProgress: true, stack: 2140 };
    const rows = savedRows([online('left', true), online('now')], 'online', { tableSessionId: 'now', ...live });
    expect(rows.find(row => row.tableSessionId === 'now')).toMatchObject({ kind: 'current', action: 'Back to game', live });
    expect(rows.find(row => row.tableSessionId === 'left')).not.toHaveProperty('live');
  });

  it('shows a Closed Table as "Closed", with nothing to open it by, and never as the Current Table', () => {
    const closed: SavedTable = { ...online('c', true, 100), closed: true };
    const [row] = savedRows([closed], 'online', { tableSessionId: 'c', handInProgress: true, stack: 1 });
    expect(row).toEqual({ kind: 'closed', tableSessionId: 'c', seatCount: 6, name: '6-max Hold’em', blinds: '10 / 20', status: 'Closed', openedAt: 100 });
  });

  it('orders a Closed Table by when it was last opened, like any other', () => {
    const rows = savedRows([{ ...online('c', true, 200), closed: true }, online('o', true, 100)], 'online');
    expect(rows.map(row => row.tableSessionId)).toEqual(['c', 'o']);
  });

  it('shows the Current Table without details while its live copy is not loaded', () => {
    const [row] = savedRows([online('now')], 'online');
    expect(row).toMatchObject({ kind: 'current', action: 'Back to game' });
    expect(row).not.toHaveProperty('live');
  });

  it('ignores live details for any table but the Current Table', () => {
    const [row] = savedRows([practice('p')], 'practice', { tableSessionId: 'p', handInProgress: true, stack: 1 });
    expect(row).not.toHaveProperty('live');
  });

  it('puts the most recently opened first, and tables never opened last in the order the server gave', () => {
    const rows = savedRows([practice('never-a'), practice('old', 100), practice('never-b'), practice('new', 200)], 'practice');
    expect(rows.map(row => row.tableSessionId)).toEqual(['new', 'old', 'never-a', 'never-b']);
    expect(rows.map(row => row.openedAt)).toEqual([200, 100, undefined, undefined]);
  });

  it('lists a row whose stored data could not be read, with nothing to open it by', () => {
    const [row] = savedRows([{ tableSessionId: 'x', mode: 'practice' }], 'practice');
    expect(row).toEqual({ kind: 'unreadable', tableSessionId: 'x' });
  });

  it('keeps ante and blinds readable', () => {
    const [row] = savedRows([{ ...practice('p'), stakes: { smallBlind: 1000, bigBlind: 2000, ante: 250 } }], 'practice');
    expect(row).toMatchObject({ blinds: '1,000 / 2,000', ante: '250' });
  });
});

describe('live details from the loaded Current Table', () => {
  const payout = { kind: 'payout', handId: 'hand-1', street: 'river', startsAt: 0, endsAt: 2000, durationMs: 2000 };
  const table = (status: string, stack?: number) => ({ viewerParticipantId: 'me', schedule: { phases: status === 'completed-hand' ? [payout] : [], actionWindow: null },
    view: { state: { status, handId: 'hand-1', participants: [{ participantId: 'me', seat: stack === undefined ? null : 1, stack: stack ?? 0 }, { participantId: 'bot', seat: 2, stack: 9 }] } } }) as unknown as ObservableTableSession;
  it('says whether a Hand is in progress, and the stack of the Guest seated', () => {
    expect(liveDetails('t', table('active-hand', 2140), 0)).toEqual({ tableSessionId: 't', handInProgress: true, stack: 2140 });
    expect(liveDetails('t', table('between-hands', 500), 0)).toEqual({ tableSessionId: 't', handInProgress: false, stack: 500 });
  });
  it('counts a Hand as in progress until its payout phase ends, as the Current Table banner does', () => {
    expect(liveDetails('t', table('completed-hand', 500), 1999)?.handInProgress).toBe(true);
    expect(liveDetails('t', table('completed-hand', 500), 2000)?.handInProgress).toBe(false);
  });
  it('has no stack for a Guest who is watching', () => {
    expect(liveDetails('t', table('between-hands'), 0)).toEqual({ tableSessionId: 't', handInProgress: false });
  });
  it('has none when the table is not loaded', () => expect(liveDetails('t', undefined, 0)).toBeUndefined());
});

describe('the Opened column', () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime();
  it('is a dash for a table never opened', () => expect(openedLabel(undefined, now)).toBe('—'));
  it('counts minutes, then hours, today', () => {
    expect(openedLabel(now - 20_000, now)).toBe('Just now');
    expect(openedLabel(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(openedLabel(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });
  it('names yesterday, then the date', () => {
    expect(openedLabel(new Date(2026, 10, 9, 23, 0).getTime(), now)).toBe('Yesterday');
    expect(openedLabel(new Date(2026, 9, 28, 12, 0).getTime(), now)).toBe('28 Oct');
    expect(openedLabel(new Date(2025, 11, 25, 12, 0).getTime(), now)).toBe('25 Dec 2025');
  });
});
