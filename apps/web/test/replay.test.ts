import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ConcreteAction, type DecisionAnalysis, type ObservableCashGameState, type ReplayStep, type ReplayTransition, type Street, type TableHandReplay, type TableReplayStep } from '@poker/contracts';
import { actedLabel, concealedHand, openStep, replayAnalysisTarget, replayControls, replayResult, stepFelt, stepKey, stepLabel } from '../src/replay.js';

// One Hand as the server replays it for "you": you call, Rex checks; on the flop Rex checks and you check; on the turn Rex bets and you fold.
function state(street: Street, actorId: string | null, decision: number | null, change: Partial<ObservableCashGameState> = {}): ObservableCashGameState {
  return {
    status: 'active-hand', buttonSeat: 1, board: street === 'preflop' ? [] : street === 'flop' ? ['As', 'Kd', '7c'] : ['As', 'Kd', '7c', '2h'], pots: [], actorId, legalActions: [],
    handId: 'hand-3', decisionId: decision === null ? null : 'hand-3/decision-' + decision, street, smallBlindParticipantId: 'you', bigBlindParticipantId: 'rex',
    participants: [
      { participantId: 'you', seat: 1, stack: 980, sittingOut: false, inHand: true, handSeat: 1, folded: false, allIn: false, contribution: 20, anteContribution: 0, wager: 0, cardCount: 2, holeCards: ['Ah', 'Qs'] },
      { participantId: 'rex', seat: 4, stack: 980, sittingOut: false, inHand: true, handSeat: 4, folded: false, allIn: false, contribution: 20, anteContribution: 0, wager: 0, cardCount: 2 },
    ],
    ...change,
  };
}
const acted = (participantId: string, action: ConcreteAction): ReplayTransition => ({ acted: { participantId, action } });
const decision = (street: Street, actorId: string, n: number, transition: ReplayTransition = {}): ReplayStep => ({ kind: 'decision', state: state(street, actorId, n), transition, ...(actorId === 'you' ? { viewerDecisionId: 'hand-3/decision-' + n } : {}) });
const steps: TableReplayStep[] = [
  decision('preflop', 'you', 1, { deal: { dealt: [{ participantId: 'you', cardCount: 2 }, { participantId: 'rex', cardCount: 2 }], blinds: ['you', 'rex'], refills: [] } }),
  decision('preflop', 'rex', 2, acted('you', { type: 'call' })),
  { kind: 'street', state: state('flop', null, null), transition: { ...acted('rex', { type: 'check' }), street: { swept: ['you', 'rex'], cardCount: 3 } } },
  decision('flop', 'rex', 3),
  decision('flop', 'you', 4, acted('rex', { type: 'check' })),
  { kind: 'street', state: state('turn', null, null), transition: { ...acted('you', { type: 'check' }), street: { swept: [], cardCount: 1 } } },
  decision('turn', 'rex', 5),
  decision('turn', 'you', 6, acted('rex', { type: 'bet', betTo: 40 })),
  { kind: 'result', state: state('turn', null, null, { status: 'completed-hand' }), transition: { ...acted('you', { type: 'fold' }), payout: { awards: [{ participantId: 'rex', won: 40, returned: 40 }] } },
    result: { board: ['As', 'Kd', '7c', '2h'], showdown: false, payouts: [{ participantId: 'rex', amount: 80 }], holeCards: [{ participantId: 'you', cards: ['Ah', 'Qs'] }] } },
];
const replay: TableHandReplay = {
  tableSessionId: 'table-1', mode: 'online', viewerParticipantId: 'you', handId: 'hand-3', configuration: defaultConfiguration, steps,
  hand: { handId: 'hand-3', handNumber: 3, viewerDealtIn: true, dealtIn: [{ participantId: 'you', name: 'Alex' }, { participantId: 'rex', name: 'Rex' }] },
  participants: [{ participantId: 'you', name: 'Alex', bot: false }, { participantId: 'rex', name: 'Rex', bot: true }],
};
/** The same Hand for someone who watched it: none of its decisions are theirs. */
const watched: TableHandReplay = { ...replay, viewerParticipantId: 'cy', steps: steps.map(({ viewerDecisionId: _, ...step }) => step) };

