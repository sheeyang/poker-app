import { describe, expect, it } from 'vitest';
import { defaultConfiguration, type JoinLinkPreview, type SavedTable } from '@poker/contracts';
import { RequestFailure } from '@poker/client';
import { analysisTabParam, currentTableRefusal, historyPath, historySearch, joinLink, joinPreviewWanted, listPath, pageTitle, parseAddress, tableAddress, tablePath, tableSearch } from '../src/table-address.js';

describe('the analysis tab kept in a table address', () => {
  it('accepts live, hand and session, and ignores anything else', () => {
    expect(analysisTabParam('live')).toBe('live');
    expect(analysisTabParam('hand')).toBe('hand');
    expect(analysisTabParam('session')).toBe('session');
    for (const bad of ['', 'Live', 'summary', 1, undefined, null, ['live']]) expect(analysisTabParam(bad)).toBeUndefined();
  });
  it('drops an invalid parameter from the route search', () => {
    expect(tableSearch({ analysis: 'session', other: 1 })).toEqual({ analysis: 'session' });
    expect(tableSearch({ analysis: 'nonsense' })).toEqual({});
    expect(tableSearch({})).toEqual({});
  });
});

const id = '7f3a2c1e-0000-4000-8000-000000000001';
const preview: JoinLinkPreview = { ok: true, ownerName: 'Sam', configuration: defaultConfiguration, options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, placesTaken: 3, alreadyJoined: false };

describe('what a table address shows its visitor', () => {
  it('shows the table to a Participant who opened it under its own mode', () => {
    expect(tableAddress('practice', id, { mode: 'practice' })).toEqual({ show: 'table' });
    expect(tableAddress('online', id, { mode: 'online' })).toEqual({ show: 'table' });
  });
  it('corrects a Participant who opened their table under the other mode to its one address', () => {
    expect(tableAddress('online', id, { mode: 'practice' })).toEqual({ show: 'corrected', to: `/practice/${id}` });
    expect(tableAddress('practice', id, { mode: 'online' })).toEqual({ show: 'corrected', to: `/online/${id}` });
  });
  it('tells anyone the server does not answer that a Practice address’s table doesn’t exist', () => {
    expect(tableAddress('practice', id, 'not-found')).toEqual({ show: 'missing' });
  });
  it('asks for the Join Link’s preview before deciding what an Online address shows a visitor who is not at its table', () => {
    expect(joinPreviewWanted('online', 'not-found')).toBe(true);
    expect(tableAddress('online', id, 'not-found')).toBeUndefined();
    // Nobody previews a Practice address, nor an address the visitor's own table already answers.
    expect(joinPreviewWanted('practice', 'not-found')).toBe(false);
    expect(joinPreviewWanted('online', { mode: 'online' })).toBe(false);
    expect(joinPreviewWanted('online', { mode: 'practice' })).toBe(false);
  });
  it('shows the join form at an Online Table’s address, to a newcomer and to a Guest who left alike', () => {
    expect(tableAddress('online', id, 'not-found', preview)).toEqual({ show: 'join-form', preview });
    const returning = { ...preview, returningAs: 'Ben' };
    expect(tableAddress('online', id, 'not-found', returning)).toEqual({ show: 'join-form', preview: returning });
  });
  it('shows a password join form, with only the owner’s name, at an Online Table with a Table Password', () => {
    const locked: JoinLinkPreview = { ok: true, ownerName: 'Sam', passwordRequired: true };
    expect(tableAddress('online', id, 'not-found', locked)).toEqual({ show: 'password-join-form', preview: locked });
  });
  it('tells a visitor that an Online address with no Online Table behind it doesn’t exist, a Practice Table’s ID included', () => {
    expect(tableAddress('online', id, 'not-found', 'not-found')).toEqual({ show: 'missing' });
  });
  it('tells anyone opening a Closed Table’s address that the table closed', () => {
    expect(tableAddress('online', id, 'not-found', 'closed')).toEqual({ show: 'closed' });
  });
  it('lets the table itself, not its preview, answer a Participant', () => {
    expect(tableAddress('online', id, { mode: 'online' }, { ...preview, alreadyJoined: true })).toEqual({ show: 'table' });
  });
});

describe('the Join Link', () => {
  it('is the Online Table’s own address, at the page’s origin', () => {
    expect(joinLink('https://poker.example', id)).toBe(`https://poker.example/online/${id}`);
  });
});

