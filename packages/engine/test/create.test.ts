import { describe, expect, test } from 'vitest';
import { CashGame } from '../src/index.js';

const configuration = {
  seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0,
  minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000,
  allowSeatChanges: true, seed: 'known-fixture-seed',
};

describe('CashGame creation', () => {
  test('a configured CashGame starts empty and exposes only observable configuration', () => {
    const created = CashGame.create(configuration);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('Expected a valid CashGame');
    expect(created.game.toRecord()).toEqual({
      schemaVersion: 1, engineVersion: 'v1', configuration, commands: [],
    });
    expect(created.game.forParticipant('human').getView()).toEqual({
      configuration: {
        seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0,
        minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000,
        allowSeatChanges: true,
      },
      state: { status: 'between-hands', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [] },
      history: [],
    });
  });
});

test.each([
  ['seatCount', 1], ['seatCount', 10], ['seatCount', 2.5],
  ['smallBlind', 0], ['smallBlind', -1], ['smallBlind', 0.5],
  ['bigBlind', 9], ['ante', -1], ['ante', Number.MAX_SAFE_INTEGER + 1],
  ['minimumBuyIn', 1001], ['defaultBuyIn', 999], ['maximumBuyIn', 999],
  ['allowSeatChanges', 'yes'], ['seed', ''],
])('CashGame rejects invalid %s before a usable game exists', (field, value) => {
  const result = CashGame.create({ ...configuration, [field]: value } as typeof configuration);
  expect(result).toMatchObject({ ok: false, rejection: { code: 'invalid-configuration' } });
});

test('a detached version-1 record restores the complete empty game and preserves independent forks', () => {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame');
  configuration.smallBlind = 99;
  expect(created.game.forParticipant('human').getView().configuration.smallBlind).toBe(10);
  configuration.smallBlind = 10;
  const record = created.game.toRecord();
  const restored = CashGame.fromRecord(JSON.parse(JSON.stringify(record)));
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error('Expected restored CashGame');
  expect(restored.game.toRecord()).toEqual(record);
  expect(created.game.fork()).not.toBe(created.game);
  expect(created.game.fork().toRecord()).toEqual(record);
  expect(() => { (record.configuration as { seed: string }).seed = 'changed'; }).toThrow();
  const view = created.game.forParticipant('human').getView();
  expect(() => { (view.configuration as { smallBlind: number }).smallBlind = 99; }).toThrow();
  for (const invalid of [
    { ...record, schemaVersion: 2 }, { ...record, engineVersion: 'other' },
    { ...record, commands: [{ type: 'unknown' }] },
    { ...record, configuration: { ...record.configuration, seatCount: 0 } },
  ]) expect(CashGame.fromRecord(invalid).ok).toBe(false);
});
