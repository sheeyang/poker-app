import { expect, test } from 'vitest';
import { defaultConfiguration, settleLengths, type SettleLengths, type TableSchedule } from '@poker/contracts';
import { CashGame, type CashGameResult } from '@poker/engine';
import { handEndsAt, scheduleTransition, emptySchedule, type CurrentDecision, type ScheduleOptions } from '../src/schedule.js';
import { phaseInputs } from '../src/phase-inputs.js';
import { lengthOf } from './fixtures/phases.js';

/**
 * The shared Settle lengths may each be set to 0. The table session API cannot change them, so this drives the pure
 * scheduler, given lengths other than the shared ones, with the events of a real Hand.
 */
const none: SettleLengths = { deal: 0, street: 0, showdown: 0, payout: { practice: 0, online: 0 } };
const now = Date.UTC(2026, 0, 1);

function headsUp() {
  const created = CashGame.create({ ...defaultConfiguration, seed: 'settle-lengths'.padEnd(64, '0') });
  if (!created.ok) throw new Error(created.rejection.code);
  for (const result of [created.game.seatParticipant('ann', 1), created.game.seatParticipant('rex', 4)]) if (!result.ok) throw new Error(result.rejection.code);
  return created.game;
}
const eventsOf = (result: CashGameResult) => { if (!result.ok) throw new Error(result.rejection.code); return result.events; };
const decision = (game: CashGame): CurrentDecision => {
  const state = game.forParticipant('ann').getView().state;
  return state.actorId && state.decisionId ? { participantId: state.actorId, decisionId: state.decisionId } : null;
};
/** The schedule after `result`, a transition of `game`, accepted at `at`. */
const step = (game: CashGame, previous: TableSchedule, result: CashGameResult, at: number, options: Omit<ScheduleOptions, 'inputs'>) => {
  const events = eventsOf(result);
  return scheduleTransition(previous, events, decision(game), at, { ...options, inputs: phaseInputs(game, events) });
};

test('a Settle set to 0 schedules no stillness: the next phase or Action Window starts when the previous phase ends', () => {
  const game = headsUp();
  const dealt = step(game, emptySchedule, (game.startHand()), now, { settleLengths: none });
  expect(dealt.phases.map(phase => phase.kind)).toEqual(['deal']);
  expect(dealt.actionWindow).toMatchObject({ participantId: 'ann', opensAt: now + lengthOf('deal') });

  // The human goes all in and is called: a showdown, every street and the payout, back to back.
  const opens = dealt.actionWindow!.opensAt;
  const raised = step(game, dealt, (game.act('ann', { type: 'raise', raiseTo: 1000 })), opens, { settleLengths: none });
  const done = step(game, raised, (game.act('rex', { type: 'call' })), opens, { settleLengths: none });
  expect(done.phases.map(phase => phase.kind)).toEqual(['deal', 'showdown', 'street', 'street', 'street', 'payout']);
  for (const [previous, next] of done.phases.slice(0, -1).map((phase, index) => [phase, done.phases[index + 1]!] as const)) expect(next.startsAt).toBe(previous.endsAt);
  // The Hand ends when its payout does.
  expect(handEndsAt(done)).toBe(done.phases.at(-1)!.endsAt);
  expect(done.phases.at(-1)).toMatchObject({ kind: 'payout' });
});

test('only the Settle set to 0 is left out; the others keep their lengths', () => {
  const game = headsUp();
  const lengths: SettleLengths = { ...settleLengths, deal: 0 };
  const dealt = step(game, emptySchedule, (game.startHand()), now, { settleLengths: lengths });
  expect(dealt.phases.map(phase => phase.kind)).toEqual(['deal']);
  const folded = step(game, dealt, (game.act('ann', { type: 'fold' })), dealt.actionWindow!.opensAt, { settleLengths: lengths, mode: 'online' });
  expect(folded.phases.map(({ kind, durationMs }) => ({ kind, durationMs }))).toEqual([
    { kind: 'deal', durationMs: lengthOf('deal') }, { kind: 'payout', durationMs: lengthOf('payout') }, { kind: 'settle', durationMs: settleLengths.payout.online },
  ]);
});
