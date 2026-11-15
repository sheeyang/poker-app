import { describe, expect, it } from 'vitest';
import { betBeats, checkBeats, foldBeats, sweepBeats, committedTimings, dealBeats, payoutBeats, settleAfter, showdownBeats, streetBeats, type PresentationPhase } from '@poker/contracts';
import { planMotion, sceneOf } from '../src/table-motion.js';
import { presentTable } from '../src/presentation.js';
import { motionLab, scenarios } from '../src/motion-lab-model.js';

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

type Lab = ReturnType<typeof motionLab>;
const kindsOf = (lab: Lab) => phasesOf(lab).map(p => p.kind === 'street' ? p.street : p.kind);
const phaseOf = <K extends PresentationPhase['kind']>(lab: Lab, kind: K) => phasesOf(lab).find(p => p.kind === kind) as Extract<PresentationPhase, { kind: K }> | undefined;
const presets = ['heads-up', '6-handed', '9-handed', 'folds', 'runout', 'split', 'rebuy'] as const;
const eachSettled = (...kinds: string[]) => kinds.flatMap(k => [k, 'settle']);
const spanOf = (b: { startsAt: number; endsAt: number }) => ({ startsAt: b.startsAt, endsAt: b.endsAt });

describe('the presets', () => {
  it('has every preset, each with a label', () => {
    expect(scenarios.map(s => s.id)).toEqual([...presets]);
    for (const s of scenarios) expect(s.label).not.toBe('');
  });
  it('deals 6-handed and 9-handed Hands to every seat, with a Settle after each phase', () => {
    for (const [id, seats] of [['6-handed', 6], ['9-handed', 9]] as const) {
      const lab = motionLab({ scenario: id, mode: 'practice' });
      expect(phaseOf(lab, 'deal')!.inputs.dealt).toHaveLength(seats);
      expect(phaseOf(lab, 'deal')!.inputs.blinds).toHaveLength(2);
      expect(kindsOf(lab)).toEqual(eachSettled('deal', 'flop', 'turn', 'river', 'showdown', 'payout'));
      expect(lab.views.at(-1)!.table.view.configuration.seatCount).toBe(seats);
    }
  });
  it('wins a Hand by folds with no showdown, and no street it never reached', () => {
    const lab = motionLab({ scenario: 'folds', mode: 'practice' });
    expect(kindsOf(lab)).toEqual(eachSettled('deal', 'flop', 'turn', 'payout'));
    expect(lab.blocks.some(b => b.label === 'Showdown')).toBe(false);
    expect(lab.views.at(-1)!.table.view.state.status).toBe('completed-hand');
  });
  it('plays an all-in runout as the showdown, each remaining street and the payout, each with its Settle', () => {
    const lab = motionLab({ scenario: 'runout', mode: 'practice' });
    expect(kindsOf(lab)).toEqual(eachSettled('deal', 'showdown', 'flop', 'turn', 'river', 'payout'));
    expect(phasesOf(lab).flatMap(p => p.kind === 'street' ? [p.inputs.swept] : [])).toEqual([[], [], []]);
    expect(phaseOf(lab, 'showdown')!.inputs.swept).toHaveLength(2);
  });
  it('pays a split pot to several stacks, in turn', () => {
    const lab = motionLab({ scenario: 'split', mode: 'practice' });
    expect(phaseOf(lab, 'payout')!.inputs.awards).toHaveLength(2);
    const stacks = lab.beats.filter(b => b.lane === 'stacks' && b.label.endsWith('award'));
    expect(stacks).toHaveLength(2);
    expect(stacks[1]!.startsAt).toBeGreaterThan(stacks[0]!.startsAt);
  });
  it('includes the refill in the deal of Rebuy & deal, landing before the blinds', () => {
    const lab = motionLab({ scenario: 'rebuy', mode: 'practice' });
    const deal = phaseOf(lab, 'deal')!, beats = dealBeats(deal.inputs);
    expect(deal.inputs.refills).toHaveLength(1);
    expect(deal.durationMs).toBe(beats.totalMs);
    expect(beats.refills[0]!.endsAt).toBeLessThanOrEqual(beats.blinds[0]!.startsAt + 1);
    expect(lab.beats.some(b => b.lane === 'stacks' && b.label.endsWith('refill'))).toBe(true);
    expect(lab.views[0]!.table.view.state.participants.some(p => p.stack === 0)).toBe(true);
  });
  it('ends every Online scenario with the 3 s payout Settle and the Next-Hand Countdown', () => {
    for (const id of presets) {
      const lab = motionLab({ scenario: id, mode: 'online' });
      const [settle, countdown] = lab.blocks.slice(-2);
      expect(settle).toMatchObject({ kind: 'settle' });
      expect(settle!.endsAt - settle!.startsAt).toBe(3000);
      expect(countdown).toMatchObject({ kind: 'countdown', startsAt: settle!.endsAt });
      expect(lab.totalMs).toBe(countdown!.endsAt);
      expect(motionLab({ scenario: id, mode: 'practice' }).blocks.some(b => b.kind === 'countdown')).toBe(false);
    }
  });
});

