import { describe, expect, it } from 'vitest';
import { analysisTabParam, pageTitle, tableAddress, tableSearch } from '../src/table-address.js';

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

describe('what a table address shows its visitor', () => {
  it('shows the table to a Participant who opened it under its own mode', () => {
    expect(tableAddress('practice', id, { mode: 'practice' })).toEqual({ show: 'table' });
    expect(tableAddress('online', id, { mode: 'online' })).toEqual({ show: 'table' });
  });
  it('corrects a Participant who opened their table under the other mode to its one address', () => {
    expect(tableAddress('online', id, { mode: 'practice' })).toEqual({ show: 'corrected', to: `/practice/${id}` });
    expect(tableAddress('practice', id, { mode: 'online' })).toEqual({ show: 'corrected', to: `/online/${id}` });
  });
  it('tells anyone the server does not answer that the table doesn’t exist, whichever mode the address names', () => {
    expect(tableAddress('practice', id, 'not-found')).toEqual({ show: 'missing' });
    expect(tableAddress('online', id, 'not-found')).toEqual({ show: 'missing' });
  });
});

describe('browser-tab titles', () => {
  it('name each list after its mode', () => {
    expect([pageTitle({ page: 'list', mode: 'practice' }), pageTitle({ page: 'list', mode: 'online' })]).toEqual(['Practice · Poker Trainer', 'Online · Poker Trainer']);
  });
  it('name a table by its format and stakes, so browser tabs can be told apart', () => {
    expect(pageTitle({ page: 'table', seatCount: 6, smallBlind: 10, bigBlind: 20 })).toBe('6-max Hold’em 10/20 · Poker Trainer');
    expect(pageTitle({ page: 'table', seatCount: 2, smallBlind: 1000, bigBlind: 2000 })).toBe('Heads-up Hold’em 1,000/2,000 · Poker Trainer');
    expect(pageTitle({ page: 'table', seatCount: 9, smallBlind: 5, bigBlind: 10 })).toBe('Full ring Hold’em 5/10 · Poker Trainer');
    expect(pageTitle({ page: 'table', seatCount: 4, smallBlind: 5, bigBlind: 10 })).toBe('4-player Hold’em 5/10 · Poker Trainer');
  });
  it('say when there is nothing at the address', () => {
    expect([pageTitle({ page: 'missing-table' }), pageTitle({ page: 'not-found' })]).toEqual(['Table not found · Poker Trainer', 'Page not found · Poker Trainer']);
  });
});
