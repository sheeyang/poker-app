import { describe, expect, it } from 'vitest';
import { committedTimings, dealBeats, payoutBeats, settleAfter, showdownBeats, streetBeats, type PresentationPhase } from '@poker/contracts';
import { planMotion, sceneOf } from '../src/table-motion.js';
import { presentTable } from '../src/presentation.js';
import { motionLab } from '../src/motion-lab-model.js';

const phasesOf = (lab: ReturnType<typeof motionLab>) => lab.views.at(-1)!.table.schedule.phases;

describe('the heads-up scenario', () => {
  it('scripts the deal, Settles, streets, showdown and payout in order', () => {
    const lab = motionLab({ scenario: 'heads-up', mode: 'practice' });
    expect(phasesOf(lab).map(p => p.kind === 'street' ? p.street : p.kind)).toEqual(['deal', 'settle', 'flop', 'settle', 'turn', 'settle', 'river', 'settle', 'showdown', 'settle', 'payout', 'settle']);
    expect(lab.blocks.map(b => b.label)).toEqual(['Deal', 'Settle', 'Flop', 'Settle', 'Turn', 'Settle', 'River', 'Settle', 'Showdown', 'Settle', 'Payout', 'Settle']);
  });
  it('gives each phase the length of its beats, and each Settle its configured length', () => {
    const phases = phasesOf(motionLab({ scenario: 'heads-up', mode: 'practice' }));
    const deal = phases[0] as Extract<PresentationPhase, { kind: 'deal' }>;
    expect(deal.durationMs).toBe(dealBeats(deal.inputs).totalMs);
    expect(phases[1]!.durationMs).toBe(committedTimings.settle.deal);
    const flop = phases[2] as Extract<PresentationPhase, { kind: 'street' }>;
    expect(flop.durationMs).toBe(streetBeats(flop.inputs).totalMs);
    const showdown = phases.find(p => p.kind === 'showdown') as Extract<PresentationPhase, { kind: 'showdown' }>;
    expect(showdown.durationMs).toBe(showdownBeats(showdown.inputs).totalMs);
    const payout = phases.find(p => p.kind === 'payout') as Extract<PresentationPhase, { kind: 'payout' }>;
    expect(payout.durationMs).toBe(payoutBeats(payout.inputs).totalMs);
    expect(phases.at(-1)!.durationMs).toBe(settleAfter('payout', 'practice'));
  });
});

describe('table mode', () => {
  it('gives an Online Table the payout Settle for online play and a Next-Hand Countdown after the Hand', () => {
    const online = motionLab({ scenario: 'heads-up', mode: 'online' }), practice = motionLab({ scenario: 'heads-up', mode: 'practice' });
    const payoutSettle = (lab: ReturnType<typeof motionLab>) => lab.blocks.filter(b => b.label === 'Settle').at(-1)!;
    expect(payoutSettle(online).endsAt - payoutSettle(online).startsAt).toBe(committedTimings.settle.payout.online);
    expect(payoutSettle(practice).endsAt - payoutSettle(practice).startsAt).toBe(committedTimings.settle.payout.practice);
    const countdown = online.blocks.at(-1)!;
    expect(countdown).toMatchObject({ kind: 'countdown', startsAt: payoutSettle(online).endsAt, endsAt: payoutSettle(online).endsAt + committedTimings.nextHandCountdownMs });
    expect(online.totalMs).toBe(countdown.endsAt);
    expect(practice.blocks.some(b => b.kind === 'countdown')).toBe(false);
    expect(practice.totalMs).toBe(payoutSettle(practice).endsAt);
  });
});