describe('a Replay Step’s address', () => {
  it('names a decision by its number in the Hand, a street reveal by its street, and the result', () => {
    expect(steps.map(step => stepKey(step))).toEqual(['decision-1', 'decision-2', 'flop', 'decision-3', 'decision-4', 'turn', 'decision-5', 'decision-6', 'result']);
  });
  it('reopens the step it names, and the Hand’s first step when it names none the Hand has', () => {
    expect(openStep(replay, 'decision-4')).toBe(4);
    expect(openStep(replay, 'result')).toBe(8);
    for (const missing of [undefined, 'river', 'decision-9']) expect(openStep(replay, missing)).toBe(0);
  });
});

describe('the Hand whose list row is concealed while it is replayed', () => {
  it('is the open Hand at every step before its result, and while its replay has not loaded', () => {
    for (const key of [undefined, 'decision-1', 'flop', 'decision-4', 'turn', 'decision-6', 'river', 'nonsense']) expect(concealedHand('hand-3', replay, key)).toBe('hand-3');
    expect(concealedHand('hand-3', undefined, 'result')).toBe('hand-3');
  });
  it('is nothing at the result step, and nothing when no Hand is open', () => {
    expect(concealedHand('hand-3', replay, 'result')).toBeUndefined();
    expect(concealedHand(undefined, undefined, undefined)).toBeUndefined();
  });
  it('says who won what at the result step alone', () => {
    expect(steps.slice(0, -1).map(step => replayResult(replay, step))).toEqual(Array(8).fill(undefined));
    expect(replayResult(replay, steps.at(-1)!)).toBe('Rex won 80');
    expect(replayResult({ ...replay, viewerParticipantId: 'rex' }, steps.at(-1)!)).toBe('You won 80');
  });
});

describe('the replay controls', () => {
  it('step forward and back one step at a time, with nothing before the first step or after the result', () => {
    expect(replayControls(replay, 0)).toMatchObject({ previous: undefined, next: 'decision-2' });
    expect(replayControls(replay, 4)).toMatchObject({ previous: 'decision-3', next: 'turn' });
    expect(replayControls(replay, 8)).toMatchObject({ previous: 'decision-6', next: undefined });
  });
  it('jump to each street the Hand reached, preflop at its first step, and know the street on show', () => {
    expect(replayControls(replay, 4).streets).toEqual([{ street: 'preflop', step: 'decision-1', current: false }, { street: 'flop', step: 'flop', current: true }, { street: 'turn', step: 'turn', current: false }]);
    expect(replayControls(replay, 8).streets.filter(s => s.current).map(s => s.street)).toEqual(['turn']);
  });
  it('jump to the viewer’s next decision after the step on show, and offer none past their last', () => {
    expect([0, 1, 4, 5, 6, 7, 8].map(index => replayControls(replay, index).nextDecision)).toEqual(['decision-4', 'decision-4', 'decision-6', 'decision-6', 'decision-6', undefined, undefined]);
    expect(steps.map((_, index) => replayControls(watched, index).nextDecision)).toEqual(steps.map(() => undefined));
  });
});

describe('a Replay Step on the felt', () => {
  it('is the table as the step shows it, viewed by the viewer, with the decisions taken before it', () => {
    const felt = stepFelt(replay, 5);
    expect(felt.state).toBe(steps[5]!.state);
    expect(felt).toMatchObject({ tableSessionId: 'table-1', mode: 'online', viewerParticipantId: 'you', seatCount: defaultConfiguration.seatCount, phases: [], actionWindow: null });
    expect(felt.decisions.map(d => [d.participantId, d.action.type])).toEqual([['you', 'call'], ['rex', 'check'], ['rex', 'check'], ['you', 'check']]);
    expect(stepFelt(replay, 0).decisions).toEqual([]);
  });
  it('names everyone seated in the Hand, a Bot as a Bot, and shows nobody as disconnected', () => {
    expect(stepFelt(replay, 5).participants).toEqual([{ participantId: 'you', name: 'Alex', bot: false, disconnected: false }, { participantId: 'rex', name: 'Rex', bot: true, disconnected: false }]);
  });
});

