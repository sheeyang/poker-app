import { baselinePlayingStrategy, betBeats, checkBeats, committedTimings, dealBeats, dealingOrder, defaultConfiguration, defaultTrainerConfiguration, foldBeats, payoutBeats, settleAfter, showdownBeats, streetBeats, sweepBeats, type ChipAmount, type ConcreteAction, type DealInputs, type ObservableParticipant, type ObservableTableSession, type PayoutInputs, type PresentationPhase, type PresentingPhaseKind, type ShowdownInputs, type SweepBeats, type Street, type StreetInputs, type TableMode, type Timings } from '@poker/contracts';
import { scenarioDefs, type ScenarioId, type Step } from './motion-lab-scenarios.js';

/**
 * The motion lab's model (ADR-0040): pure. From timings and a scenario it gives everything the motion lab draws: the
 * scripted committed views a table would have received, the phase blocks, and the beats on each lane. The page plays
 * the views on a virtual clock; nothing here reads a clock or touches a server.
 */

export type { ScenarioId } from './motion-lab-scenarios.js';
export const scenarios: readonly { readonly id: ScenarioId; readonly label: string }[] = scenarioDefs.map(({ id, label }) => ({ id, label }));

/** What moves: the lane each beat is drawn on. */
export type Lane = 'cards' | 'chips' | 'board' | 'stacks' | 'seats';
export const lanes: readonly { readonly id: Lane; readonly label: string }[] = [
  { id: 'cards', label: 'Cards' }, { id: 'chips', label: 'Chips' }, { id: 'board', label: 'Board' }, { id: 'stacks', label: 'Stacks' }, { id: 'seats', label: 'Seats' },
];

export interface LabInput {
  /** The timings played; the committed ones unless given. */
  readonly timings?: Timings;
  readonly scenario: ScenarioId;
  readonly mode: TableMode;
  /** The time before each scripted action, once its window has opened; 600 ms unless given. */
  readonly actionGapMs?: number;
}

/** A committed view the table receives at `at`, as the server would send it. */
export interface LabView { readonly at: number; readonly table: ObservableTableSession }

/** A phase, a Settle or the Next-Hand Countdown, drawn as one block of the timeline's band. */
export interface LabBlock { readonly kind: PresentationPhase['kind'] | 'countdown'; readonly label: string; readonly startsAt: number; readonly endsAt: number }

/** Which description a beat comes from: a presenting phase's, or the kind of motion with no Presentation Phase. */
export type BeatSource = 'deal' | 'street' | 'showdown' | 'payout' | 'sweep' | 'bet' | 'fold' | 'check';
/** The description group and place that made a beat: the `index`th of the group's beats in its `scope` (one phase, or one table event), which starts at `scopeStart`. */
export interface BeatRef { readonly source: BeatSource; readonly group: string; readonly index: number; readonly scope: string; readonly scopeStart: number }

/** One beat as a bar on a lane, in milliseconds from the start of the script. `id` is its place among the lab's beats, in time order. */
export interface LabBeat { readonly id: number; readonly lane: Lane; readonly label: string; readonly startsAt: number; readonly endsAt: number; readonly ref: BeatRef }

/** A beat before it has a place in time order, so no id yet. */
type Bar = Omit<LabBeat, 'id'>;

/** A bar on `lane`, from `beat`'s offsets in `scope` (one phase, or one table event), which starts at `scope.at`. */
const barOf = (lane: Lane, label: string, source: BeatSource, group: string, index: number, scope: { id: string; at: number }, beat: { startsAt: number; endsAt: number }): Bar =>
  ({ lane, label, startsAt: scope.at + beat.startsAt, endsAt: scope.at + beat.endsAt, ref: { source, group, index, scope: scope.id, scopeStart: scope.at } });

