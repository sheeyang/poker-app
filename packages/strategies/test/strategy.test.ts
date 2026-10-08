import { expect, test } from 'vitest';
import { CashGame, deriveSeed, createRandomSource } from '@poker/engine';
import { defaultConfiguration } from '@poker/contracts';
import { UniformChoicePolicy, validatePolicyResult, ProbabilitySelector, HighestProbabilitySelector } from '../src/index.js';

function decision(stack = 147) {
  const created = CashGame.create({ ...defaultConfiguration, seatCount: 2, minimumBuyIn: 0, defaultBuyIn: stack, maximumBuyIn: stack, seed: 'heads-up-fixture' });
  if (!created.ok) throw new Error('Invalid fixture');
  created.game.seatParticipant('alice', 1);
  created.game.seatParticipant('bob', 2);
  created.game.startHand();
  return created.game.forParticipant('alice').getView();
}
test('UniformChoicePolicy covers legal unsized actions and exact endpoints including one short all-in', async () => {
  const policy = new UniformChoicePolicy();
  const ordinary = decision();
  expect(policy.checkCompatibility(ordinary)).toEqual({ compatible: true });
  expect(validatePolicyResult(await policy.evaluate(ordinary, { evaluationSeed: 'unused' }), ordinary).choices).toEqual([
    { action: { type: 'fold' }, probability: .25 },
    { action: { type: 'call' }, probability: .25 },
    { action: { type: 'raise', raiseTo: 40 }, probability: .25 },
    { action: { type: 'raise', raiseTo: 147 }, probability: .25 },
  ]);
  const short = decision(27);
  expect(validatePolicyResult(await policy.evaluate(short, { evaluationSeed: 'unused' }), short).choices).toEqual([
    { action: { type: 'fold' }, probability: 1 / 3 },
    { action: { type: 'call' }, probability: 1 / 3 },
    { action: { type: 'raise', raiseTo: 27 }, probability: 1 / 3 },
  ]);
});

test('shared validation rejects malformed distributions against the frozen legal description and normalizes only 1e-9 drift', () => {
  const view = decision();
  const call = { action: { type: 'call' as const }, probability: 1 };
  for (const choices of [[], [{ ...call, probability: 0 }], [call, call], [{ ...call, probability: NaN }], [{ ...call, probability: Infinity }], [{ ...call, probability: -1 }], [{ ...call, probability: 1.1 }], [{ ...call, probability: .99 }], [{ action: { type: 'check' as const }, probability: 1 }], [{ action: { type: 'raise' as const, raiseTo: 39 }, probability: 1 }], [{ action: { type: 'raise' as const, raiseTo: 40.5 }, probability: 1 }], [{ action: { type: 'raise' as const, raiseTo: 148 }, probability: 1 }]]) {
    expect(() => validatePolicyResult({ choices }, view)).toThrow();
  }
  const raw = { choices: [
    { action: { type: 'raise' as const, raiseTo: 147 }, probability: .6 },
    { action: { type: 'fold' as const }, probability: 0 },
    { action: { type: 'call' as const }, probability: .4000000005 },
  ], diagnostics: { information: ['informational only'] } };
  const result = validatePolicyResult(raw, view);
  expect(result.choices.map(c => c.action)).toEqual([{ type: 'call' }, { type: 'raise', raiseTo: 147 }]);
  expect(result.choices.reduce((sum, c) => sum + c.probability, 0)).toBeCloseTo(1, 15);
  expect(result.diagnostics).toEqual(raw.diagnostics);
  expect(raw.choices[0]?.probability).toBe(.6);
  expect(result).not.toBe(raw);
  expect(Object.isFrozen(result.choices[0]?.action)).toBe(true);
  expect(Object.isFrozen(result.diagnostics?.information)).toBe(true);
  expect(() => validatePolicyResult({ choices: [{ ...call, probability: 1 - 2e-9 }] }, view)).toThrow();
});

