import { expect, test } from 'vitest';
import { compareHandRanks, rankHand } from '../src/index.js';

test.each([
  ['As Ks Qs Js Ts 2d 3c', 'straight-flush', [14]],
  ['As Ah Ad Ac Kd 2c 3s', 'four-of-a-kind', [14, 13]],
  ['As Ah Ad Kc Kd 2c 3s', 'full-house', [14, 13]],
  ['As Js 9s 5s 2s Kd Qc', 'flush', [14, 11, 9, 5, 2]],
  ['As 2d 3c 4h 5s Kd Qc', 'straight', [5]],
  ['As Ah Ad Kc Qd 2c 3s', 'three-of-a-kind', [14, 13, 12]],
  ['As Ah Kd Kc Qd 2c 3s', 'two-pair', [14, 13, 12]],
  ['As Ah Kd Qc Jd 2c 3s', 'one-pair', [14, 13, 12, 11]],
  ['As Kd Qc 9h 7s 2d 3c', 'high-card', [14, 13, 12, 9, 7]],
] as const)('the strongest five-card rank of %s is %s with complete kickers', (cards, category, kickers) => {
  expect(rankHand(cards.split(' '))).toEqual({ category, kickers });
});

test.each([
  ['As Ah Ad Ac Kd 2c 3s', 'As Ah Ad Ac Qd 2c 3s'],
  ['As Ah Ad Kc Kd 2c 3s', 'As Ah Ad Qc Qd 2c 3s'],
  ['As Js 9s 5s 3s Kd Qc', 'Ah Jh 9h 5h 2h Kc Qd'],
  ['As Ah Ad Kc Qd 2c 3s', 'As Ah Ad Kc Jd 2c 3s'],
  ['As Ah Kd Kc Qd 2c 3s', 'As Ah Kd Kc Jd 2c 3s'],
  ['As Ah Kd Qc 9d 2c 3s', 'As Ah Kd Qc 8d 2c 3s'],
  ['As Kd Qc 9h 7s 2d 3c', 'As Kd Qc 9h 6s 2d 3c'],
  ['2c 3d 4h 5s 6c Ah Kd', 'As 2d 3c 4h 5s Kd Qc'],
  ['9s Ts Js Qs Ks 2c 3c', '8h 9h Th Jh Qh 2d 3d'],
])('complete rank and kickers distinguish %s from %s', (winner, loser) => {
  expect(compareHandRanks(rankHand(winner.split(' ')), rankHand(loser.split(' ')))).toBeGreaterThan(0);
});

test('best-five selection can use zero, one, or two hole cards, and handles two trips and three pairs', () => {
  expect(rankHand('As Kd Qc Jh Ts 2c 3c'.split(' '))).toEqual({ category: 'straight', kickers: [14] });
  expect(rankHand('9c 4d Tc Jc 3c 2c Ah'.split(' '))).toEqual({ category: 'flush', kickers: [11, 10, 9, 3, 2] });
  expect(rankHand('As Ah 2d 3c 4h Ad Ac'.split(' '))).toEqual({ category: 'four-of-a-kind', kickers: [14, 4] });
  expect(rankHand('As Ah Ad Kc Kh Kd 2c'.split(' '))).toEqual({ category: 'full-house', kickers: [14, 13] });
  expect(rankHand('As Ah Kc Kh Qc Qh 2c'.split(' '))).toEqual({ category: 'two-pair', kickers: [14, 13, 12] });
  expect(rankHand('Ks As 2d 3c 4h 9s 7d'.split(' '))).toEqual({ category: 'high-card', kickers: [14, 13, 9, 7, 4] });
});

test('ranking rejects malformed or repeated cards and returns detached immutable ranks', () => {
  for (const cards of ['As Ah Ad Ac', 'As As Ad Ac Kd', '1s Ah Ad Ac Kd', 'As Ah Ad Ac Kd Qc Js Ts']) expect(() => rankHand(cards.split(' '))).toThrow();
  const rank = rankHand('As Ah Ad Ac Kd'.split(' '));
  expect(() => { (rank.kickers as number[])[0] = 2; }).toThrow();
});

test('rank comparison orders all nine categories without using suits', () => {
  const ranks = [
    'As Ks Qs Js Ts 2d 3c', 'As Ah Ad Ac Kd 2c 3s', 'As Ah Ad Kc Kd 2c 3s',
    'As Js 9s 5s 2s Kd Qc', 'As 2d 3c 4h 5s Kd Qc', 'As Ah Ad Kc Qd 2c 3s',
    'As Ah Kd Kc Qd 2c 3s', 'As Ah Kd Qc Jd 2c 3s', 'As Kd Qc 9h 7s 2d 3c',
  ].map(cards => rankHand(cards.split(' ')));
  for (let i = 0; i < ranks.length - 1; i++) expect(compareHandRanks(ranks[i]!, ranks[i + 1]!)).toBeGreaterThan(0);
  expect(compareHandRanks(rankHand('As Ks Qs Js Ts 2d 3c'.split(' ')), rankHand('Ah Kh Qh Jh Th 8s 9s'.split(' ')))).toBe(0);
});
