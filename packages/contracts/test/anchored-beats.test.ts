import { describe, expect, it } from 'vitest';
import { committedTimings, dealBeatDescription, dealBeats, evaluateBeats, type BeatDef, type DealInputs } from '../src/index.js';

const deal = (players: number, refills: DealInputs['refills'] = []): DealInputs => {
  const ids = Array.from({ length: players }, (_, i) => `p${i + 1}`);
  return { dealt: ids.map(participantId => ({ participantId, cardCount: 2 })), blinds: ids.slice(0, 2), refills };
};

describe('the deal’s beat description', () => {
  const beat = (name: string) => dealBeatDescription.find(b => b.beat === name)!;

  it('names every deal beat once', () => {
    expect(dealBeatDescription.map(b => b.beat)).toEqual(['cardsReturn', 'buttonMoves', 'refill', 'blind', 'blindAppears', 'card', 'cardAppears', 'cardTurn']);
  });

  it('gives each beat what it follows, its gap and its length', () => {
    expect(beat('buttonMoves')).toMatchObject({ follows: 'the start of the phase', gap: '0', length: 'deal.buttonMoves' });
    expect(beat('blind')).toMatchObject({ follows: 'the end of the last refill', gap: 'deal.blindsAfterRefill × refilled + deal.blindStagger × index', length: 'deal.blindFlight' });
    expect(beat('card')).toMatchObject({ follows: 'the start of the first blind', gap: 'deal.cardsAfterBlinds + min(deal.cardGap, floor(deal.cardsRoom / cards)) × index', length: 'deal.cardFlight' });
    expect(beat('cardTurn')).toMatchObject({ follows: 'the end of its card', gap: 'deal.turnAfterLanding', length: 'deal.turn' });
    expect(beat('cardAppears')).toMatchObject({ follows: 'the end of its card', gap: 'deal.cardAppearsBefore × -1', length: '0' });
  });

  it('lists exactly the timings in a beat’s own gap or length, not those that only move it because an earlier beat grew', () => {
    expect(beat('buttonMoves').setBy).toEqual(['deal.buttonMoves']);
    expect(beat('refill').setBy).toEqual(['deal.refillLands']);
    expect(beat('blind').setBy).toEqual(['deal.blindsAfterRefill', 'deal.blindStagger', 'deal.blindFlight']);
    expect(beat('card').setBy).toEqual(['deal.cardsAfterBlinds', 'deal.cardGap', 'deal.cardsRoom', 'deal.cardFlight']);
    expect(beat('cardTurn').setBy).toEqual(['deal.turnAfterLanding', 'deal.turn']);
    expect(beat('cardsReturn').setBy).toEqual(['deal.returnRoom', 'deal.returnFlight']);
  });

  it('lists only timings that exist, and every deal timing sets some beat or its spacing', () => {
    const listed = new Set(dealBeatDescription.flatMap(b => b.setBy));
    for (const path of listed) expect(path.startsWith('deal.')).toBe(true);
    expect([...Object.keys(committedTimings.deal)].map(k => `deal.${k}`).filter(p => !listed.has(p as never))).toEqual(['deal.returnStagger']);
  });
});

describe('the beat evaluator', () => {
  const defs: readonly BeatDef[] = [
    { beat: 'a', each: 'once', follows: { to: 'phase' }, gap: [], length: [{ timing: 'deal.buttonMoves' }] },
    { beat: 'b', each: 'items', follows: { to: 'end', of: 'a', instance: 'last' }, gap: [{ timing: 'deal.blindStagger', times: 'index' }, { timing: 'deal.blindsAfterRefill' }], length: [{ timing: 'deal.blindFlight', times: 2 }] },
  ];

  it('places each beat from its anchor, gap and length', () => {
    const { a, b } = evaluateBeats(defs, { items: 3 }, committedTimings);
    expect(a).toEqual([{ startsAt: 0, endsAt: 780 }]);
    expect(b).toEqual([{ startsAt: 810, endsAt: 1710 }, { startsAt: 930, endsAt: 1830 }, { startsAt: 1050, endsAt: 1950 }]);
  });

  it('anchors a beat that follows a group with no beats at the start of the phase', () => {
    const none: readonly BeatDef[] = [{ beat: 'x', each: 'nothing', follows: { to: 'phase' }, gap: [], length: [] }, { ...defs[1]!, follows: { to: 'end', of: 'x', instance: 'last' } }];
    expect(evaluateBeats(none, { items: 1 }, committedTimings).b).toEqual([{ startsAt: 30, endsAt: 930 }]);
  });
});

describe('the deal’s beats, rebuilt on anchors', () => {
  it('keep every beat ordered after what it follows, and none ends after the total', () => {
    for (const inputs of [deal(2), deal(9), deal(6, [{ participantId: 'p3', amount: 1000 }])]) {
      const b = dealBeats(inputs);
      expect(b.blinds[0]!.startsAt).toBeGreaterThanOrEqual(b.refills.length ? b.refills[0]!.endsAt : 0);
      expect(b.cards[0]!.startsAt).toBeGreaterThan(b.blinds[0]!.startsAt);
      for (const c of b.cards) expect(c.turn.startsAt).toBeGreaterThan(c.endsAt);
      expect(Math.max(...b.cards.map(c => c.turn.endsAt))).toBeLessThanOrEqual(b.totalMs);
    }
  });
});