describe('the time before each action', () => {
  it('spaces each scripted action from the moment its window opened', () => {
    for (const id of presets) for (const actionGapMs of [0, 250, 1000]) {
      const lab = motionLab({ scenario: id, mode: 'practice', actionGapMs });
      let opensAt = lab.views[1]!.table.schedule.actionWindow!.opensAt;
      for (const v of lab.views.slice(2)) {
        if (!v.table.view.history[0] || v.table.view.history[0].decisions.length === 0 || v.at < opensAt) continue;
        expect(v.at).toBe(opensAt + actionGapMs);
        opensAt = v.table.schedule.actionWindow?.opensAt ?? opensAt;
      }
    }
  });
  it('is 600 ms unless given, and longer gaps make a longer script', () => {
    const base = motionLab({ scenario: '6-handed', mode: 'practice' });
    expect(motionLab({ scenario: '6-handed', mode: 'practice', actionGapMs: 600 }).totalMs).toBe(base.totalMs);
    expect(motionLab({ scenario: '6-handed', mode: 'practice', actionGapMs: 700 }).totalMs).toBeGreaterThan(base.totalMs);
  });
});

describe('motion with no Presentation Phase', () => {
  const lab = motionLab({ scenario: 'folds', mode: 'practice' });
  const decisionViews = lab.views.filter(v => v.table.view.history[0]?.decisions.length);
  const last = (v: { table: Lab['views'][number]['table'] }) => v.table.view.history[0]!.decisions.at(-1)!.action;
  const placed = (at: number, beat: { startsAt: number; endsAt: number }) => ({ startsAt: at + beat.startsAt, endsAt: at + beat.endsAt });
  const on = (l: Lab, lane: string) => l.beats.filter(b => b.lane === lane).map(spanOf);
  it('draws a bet from its anchored beats, between the phases', () => {
    const view = decisionViews.find(v => last(v).action.type === 'raise')!, beats = betBeats(false);
    expect(on(lab, 'chips')).toContainEqual(placed(view.at, beats.chip));
    expect(on(lab, 'seats')).toContainEqual(placed(view.at, beats.caption));
  });
  it('draws the mucked cards of a fold and the press of a check from their beats', () => {
    const fold = decisionViews.find(v => last(v).action.type === 'fold' && last(v).participantId !== 'you')!;
    expect(on(lab, 'cards')).toEqual(expect.arrayContaining(foldBeats(2).mucks.map(m => placed(fold.at, m))));
    const check = decisionViews.find(v => last(v).action.type === 'check')!;
    expect(on(lab, 'seats')).toContainEqual(placed(check.at, checkBeats().press));
  });
  it('plays the timings it is given', () => {
    const slow = { ...committedTimings, motion: { ...committedTimings.motion, muckFlight: committedTimings.motion.muckFlight + 500 } };
    const changed = motionLab({ scenario: 'folds', mode: 'practice', timings: slow });
    const longest = (l: Lab) => Math.max(...l.beats.filter(b => b.label.includes('muck')).map(b => b.endsAt - b.startsAt));
    expect(longest(changed)).toBe(longest(lab) + 500);
  });
  it('draws the sweep of a Hand won by folds, which no phase presents', () => {
    const view = lab.views.at(-1)!;
    expect(on(lab, 'chips')).toContainEqual(placed(view.at, sweepBeats(['you']).wagers[0]!));
  });
  it('is played by the table as a Trainer replaying the views would plan it', () => {
    const kinds: string[] = [];
    let scene: ReturnType<typeof sceneOf> | undefined;
    for (const at of lab.breakpoints) { const shown = presentTable(lab.viewAt(at), at); kinds.push(...planMotion(scene, shown).map(c => c.kind)); scene = sceneOf(shown); }
    expect(kinds).toEqual(expect.arrayContaining(['deal', 'fold', 'bet', 'check', 'sweep', 'payout']));
    expect(kinds).not.toContain('showdown');
  });
  it('stops a replay at each award landing of a split pot', () => {
    const split = motionLab({ scenario: 'split', mode: 'practice' }), payout = phaseOf(split, 'payout')!;
    for (const a of payoutBeats(payout.inputs, payout.durationMs).awards) expect(split.breakpoints).toContain(payout.startsAt + a.endsAt);
  });
});
