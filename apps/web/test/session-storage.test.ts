import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'poker-trainer-v1';
let store: Map<string, string>;

async function loadSession() {
  vi.resetModules();
  return (await import('../src/session.js')).useSession;
}

beforeEach(() => {
  store = new Map();
  const local = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('window', { localStorage: local });
});
afterEach(() => vi.unstubAllGlobals());

describe('browser storage keeps only preferences', () => {
  it('writes the animations and analysis panel preferences and nothing else', async () => {
    const session = await loadSession();
    session.getState().setPending({ kind: 'create', body: { requestId: 'r1', mode: 'online' } as never });
    session.getState().setSetup({ requestId: 'r1', tableId: 't' });
    session.getState().setAnimations(false);
    session.getState().toggleAnalysis();
    expect(Object.keys(JSON.parse(store.get(KEY)!).state).sort()).toEqual(['analysisOpen', 'animations', 'opened']);
    expect(JSON.parse(store.get(KEY)!).state).toMatchObject({ animations: false, analysisOpen: false });
  });

  it('holds the pending request and practice setup in memory for the life of the page', async () => {
    const session = await loadSession();
    const attempt = { kind: 'create', body: { requestId: 'r1', mode: 'online' } } as never;
    session.getState().setPending(attempt);
    session.getState().setSetup({ requestId: 'r1' });
    expect(session.getState().pending).toBe(attempt);
    expect(session.getState().setup).toEqual({ requestId: 'r1' });
  });

  it('starts a reloaded page with no request, setup or selection, and removes what an earlier version stored', async () => {
    store.set(KEY, JSON.stringify({ version: 0, state: {
      selectedId: 't', pending: { kind: 'create', body: { requestId: 'r1' } }, setup: { requestId: 'r1', tableId: 't' }, analysisOpen: false, animations: false,
    } }));
    const session = await loadSession();
    expect(session.getState()).toMatchObject({ pending: null, setup: null, analysisOpen: false, animations: false });
    // The table on screen comes from the address: nothing is selected in storage or in memory.
    expect(session.getState()).not.toHaveProperty('selectedId');
    expect(Object.keys(JSON.parse(store.get(KEY)!).state).sort()).toEqual(['analysisOpen', 'animations', 'opened']);
  });
});

describe('last-opened times', () => {
  it('writes the time a table was opened, keyed by table, and a reloaded page reads it back', async () => {
    const session = await loadSession();
    expect(session.getState().opened).toEqual({});
    session.getState().markOpened('t1', 1000);
    session.getState().markOpened('t2', 2000);
    expect(JSON.parse(store.get(KEY)!).state.opened).toEqual({ t1: 1000, t2: 2000 });
    expect((await loadSession()).getState().opened).toEqual({ t1: 1000, t2: 2000 });
  });

  it('keeps the preferences of an earlier version and starts with no times', async () => {
    store.set(KEY, JSON.stringify({ version: 1, state: { analysisOpen: false, animations: false } }));
    const session = await loadSession();
    expect(session.getState()).toMatchObject({ analysisOpen: false, animations: false, opened: {} });
  });
});