describe('a Replay Step’s label', () => {
  it('says whose decision comes next, which street was dealt, or that it is the result', () => {
    expect(steps.map(step => stepLabel(replay, step))).toEqual(['Your decision', 'Rex to act', 'Flop', 'Rex to act', 'Your decision', 'Turn', 'Rex to act', 'Your decision', 'Result']);
    expect(stepLabel(watched, steps[0]!)).toBe('Alex to act');
  });
});

describe('what a Replay Step’s transition did', () => {
  it('names the decision taken just before it, in the past tense, the viewer as "You"', () => {
    expect(steps.map(step => actedLabel(replay, step))).toEqual([undefined, 'You called', 'Rex checked', undefined, 'Rex checked', 'You checked', undefined, 'Rex bet 40', 'You folded']);
    expect(actedLabel(replay, { ...steps[1]!, transition: acted('rex', { type: 'raise', raiseTo: 1200 }) })).toBe('Rex raised to 1,200');
    expect(actedLabel(watched, steps[1]!)).toBe('Alex called');
  });
});

describe('analysis at a Replay Step', () => {
  const reference = defaultTrainerConfiguration.referenceStrategy;
  /** A result for "your" decision `n`, as the server would answer it. */
  const result = (n: number, action: ConcreteAction, referenceStrategy = reference): DecisionAnalysis => ({
    ok: true, tableSessionId: 'table-1', participantId: 'you', handId: 'hand-3', decisionId: 'hand-3/decision-' + n, referenceStrategy, inputFingerprint: 'f', evaluationSeed: 's', selectionSeed: 's', engineVersion: 'v1', randomVersion: 'v1', evaluationVersion: 'v1',
    scoredDecision: { acceptedAction: action, scoringMethodVersion: 'v1' }, requestId: 'r', attemptId: 'a', status: 'pending',
  });
  it('is offered only at the viewer’s own decisions, with the action they took there', () => {
    expect(steps.map((_, index) => replayAnalysisTarget(replay, index, reference)?.decisionId)).toEqual(['hand-3/decision-1', undefined, undefined, undefined, 'hand-3/decision-4', undefined, undefined, 'hand-3/decision-6', undefined]);
    expect([0, 4, 7].map(index => replayAnalysisTarget(replay, index, reference)?.action)).toEqual([{ type: 'call' }, { type: 'check' }, { type: 'fold' }]);
  });
  it('is never offered to someone who watched the Hand', () => {
    expect(steps.map((_, index) => replayAnalysisTarget(watched, index, reference))).toEqual(steps.map(() => undefined));
  });
  it('accepts only the result for that decision, the action taken and the current Reference Strategy', () => {
    const target = replayAnalysisTarget(replay, 4, reference)!;
    expect(target.accepts(result(4, { type: 'check' }))).toBe(true);
    expect(target.accepts(result(6, { type: 'check' }))).toBe(false);
    expect(target.accepts(result(4, { type: 'fold' }))).toBe(false);
    expect(target.accepts(result(4, { type: 'check' }, baselinePlayingStrategy))).toBe(false);
    expect(target.accepts({ ...result(4, { type: 'check' }), tableSessionId: 'table-2' })).toBe(false);
  });
  it('is a different target once the Reference Strategy changes, so the decision is analyzed again', () => {
    expect(replayAnalysisTarget(replay, 4, baselinePlayingStrategy)!.key).not.toBe(replayAnalysisTarget(replay, 4, reference)!.key);
    expect(replayAnalysisTarget(replay, 4, { ...reference })!.key).toBe(replayAnalysisTarget(replay, 4, reference)!.key);
  });
});