export interface MotionLab {
  readonly views: readonly LabView[];
  readonly blocks: readonly LabBlock[];
  readonly beats: readonly LabBeat[];
  /** When the script ends: the Hand's last phase, or the Next-Hand Countdown after it. */
  readonly totalMs: number;
  /** Every instant at which what the table presents can change, ascending: where a replay must stop to see each change. */
  readonly breakpoints: readonly number[];
  /** The committed view the table holds at `time`. */
  readonly viewAt: (time: number) => ObservableTableSession;
}

const YOU = 'you', HAND = 'hand-1', DEFAULT_GAP = 600, BUY_IN = 1000;
const STREET_LABEL: Record<Street, string> = { preflop: 'Deal', flop: 'Flop', turn: 'Turn', river: 'River' };
const PHASE_LABEL: Record<PresentationPhase['kind'], string> = { deal: 'Deal', street: 'Street', showdown: 'Showdown', payout: 'Payout', settle: 'Settle' };
const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
const BOT_NAMES = ['', '', 'Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fay', 'Gus', 'Hal'];
const HOLES: Record<number, readonly [string, string]> = { 1: ['As', 'Kd'], 2: ['Qh', 'Jc'], 3: ['5s', '5d'], 4: ['6h', '6c'], 5: ['4s', '4d'], 6: ['8s', '8h'], 7: ['9s', '9d'], 8: ['Qd', 'Qc'], 9: ['Jh', 'Jd'] };
const SPLIT_HOLES: Record<number, readonly [string, string]> = { 2: ['Ah', 'Kc'] };

const idOf = (seat: number) => (seat === 1 ? YOU : `bot-${seat}`);
const seatOf = (id: string) => (id === YOU ? 1 : Number(id.slice(4)));
const nameOf = (id: string) => (id === YOU ? 'You' : BOT_NAMES[seatOf(id)]!);

interface Seat { stack: ChipAmount; wager: ChipAmount; contribution: ChipAmount; folded: boolean; allIn: boolean }
/** What the table presented as motion with no Presentation Phase: an action, or the sweep of a Hand won by folds. */
type Motion = { readonly at: number; readonly kind: 'fold' | 'check' | 'call' | 'bet' | 'raise'; readonly who: string; readonly toPot: boolean } | { readonly at: number; readonly kind: 'sweep'; readonly swept: readonly string[] };

