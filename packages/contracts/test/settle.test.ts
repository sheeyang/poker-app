import { expect, test } from 'vitest';
import { settleAfter, settleLengths, type SettleLengths } from '@poker/contracts';

test('a Settle follows each presenting phase with the length chosen by that phase and, after the payout, by table mode', () => {
  expect(settleAfter('deal', 'practice')).toBe(300);
  expect(settleAfter('street', 'online')).toBe(300);
  expect(settleAfter('showdown', 'practice')).toBe(1200);
  expect(settleAfter('payout', 'practice')).toBe(600);
  expect(settleAfter('payout', 'online')).toBe(3000);
});

test('each Settle length may be 0', () => {
  const none: SettleLengths = { deal: 0, street: 0, showdown: 0, payout: { practice: 0, online: 0 } };
  for (const kind of ['deal', 'street', 'showdown', 'payout'] as const) for (const mode of ['practice', 'online'] as const) expect(settleAfter(kind, mode, none)).toBe(0);
  expect(settleAfter('showdown', 'online', { ...settleLengths, showdown: 0 })).toBe(0);
  expect(settleAfter('deal', 'online', { ...settleLengths, showdown: 0 })).toBe(300);
});