describe('the script played on a table', () => {
  it('plays the deal, the streets, the showdown and the payout, in order, as a Trainer replaying the views would', () => {
    const lab = motionLab({ scenario: 'heads-up', mode: 'practice' });
    let scene: ReturnType<typeof sceneOf> | undefined;
    const kinds: string[] = [];
    for (const at of lab.breakpoints) {
      const shown = presentTable(lab.viewAt(at), at);
      kinds.push(...planMotion(scene, shown).map(c => c.kind));
      scene = sceneOf(shown);
    }
    expect(kinds.filter(k => ['deal', 'board', 'showdown', 'payout'].includes(k))).toEqual(['deal', 'board', 'board', 'board', 'showdown', 'payout']);
    expect(kinds).toContain('bet');
    expect(kinds).toContain('check');
  });
  it('commits only the phases scheduled so far, as the server does', () => {
    const lab = motionLab({ scenario: 'heads-up', mode: 'practice' });
    expect(lab.views[1]!.table.schedule.phases.map(p => p.kind)).toEqual(['deal', 'settle']);
  });
  it('changes what the table holds at each commit, and nothing between', () => {
    const lab = motionLab({ scenario: 'heads-up', mode: 'practice' });
    expect(lab.viewAt(0).view.state.handId).toBeUndefined();
    const dealAt = lab.views[1]!.at;
    expect(lab.viewAt(dealAt).view.state.handId).toBe('hand-1');
    expect(lab.viewAt(dealAt + 1)).toBe(lab.viewAt(dealAt));
    expect(lab.viewAt(lab.totalMs).view.state.status).toBe('completed-hand');
  });
  it('plays the timings it is given', () => {
    const slower = { ...committedTimings, deal: { ...committedTimings.deal, cardFlight: committedTimings.deal.cardFlight + 1000 } };
    const base = motionLab({ scenario: 'heads-up', mode: 'practice' }), changed = motionLab({ scenario: 'heads-up', mode: 'practice', timings: slower });
    expect(changed.blocks[0]!.endsAt - changed.blocks[0]!.startsAt).toBe(base.blocks[0]!.endsAt - base.blocks[0]!.startsAt + 1000);
    expect(changed.totalMs).toBe(base.totalMs + 1000);
  });
});

describe('the beats on each lane', () => {
  const lab = motionLab({ scenario: 'heads-up', mode: 'practice' });
  const phases = phasesOf(lab);
  const span = (start: number, beat: { startsAt: number; endsAt: number }) => ({ startsAt: start + beat.startsAt, endsAt: start + beat.endsAt });
  const on = (lane: string) => lab.beats.filter(b => b.lane === lane).map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
  const deal = phases[0] as Extract<PresentationPhase, { kind: 'deal' }>;
  it('draws the deal’s cards, blinds and button as the deal beats give them', () => {
    const beats = dealBeats(deal.inputs, deal.durationMs);
    expect(on('cards')).toEqual(expect.arrayContaining([...beats.cards.map(c => span(deal.startsAt, c)), ...beats.cards.filter(c => c.participantId === 'you').map(c => span(deal.startsAt, c.turn))]));
    expect(on('chips')).toEqual(expect.arrayContaining(beats.blinds.map(b => span(deal.startsAt, b))));
    expect(on('seats')).toContainEqual(span(deal.startsAt, beats.buttonMoves));
  });
  it('draws a street’s sweep on chips and its burn and board cards on the board', () => {
    const flop = phases[2] as Extract<PresentationPhase, { kind: 'street' }>, beats = streetBeats(flop.inputs, flop.durationMs);
    expect(on('chips')).toEqual(expect.arrayContaining(beats.sweep.wagers.map(w => span(flop.startsAt, w))));
    expect(on('board')).toEqual(expect.arrayContaining([span(flop.startsAt, beats.burn), ...beats.cards.map(c => span(flop.startsAt, c)), ...beats.cards.map(c => span(flop.startsAt, c.turn))]));
  });
  it('draws the showdown’s turns on cards and the payout’s awards on stacks', () => {
    const showdown = phases.find(p => p.kind === 'showdown') as Extract<PresentationPhase, { kind: 'showdown' }>, payout = phases.find(p => p.kind === 'payout') as Extract<PresentationPhase, { kind: 'payout' }>;
    expect(on('cards')).toEqual(expect.arrayContaining(showdownBeats(showdown.inputs, showdown.durationMs).hands.flatMap(h => h.cards.map(c => span(showdown.startsAt, c.turn)))));
    expect(on('stacks')).toEqual(expect.arrayContaining(payoutBeats(payout.inputs, payout.durationMs).awards.map(a => span(payout.startsAt, a))));
  });
  it('draws no beat past the end of the script, and each from its start to its end', () => {
    for (const beat of lab.beats) { expect(beat.endsAt).toBeGreaterThanOrEqual(beat.startsAt); expect(beat.endsAt).toBeLessThanOrEqual(lab.totalMs); }
  });
  it('draws the bets and checks between phases, from the moment each action is committed', () => {
    const flopBet = lab.views.find(v => v.table.view.history[0]?.decisions.at(-1)?.action.action.type === 'bet')!;
    expect(on('chips')).toContainEqual({ startsAt: flopBet.at, endsAt: flopBet.at + committedTimings.motion.betFlight });
    expect(on('seats')).toContainEqual({ startsAt: expect.any(Number), endsAt: expect.any(Number) });
  });
});