export function motionLab(input: LabInput): MotionLab {
  const timings = input.timings ?? committedTimings, mode = input.mode, gap = input.actionGapMs ?? DEFAULT_GAP;
  const sc = scenarioDefs.find(s => s.id === input.scenario)!;
  const ids = Array.from({ length: sc.seats }, (_, i) => idOf(i + 1)), buttonSeat = sc.seats === 2 ? 1 : sc.seats;
  const views: LabView[] = [], blocks: LabBlock[] = [], bars: Bar[] = [], motion: Motion[] = [];
  const stakes = { small: defaultConfiguration.smallBlind, big: defaultConfiguration.bigBlind };
  const seats: Record<string, Seat> = Object.fromEntries(ids.map(id => [id, { stack: id === idOf(sc.refill ?? 0) ? 0 : BUY_IN, wager: 0, contribution: 0, folded: false, allIn: false }]));
  const phases: PresentationPhase[] = [];
  let board = 0, street: Street = 'preflop', cursor = 0, windowOpensAt = 0;
  const decisions: { decisionId: string; action: { participantId: string; action: ConcreteAction } }[] = [];
  let result: { payouts: { participantId: string; amount: number }[]; shown: boolean } | undefined;
  const holes = (id: string) => (input.scenario === 'split' ? SPLIT_HOLES[seatOf(id)] : undefined) ?? HOLES[seatOf(id)]!;

  const table = (at: number, actor: string | null, opensAt: number | null, extra: { countdown?: { startsAt: number; endsAt: number } } = {}): ObservableTableSession => {
    const complete = !!result, started = phases.length > 0;
    const participants: ObservableParticipant[] = ids.map(id => {
      const s = seats[id]!;
      return {
        participantId: id, seat: seatOf(id), sittingOut: false, stack: complete ? s.stack + (result!.payouts.find(p => p.participantId === id)?.amount ?? 0) : s.stack,
        ...(started ? { inHand: true, folded: s.folded, allIn: s.allIn, contribution: s.contribution, wager: s.wager, cardCount: 2, ...(id === YOU || (complete && result!.shown && !s.folded) ? { holeCards: [...holes(id)] } : {}) } : {}),
      };
    });
    const total = Object.values(seats).reduce((sum, s) => sum + s.contribution, 0);
    const online = mode === 'online';
    return {
      tableSessionId: 'motion-lab', mode, options: { actionTimeLimitSeconds: online ? 30 : null, allowLiveAnalysis: true }, viewerParticipantId: YOU, ownerParticipantId: YOU,
      pokerRevision: views.length + 1, sessionRevision: views.length + 1, serverTime: at, pendingChanges: [], trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
      ...(online ? { connectedParticipantIds: [YOU] } : {}),
      bindings: ids.map(id => ({ participantId: id, name: id === YOU ? 'You' : `Bot ${nameOf(id)}`, controller: id === YOU ? { kind: 'human' as const } : { kind: 'bot' as const, playingStrategy: baselinePlayingStrategy } })),
      schedule: { phases: [...phases], actionWindow: actor && opensAt !== null ? { participantId: actor, decisionId: `d${decisions.length}`, opensAt, ...(online && actor === YOU ? { deadlineAt: opensAt + 30_000 } : {}) } : null, ...(extra.countdown ? { nextHandCountdown: { ...extra.countdown, durationMs: extra.countdown.endsAt - extra.countdown.startsAt } } : {}) },
      view: {
        configuration: { ...defaultConfiguration, seatCount: sc.seats },
        history: started ? [{ handId: HAND, description: '', decisions: decisions.map(d => ({ ...d, state: {} as never })) }] : [],
        state: started ? {
          status: complete ? 'completed-hand' : 'active-hand', buttonSeat, handId: HAND, street, board: sc.board.slice(0, board), pots: complete ? [{ amount: total, eligibleParticipantIds: ids.filter(id => !seats[id]!.folded) }] : [],
          actorId: complete ? null : actor, decisionId: complete ? null : `d${decisions.length}`, legalActions: [], smallBlindParticipantId: idOf(1), bigBlindParticipantId: idOf(2), participants,
          ...(complete ? { payouts: result!.payouts, returns: [] } : {}),
        } : { status: 'between-hands', buttonSeat, board: [], pots: [], actorId: null, legalActions: [], participants: participants.map(({ participantId, seat, sittingOut, stack }) => ({ participantId, seat, sittingOut, stack })) },
      },
    };
  };

  /** Adds a phase starting at the cursor, and its Settle. */
  const add = <K extends PresentingPhaseKind>(kind: K, st: Street, inputs: K extends 'deal' ? DealInputs : K extends 'street' ? StreetInputs : K extends 'showdown' ? ShowdownInputs : PayoutInputs) => {
    const durationMs = ({ deal: dealBeats, street: streetBeats, showdown: showdownBeats, payout: payoutBeats } as Record<string, (i: never, d: undefined, t: Timings) => { totalMs: number }>)[kind]!(inputs as never, undefined, timings).totalMs;
    phases.push({ kind, handId: HAND, street: st, startsAt: cursor, endsAt: cursor + durationMs, durationMs, inputs } as PresentationPhase);
    cursor += durationMs;
    const settle = settleAfter(kind, mode, timings.settle);
    if (settle > 0) { phases.push({ kind: 'settle', handId: HAND, street: st, startsAt: cursor, endsAt: cursor + settle, durationMs: settle }); cursor += settle; }
  };
  const onLine = () => ids.filter(id => seats[id]!.wager > 0);
  const live = () => ids.filter(id => !seats[id]!.folded);
  /** The Hand is over: the pot goes to `winners`, split evenly, and the payout is presented. */
  const finish = (at: number, winners: readonly string[], shown: boolean) => {
    const pot = Object.values(seats).reduce((sum, s) => sum + s.contribution, 0), each = Math.floor(pot / winners.length);
    const awards = winners.map((participantId, i) => ({ participantId, won: each + (i === 0 ? pot - each * winners.length : 0), returned: 0 }));
    result = { payouts: awards.map(a => ({ participantId: a.participantId, amount: a.won })), shown };
    add('payout', street,{ awards });
    views.push({ at, table: table(at, null, null) });
  };

  // Before the Hand: the table waits (a refilled seat empty), then deals.
  views.push({ at: 0, table: table(0, null, null) });
  const flat = sc.streets.flatMap((steps, street) => steps.map((step, i) => ({ step, street, closes: i === steps.length - 1 })));
  const first = (step: Step) => idOf(step.seat);
  const blinds = [idOf(1), idOf(2)];
  seats[idOf(1)]!.stack = BUY_IN - stakes.small; seats[idOf(2)]!.stack = BUY_IN - stakes.big;
  seats[idOf(1)]!.wager = seats[idOf(1)]!.contribution = stakes.small; seats[idOf(2)]!.wager = seats[idOf(2)]!.contribution = stakes.big;
  cursor = gap;
  add('deal', 'preflop', {
    dealt: dealingOrder(ids.map(id => ({ participantId: id, seat: seatOf(id) })), buttonSeat).map(({ participantId }) => ({ participantId, cardCount: 2 })),
    blinds, refills: sc.refill ? [{ participantId: idOf(sc.refill), amount: BUY_IN }] : [],
  });
  windowOpensAt = cursor;
  views.push({ at: phases[0]!.startsAt, table: table(phases[0]!.startsAt, first(flat[0]!.step), windowOpensAt) });

  for (const [n, { step, closes }] of flat.entries()) {
    const at = windowOpensAt + gap, id = idOf(step.seat), me = seats[id]!, upNext = flat[n + 1];
    const top = Math.max(...ids.map(i => seats[i]!.wager));
    let action: ConcreteAction, to = me.wager;
    if (step.move === 'fold' || step.move === 'check') action = { type: step.move };
    else if (step.move === 'call') { action = { type: 'call' }; to = me.wager + Math.min(top - me.wager, me.stack); }
    else { to = step.move; action = top > 0 ? { type: 'raise', raiseTo: to } : { type: 'bet', betTo: to }; }
    me.stack -= to - me.wager; me.contribution += to - me.wager; me.wager = to;
    if (action.type === 'fold') me.folded = true;
    if (me.stack === 0 && action.type !== 'fold' && action.type !== 'check') me.allIn = true;
    decisions.push({ decisionId: `d${decisions.length}`, action: { participantId: id, action } });
    cursor = at;
    const remaining = live();
    if (remaining.length === 1) {
      // Won by folds: the line is swept with no street reveal, and the pot is paid at once.
      const swept = onLine();
      for (const i of ids) seats[i]!.wager = 0;
      motion.push({ at, kind: 'fold', who: id, toPot: false }, ...(swept.length ? [{ at, kind: 'sweep' as const, swept }] : []));
      finish(at, remaining, false);
      break;
    }
    if (!closes) { motion.push({ at, kind: action.type, who: id, toPot: false }); windowOpensAt = at; views.push({ at, table: table(at, first(upNext!.step), at) }); continue; }
    const runout = remaining.filter(i => seats[i]!.stack > 0).length <= 1;
    if (runout || street === 'river') {
      // Betting is over: the hands are shown, then the pot is paid. The line stays in the view; the showdown sweeps it.
      motion.push({ at, kind: action.type, who: id, toPot: false });
      const swept = onLine(), reached = street;
      if (runout) board = 5, street = 'river';
      add('showdown', reached, { swept, shown: [...remaining.filter(i => i !== YOU), ...remaining.filter(i => i === YOU)].map(participantId => ({ participantId, cardCount: 2 })) });
      if (runout) for (const next of STREETS.slice(STREETS.indexOf(reached) + 1)) add('street', next, { swept: [], cardCount: next === 'flop' ? 3 : 1 });
      finish(at, sc.winners.map(idOf).filter(i => remaining.includes(i)), true);
      break;
    }
    motion.push({ at, kind: action.type, who: id, toPot: action.type !== 'check' });
    const swept = onLine();
    for (const i of ids) seats[i]!.wager = 0;
    street = STREETS[STREETS.indexOf(street) + 1]!;
    board = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
    add('street', street, { swept, cardCount: street === 'flop' ? 3 : 1 });
    windowOpensAt = cursor;
    views.push({ at, table: table(at, first(upNext!.step), windowOpensAt) });
  }

  // Every beat, from its phase's start, as the table plays it: the shared beat functions at the phase's own length. Each
  // bar carries the description group and place that made it (`ref`), so the lab's annotations read the same descriptions.
  const bar = (...args: Parameters<typeof barOf>) => { bars.push(barOf(...args)); };
  const name = nameOf;
  for (const [n, p] of phases.entries()) {
    const scope = { id: `phase-${n}`, at: p.startsAt };
    const sweep = (source: BeatSource, sw: SweepBeats) => { for (const [i, w] of sw.wagers.entries()) bar('chips', `${name(w.participantId)} chips to pot`, source, 'sweepWager', i, scope, w); if (sw.pot) bar('chips', 'Pot brightens', source, 'sweepPot', 0, scope, sw.pot); };
    if (p.kind === 'deal') {
      const b = dealBeats(p.inputs, p.durationMs, timings);
      bar('cards', 'Cards return', 'deal', 'cardsReturn', 0, scope, b.cardsReturn); bar('seats', 'Button moves', 'deal', 'buttonMoves', 0, scope, b.buttonMoves);
      for (const [i, r] of b.refills.entries()) bar('stacks', `${name(r.participantId)} refill`, 'deal', 'refill', i, scope, r);
      for (const [i, blind] of b.blinds.entries()) bar('chips', `${name(blind.participantId)} blind`, 'deal', 'blind', i, scope, blind);
      for (const [i, c] of b.cards.entries()) { bar('cards', `${name(c.participantId)} card ${c.card + 1}`, 'deal', 'card', i, scope, c); if (c.participantId === YOU) bar('cards', `${name(c.participantId)} card ${c.card + 1} turns`, 'deal', 'cardTurn', i, scope, c.turn); }
    } else if (p.kind === 'street') {
      const b = streetBeats(p.inputs, p.durationMs, timings), flop = p.inputs.cardCount > 1;
      sweep('street', b.sweep); bar('board', 'Burn', 'street', 'burn', 0, scope, b.burn);
      for (const c of b.cards) {
        bar('board', `Board card ${c.card + 1}`, 'street', flop ? 'flopCard' : 'boardCard', flop ? c.card : 0, scope, c);
        if (c.spread) bar('board', 'Flop spreads', 'street', 'flopSpread', c.card, scope, c.spread);
        bar('board', `Board card ${c.card + 1} turns`, 'street', flop ? 'flopCardTurn' : 'boardCardTurn', flop ? c.card : 0, scope, c.turn);
      }
    } else if (p.kind === 'showdown') {
      const b = showdownBeats(p.inputs, p.durationMs, timings);
      sweep('showdown', b.sweep);
      let turned = 0;
      for (const h of b.hands) for (const c of h.cards) bar('cards', `${name(h.participantId)} card ${c.card + 1} turns`, 'showdown', 'cardTurn', turned++, scope, c.turn);
    } else if (p.kind === 'payout') {
      const b = payoutBeats(p.inputs, p.durationMs, timings);
      bar('chips', 'Pot pulses', 'payout', 'pot', 0, scope, b.pot);
      for (const [i, a] of b.awards.entries()) { bar('stacks', `${name(a.participantId)} award`, 'payout', 'award', i, scope, a); bar('stacks', `${name(a.participantId)} award fades`, 'payout', 'awardFade', i, scope, a.fade); bar('seats', `${name(a.participantId)} caption`, 'payout', 'awardCaption', i, scope, a.caption); }
    }
  }
  bars.push(...motionBeats(motion, timings));
  const beats: LabBeat[] = bars.sort((x, y) => x.startsAt - y.startsAt || x.endsAt - y.endsAt).map((b, id) => ({ id, ...b }));

  for (const p of phases) blocks.push({ kind: p.kind, label: p.kind === 'street' ? STREET_LABEL[p.street] : PHASE_LABEL[p.kind], startsAt: p.startsAt, endsAt: p.endsAt });
  const handEnd = Math.max(...phases.map(p => p.endsAt));
  let totalMs = handEnd;
  if (mode === 'online') {
    const endsAt = handEnd + timings.nextHandCountdownMs;
    blocks.push({ kind: 'countdown', label: 'Next hand', startsAt: handEnd, endsAt });
    const final = { ...views.at(-1)!.table, serverTime: handEnd, schedule: { ...views.at(-1)!.table.schedule, nextHandCountdown: { startsAt: handEnd, endsAt, durationMs: timings.nextHandCountdownMs } } };
    views.push({ at: handEnd, table: final });
    totalMs = endsAt;
  }

  // A payout holds each winner's old stack figure until their award lands, so each landing changes what the table presents.
  const landings = phases.flatMap(p => p.kind === 'payout' ? payoutBeats(p.inputs, p.durationMs, timings).awards.map(a => p.startsAt + a.endsAt) : []);
  const breakpoints = [...new Set([...views.map(v => v.at), ...blocks.flatMap(b => [b.startsAt, b.endsAt]), ...landings, ...views.flatMap(v => v.table.schedule.actionWindow ? [v.table.schedule.actionWindow.opensAt] : [])])].sort((a, b) => a - b);
  const viewAt = (time: number) => (views.findLast(v => v.at <= time) ?? views[0]!).table;
  return { views, blocks, beats, totalMs, breakpoints, viewAt };
}

