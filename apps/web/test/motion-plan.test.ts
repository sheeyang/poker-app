import { describe, expect, it } from 'vitest';
import { committedTimings, dealBeats, type Timings } from '@poker/contracts';
import { withBeats } from '../src/motion-plan.js';
import type { Cue } from '../src/table-motion.js';

const M = committedTimings.motion;
const slower: Timings = { ...committedTimings, motion: { ...M, betFlight: 900, muckStagger: 100, sitArrivesAt: 400 } };

describe('motion with no Presentation Phase', () => {
  it('is played from its anchored beats, which start at the server time of the view that carried it', () => {
    const cue: Cue = { kind: 'bet', participantId: 'ada', toPot: false, at: 12_000 };
    const played = withBeats(cue);
    expect(played).toMatchObject({ kind: 'bet', participantId: 'ada', at: 12_000, beats: { chip: { startsAt: 0, endsAt: M.betFlight }, amountAppears: M.betAmountAppears } });
  });

  it('keeps every cue’s own fields', () => {
    expect(withBeats({ kind: 'move', fromSeat: 2, seat: 3, at: 5 })).toMatchObject({ kind: 'move', fromSeat: 2, seat: 3, at: 5 });
    expect(withBeats({ kind: 'chips', participantId: 'ada', amount: 2000, from: 1000, at: 5 })).toMatchObject({ amount: 2000, from: 1000, beats: { flight: { endsAt: M.chipsFlight } } });
  });

  it('mucks an opponent’s cards, one after another, and none of the viewer’s own', () => {
    const fold = (muck: boolean): Cue => ({ kind: 'fold', participantId: 'cy', muck, cards: 2, at: 1 });
    const mucks = (cue: Cue) => (withBeats(cue) as Extract<ReturnType<typeof withBeats>, { kind: 'fold' }>).beats.mucks;
    expect(mucks(fold(true)).map(m => m.startsAt)).toEqual([0, M.muckStagger]);
    expect(mucks(fold(false))).toEqual([]);
  });

  it('plays at the timings given, defaulting to the committed ones', () => {
    expect(withBeats({ kind: 'bet', participantId: 'a', toPot: true, at: 1 }).kind).toBe('bet');
    expect(withBeats({ kind: 'bet', participantId: 'a', toPot: false, at: 1 }, slower)).toMatchObject({ beats: { chip: { endsAt: 900 } } });
    expect(withBeats({ kind: 'sit', seat: 2, at: 1 }, slower)).toMatchObject({ beats: { arrives: { startsAt: 400 } } });
  });

  it('leaves a cue a Presentation Phase presents, and the sweep, as it is', () => {
    const deal: Cue = { kind: 'deal', at: 1, beats: dealBeats({ dealt: [], blinds: [], refills: [] }), viewerId: 'you', fromButton: null };
    const sweep: Cue = { kind: 'sweep', participantIds: ['ada'], at: 1 };
    expect(withBeats(deal)).toBe(deal);
    expect(withBeats(sweep)).toBe(sweep);
  });

  it('never adds a length to a phase: its beats carry no total', () => {
    for (const cue of [{ kind: 'check', participantId: 'a', at: 1 }, { kind: 'status', participantId: 'a', at: 1 }, { kind: 'turn', seat: 2, at: 1 }] as Cue[]) expect(withBeats(cue)).not.toHaveProperty('beats.totalMs');
  });
});