test('selectors consume the canonical distribution unchanged with independent v1 random seeds and first-maximum ties', async () => {
  const view = decision();
  const result = validatePolicyResult(await new UniformChoicePolicy().evaluate(view, { evaluationSeed: 'unused' }), view);
  const policySeed = deriveSeed('heads-up-fixture', 'policy', 'alice', 'hand-1/decision-1');
  const selectorSeed = deriveSeed('heads-up-fixture', 'selector', 'alice', 'hand-1/decision-1');
  // Independent Python stdlib oracle: docs/fixtures/strategy-v1.py, no production imports.
  expect(policySeed).toBe('9306c6cddb37a44ae7bc272f280146af0412e7786fefec56c73ca607c3c9cac6');
  expect(selectorSeed).toBe('50e60c430ba5b8f52529a1b5eb24082a3925f9e03e37cc18128aa37fed0247fa');
  expect(createRandomSource(policySeed).uint32()).toBe(723867575);
  expect(createRandomSource(selectorSeed).uint32()).toBe(2273501134);
  const sampler = new ProbabilitySelector();
  expect(sampler.select(result.choices, { selectionSeed: selectorSeed })).toEqual({ type: 'raise', raiseTo: 40 });
  const policyRandom = createRandomSource(policySeed);
  for (let i = 0; i < 300; i++) policyRandom.uint32();
  expect(sampler.select(result.choices, { selectionSeed: selectorSeed })).toEqual({ type: 'raise', raiseTo: 40 });
  expect(result.choices.map(c => c.probability)).toEqual([.25, .25, .25, .25]);
  const highest = new HighestProbabilitySelector();
  expect(highest.select(result.choices, { selectionSeed: 'not consumed or parsed' })).toEqual({ type: 'fold' });
  const tied = validatePolicyResult({ choices: [
    { action: { type: 'raise', raiseTo: 40 }, probability: .4 },
    { action: { type: 'raise', raiseTo: 147 }, probability: .1 },
    { action: { type: 'call' }, probability: .4 },
    { action: { type: 'fold' }, probability: .1 },
  ] }, view);
  expect(highest.select(tied.choices, { selectionSeed: 'unused' })).toEqual({ type: 'call' });
});

test('UniformChoicePolicy covers Bet endpoints on an actual flop and canonical validation orders interior sizes independently of construction', () => {
  const created = CashGame.create({ ...defaultConfiguration, seatCount: 2, minimumBuyIn: 0, defaultBuyIn: 147, maximumBuyIn: 147, seed: 'heads-up-fixture' });
  if (!created.ok) throw new Error('Invalid fixture');
  created.game.seatParticipant('alice', 1); created.game.seatParticipant('bob', 2); created.game.startHand();
  created.game.act('alice', { type: 'call' }); created.game.act('bob', { type: 'check' });
  const view = created.game.forParticipant('bob').getView();
  expect(view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 127 }]);
  expect(validatePolicyResult(new UniformChoicePolicy().evaluate(view, { evaluationSeed: 'unused' }), view).choices).toEqual([
    { action: { type: 'fold' }, probability: .25 }, { action: { type: 'check' }, probability: .25 }, { action: { type: 'bet', betTo: 20 }, probability: .25 }, { action: { type: 'bet', betTo: 127 }, probability: .25 },
  ]);
  const ordered = validatePolicyResult({ choices: [
    { action: { type: 'bet', betTo: 127 }, probability: .2 }, { action: { type: 'check' }, probability: .2 }, { action: { type: 'bet', betTo: 20 }, probability: .2 }, { action: { type: 'fold' }, probability: .2 }, { action: { type: 'bet', betTo: 50 }, probability: .2 },
  ] }, view);
  expect(ordered.choices.map(c => c.action)).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'bet', betTo: 20 }, { type: 'bet', betTo: 50 }, { type: 'bet', betTo: 127 }]);
  // Python deck fixture remains unchanged after independently consuming Policy/selector sources.
  createRandomSource(deriveSeed('heads-up-fixture', 'policy', 'bob', view.state.decisionId!)).uint32();
  createRandomSource(deriveSeed('heads-up-fixture', 'selector', 'bob', view.state.decisionId!)).unit();
  expect(created.game.forParticipant('alice').getView().state.participants.find(p => p.participantId === 'alice')?.holeCards).toEqual(['4s', '5d']);
  expect(view.state.board).toEqual(['9c', '4d', 'Tc']);
});