/** The beats of motion with no Presentation Phase, from the anchored beat functions, each from the view that carried it. */
function motionBeats(motion: readonly Motion[], timings: Timings): Bar[] {
  const out: Bar[] = [];
  for (const [n, m] of motion.entries()) {
    const scope = `motion-${n}`;
    const bar = (lane: Lane, label: string, source: BeatSource, group: string, index: number, beat: { startsAt: number; endsAt: number }) =>
      out.push(barOf(lane, label, source, group, index, { id: scope, at: m.at }, beat));
    if (m.kind === 'sweep') {
      const sw = sweepBeats(m.swept, timings);
      for (const [i, w] of sw.wagers.entries()) bar('chips', `${nameOf(w.participantId)} chips to pot`, 'sweep', 'sweepWager', i, w);
      if (sw.pot) bar('chips', 'Pot brightens', 'sweep', 'sweepPot', 0, sw.pot);
      continue;
    }
    const who = nameOf(m.who);
    if (m.kind === 'check') { const b = checkBeats(timings); bar('seats', `${who} checks`, 'check', 'press', 0, b.press); bar('seats', `${who} caption`, 'check', 'caption', 0, b.caption); }
    else if (m.kind === 'fold') {
      const b = foldBeats(m.who === YOU ? 0 : 2, timings);
      for (const [i, muck] of b.mucks.entries()) bar('cards', `${who} muck ${i + 1}`, 'fold', 'muck', i, muck);
      bar('seats', `${who} caption`, 'fold', 'caption', 0, b.caption);
    } else {
      const b = betBeats(m.toPot, timings);
      bar('chips', `${who} ${m.kind === 'call' ? 'calls' : m.kind === 'bet' ? 'bets' : 'raises'}`, 'bet', m.toPot ? 'potChip' : 'lineChip', 0, b.chip);
      if (b.amountAppears !== undefined) bar('chips', `${who} amount appears`, 'bet', 'lineAmount', 0, { startsAt: b.amountAppears, endsAt: b.amountAppears });
      bar('seats', `${who} caption`, 'bet', 'caption', 0, b.caption);
    }
  }
  return out;
}