describe('browser-tab titles', () => {
  it('name each list after its mode', () => {
    expect([pageTitle({ page: 'list', mode: 'practice' }), pageTitle({ page: 'list', mode: 'online' })]).toEqual(['Practice · Poker Trainer', 'Online · Poker Trainer']);
  });
  it('name a table by its format and stakes, so browser tabs can be told apart', () => {
    expect(pageTitle({ page: 'table', seatCount: 6, smallBlind: 10, bigBlind: 20 })).toBe('6-max Hold’em · 10 / 20 · Poker Trainer');
    expect(pageTitle({ page: 'table', seatCount: 2, smallBlind: 1000, bigBlind: 2000 })).toBe('Heads-up Hold’em · 1,000 / 2,000 · Poker Trainer');
    expect(pageTitle({ page: 'table', seatCount: 9, smallBlind: 5, bigBlind: 10 })).toBe('Full ring Hold’em · 5 / 10 · Poker Trainer');
    expect(pageTitle({ page: 'table', seatCount: 4, smallBlind: 5, bigBlind: 10 })).toBe('4-player Hold’em · 5 / 10 · Poker Trainer');
  });
  it('name a Join Link by whose table it opens, since its visitor can’t see the table yet', () => {
    expect(pageTitle({ page: 'join', ownerName: 'Sam' })).toBe('Join Sam’s table · Poker Trainer');
  });
  it('say when there is nothing at the address', () => {
    expect([pageTitle({ page: 'missing-table' }), pageTitle({ page: 'not-found' })]).toEqual(['Table not found · Poker Trainer', 'Page not found · Poker Trainer']);
  });
  it('say when the table at the address has closed', () => {
    expect(pageTitle({ page: 'closed-table' })).toBe('Table closed · Poker Trainer');
  });
});

describe('the refusal of a Guest who is already at another Online Table', () => {
  const refusal = new RequestFailure('current-table-elsewhere', 'Leave it first.', true, { currentTableId: id });
  it('links to their Current Table, described from their saved tables when it is listed there', () => {
    const listed: SavedTable = { tableSessionId: id, mode: 'online', seatCount: 6, stakes: { smallBlind: 10, bigBlind: 20, ante: 0 } };
    expect(currentTableRefusal(refusal, [listed])).toEqual({ tableSessionId: id, table: '6-max Hold’em · 10 / 20' });
    expect(currentTableRefusal(refusal, undefined)).toEqual({ tableSessionId: id });
  });
  it('is no other failure', () => {
    expect(currentTableRefusal(new RequestFailure('table-full', 'Full.', true), [])).toBeUndefined();
    expect(currentTableRefusal(new RequestFailure('current-table-elsewhere', 'Leave it first.', true), [])).toBeUndefined();
    expect(currentTableRefusal(new Error('offline'), [])).toBeUndefined();
    expect(currentTableRefusal(null, [])).toBeUndefined();
  });
});

describe('reading an address', () => {
  const id = '7f3a0000-0000-4000-8000-000000000001';
  it('names the mode of a list, and the mode and table of a table address', () => {
    expect(parseAddress(listPath('practice'))).toEqual({ mode: 'practice' });
    expect(parseAddress(tablePath('online', id))).toEqual({ mode: 'online', tableSessionId: id });
    expect(parseAddress('/online/')).toEqual({ mode: 'online' });
  });
  it('names nothing outside the two modes', () => {
    for (const path of ['/', '/somewhere', '/somewhere/' + id, '/join/token']) expect(parseAddress(path)).toBeUndefined();
  });
});

describe('a table’s Table History address', () => {
  it('lives under the table’s own address, under its own mode, and names the Hand to open when it has one', () => {
    expect(historyPath('practice', id)).toBe(`/practice/${id}/history`);
    expect(historyPath('online', id)).toBe(`/online/${id}/history`);
    expect(historyPath('online', id, 'hand-37')).toBe(`/online/${id}/history?hand=hand-37`);
  });
  it('is read back as the table’s history section, so the table’s own page is not mistaken for it', () => {
    expect(parseAddress(`/online/${id}/history`)).toEqual({ mode: 'online', tableSessionId: id, history: true });
    expect(parseAddress(`/practice/${id}`)).toEqual({ mode: 'practice', tableSessionId: id });
    expect(parseAddress(`/practice/${id}/elsewhere`)).toEqual({ mode: 'practice', tableSessionId: id });
  });
  it('keeps a valid Hand in the route search and drops anything else', () => {
    expect(historySearch({ hand: 'hand-12', other: 1 })).toEqual({ hand: 'hand-12' });
    for (const bad of ['', 'hand-', 'hand-0x', 'Hand-1', 12, undefined, ['hand-1']]) expect(historySearch({ hand: bad })).toEqual({});
  });
  it('titles its page by the table’s format and stakes', () => {
    expect(pageTitle({ page: 'history', seatCount: 6, smallBlind: 10, bigBlind: 20 })).toBe('Table History · 6-max Hold’em · 10 / 20 · Poker Trainer');
  });
});
