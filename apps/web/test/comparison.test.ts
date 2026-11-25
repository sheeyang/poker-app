import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, supportedStrategies, type ConcreteAction, type DecisionAnalysis, type ObservableCashGameState, type ReplayStep, type Street, type TableHandReplay } from '@poker/contracts';
import { addableStrategies, comparisonTargets, comparisonOrder } from '../src/comparison.js';

// One Hand as the server replays it for "you": you call preflop, check the flop, fold the turn. Rex's decisions are not yours.
function state(street: Street, actorId: string | null, decision: number | null): ObservableCashGameState {
  return {
    status: 'active-hand', buttonSeat: 1, board: [], pots: [], actorId, legalActions: [], handId: 'hand-3', decisionId: decision === null ? null : 'hand-3/decision-' + decision, street,
    smallBlindParticipantId: 'you', bigBlindParticipantId: 'rex', participants: [],
  };
}
const acted = (participantId: string, action: ConcreteAction) => ({ acted: { participantId, action } });
const decision = (street: Street, actorId: string, n: number, transition = {}): ReplayStep => ({ kind: 'decision', state: state(street, actorId, n), transition, ...(actorId === 'you' ? { viewerDecisionId: 'hand-3/decision-' + n } : {}) });
const steps: ReplayStep[] = [
  decision('preflop', 'you', 1),
  decision('preflop', 'rex', 2, acted('you', { type: 'call' })),
  decision('flop', 'you', 3, acted('rex', { type: 'check' })),
  decision('turn', 'rex', 4, acted('you', { type: 'check' })),
  decision('turn', 'you', 5, acted('rex', { type: 'bet', betTo: 40 })),
  { kind: 'result', state: state('turn', null, null), transition: acted('you', { type: 'fold' }) },
];
const replay: TableHandReplay = {
  tableSessionId: 'table-1', mode: 'online', viewerParticipantId: 'you', handId: 'hand-3', configuration: defaultConfiguration, steps,
  hand: { handId: 'hand-3', handNumber: 3, viewerDealtIn: true, showdown: false, board: [], dealtIn: [], payouts: [] },
  participants: [{ participantId: 'you', name: 'Alex', bot: false }, { participantId: 'rex', name: 'Rex', bot: true }],
};
const reference = defaultTrainerConfiguration.referenceStrategy;
const [simple, simpleHighest, uniform, highest] = supportedStrategies;
const result = (n: number, action: ConcreteAction, referenceStrategy = reference): DecisionAnalysis => ({
  ok: true, tableSessionId: 'table-1', participantId: 'you', handId: 'hand-3', decisionId: 'hand-3/decision-' + n, referenceStrategy, inputFingerprint: 'f', evaluationSeed: 's', selectionSeed: 's', engineVersion: 'v1', randomVersion: 'v1', evaluationVersion: 'v1',
  scoredDecision: { acceptedAction: action, scoringMethodVersion: 'v1' }, requestId: 'r', attemptId: 'a', status: 'pending',
});

describe('the supported Strategies', () => {
  it('are the two Policies under the two selectors, and each is a different Strategy', () => {
    expect(supportedStrategies).toHaveLength(4);
    expect(supportedStrategies).toContainEqual(simpleHeuristicPlayingStrategy);
    expect(supportedStrategies).toContainEqual(baselinePlayingStrategy);
    expect(supportedStrategies).toContainEqual(highestProbabilityPlayingStrategy);
    expect(new Set(supportedStrategies.map(strategy => JSON.stringify(strategy))).size).toBe(4);
  });
});

describe('who a comparison is made of', () => {
  it('always puts the Reference Strategy first, then the chosen Strategies in the order chosen', () => {
    expect(comparisonOrder(reference, [highest!, uniform!])).toEqual([reference, highest, uniform]);
    expect(comparisonOrder(reference, [])).toEqual([reference]);
  });
  it('never repeats the Reference Strategy, even when it was chosen, and never goes past the Reference plus 3', () => {
    expect(comparisonOrder(reference, [uniform!, simple!, highest!])).toEqual([reference, uniform, highest]);
    expect(comparisonOrder(uniform!, [simple!, simpleHighest!, highest!, uniform!])).toEqual([uniform, simple, simpleHighest, highest]);
    expect(comparisonOrder(uniform!, [simple!, simpleHighest!, highest!, uniform!]).length).toBeLessThanOrEqual(4);
  });
  it('offers to add only supported Strategies not already in it, and nothing once 3 are added', () => {
    expect(addableStrategies(reference, [])).toEqual([simpleHighest, uniform, highest]);
    expect(addableStrategies(reference, [uniform!])).toEqual([simpleHighest, highest]);
    expect(addableStrategies(reference, [uniform!, highest!, simpleHighest!])).toEqual([]);
    // A Reference Strategy other than the default leaves the default addable.
    expect(addableStrategies(highest!, [])).toEqual([simple, simpleHighest, uniform]);
  });
});

describe('analysis of one decision under several Strategies', () => {
  it('is one target for each Strategy at the reader’s own decision, Reference Strategy first, all for the same decision and action', () => {
    const targets = comparisonTargets(replay, 2, reference, [uniform!, highest!]);
    expect(targets.map(target => target.strategy)).toEqual([reference, uniform, highest]);
    expect(targets.map(target => target.decisionId)).toEqual(Array(3).fill('hand-3/decision-3'));
    expect(targets.map(target => target.action)).toEqual(Array(3).fill({ type: 'check' }));
    expect(new Set(targets.map(target => target.key)).size).toBe(3);
  });
  it('is none at anyone else’s decision, or away from a decision, whatever was chosen', () => {
    for (const index of [1, 3, 5]) expect(comparisonTargets(replay, index, reference, [uniform!])).toEqual([]);
    expect(comparisonTargets({ ...replay, viewerParticipantId: 'cy', steps: steps.map(({ viewerDecisionId: _, ...step }) => step) }, 2, reference, [uniform!])).toEqual([]);
  });
  it('accepts, for each Strategy, only the result that was analyzed under it', () => {
    const [mine, theirs] = comparisonTargets(replay, 2, reference, [uniform!]);
    expect(mine!.accepts(result(3, { type: 'check' }))).toBe(true);
    expect(mine!.accepts(result(3, { type: 'check' }, uniform!))).toBe(false);
    expect(theirs!.accepts(result(3, { type: 'check' }, uniform!))).toBe(true);
    expect(theirs!.accepts(result(3, { type: 'check' }))).toBe(false);
  });
  it('keeps a Strategy’s target when another one is added or removed, so its result stays where it was', () => {
    const before = comparisonTargets(replay, 2, reference, [uniform!]);
    const after = comparisonTargets(replay, 2, reference, [uniform!, highest!]);
    expect(after[1]!.key).toBe(before[1]!.key);
    expect(comparisonTargets(replay, 2, reference, [highest!])[1]!.key).toBe(after[2]!.key);
  });
});
