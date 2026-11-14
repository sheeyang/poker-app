import { baselinePlayingStrategy, committedTimings, dealBeats, defaultConfiguration, defaultTrainerConfiguration, payoutBeats, settleAfter, showdownBeats, streetBeats, type ChipAmount, type ConcreteAction, type DealInputs, type ObservableParticipant, type ObservableTableSession, type PayoutInputs, type PresentationPhase, type PresentingPhaseKind, type ShowdownInputs, type SweepBeats, type Street, type StreetInputs, type TableMode, type Timings } from '@poker/contracts';

/**
 * The motion lab's model (ADR-0040): pure. From timings and a scenario it gives everything the motion lab draws: the
 * scripted committed views a table would have received, the phase blocks, and the beats on each lane. The page plays
 * the views on a virtual clock; nothing here reads a clock or touches a server.
 */

export type ScenarioId = 'heads-up';
export const scenarios: readonly { readonly id: ScenarioId; readonly label: string }[] = [{ id: 'heads-up', label: 'Heads-up' }];

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

/** One beat as a bar on a lane, in milliseconds from the start of the script. */
export interface LabBeat { readonly lane: Lane; readonly label: string; readonly startsAt: number; readonly endsAt: number }

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

const YOU = 'you', BOT = 'bot', HAND = 'hand-1', DEFAULT_GAP = 600;
const BOARD = ['2c', '7d', 'Ts', 'Kc', '3h'];
const STREET_LABEL: Record<Street, string> = { preflop: 'Deal', flop: 'Flop', turn: 'Turn', river: 'River' };
const PHASE_LABEL: Record<PresentationPhase['kind'], string> = { deal: 'Deal', street: 'Street', showdown: 'Showdown', payout: 'Payout', settle: 'Settle' };

/** One scripted action: who acts, what they do, and the chips it puts in (the amount to bet or call to). */
interface Step { readonly who: string; readonly action: ConcreteAction; /** It ends the street's betting. */ readonly closes?: true }
const heads: readonly Step[] = [
  { who: YOU, action: { type: 'call' } }, { who: BOT, action: { type: 'check' }, closes: true },
  { who: BOT, action: { type: 'check' } }, { who: YOU, action: { type: 'bet', betTo: 40 } }, { who: BOT, action: { type: 'call' }, closes: true },
  { who: BOT, action: { type: 'check' } }, { who: YOU, action: { type: 'check' }, closes: true },
  { who: BOT, action: { type: 'bet', betTo: 60 } }, { who: YOU, action: { type: 'call' }, closes: true },
];

interface Seat { stack: ChipAmount; wager: ChipAmount; contribution: ChipAmount }

export function motionLab(input: LabInput): MotionLab {
  const timings = input.timings ?? committedTimings, mode = input.mode, gap = input.actionGapMs ?? DEFAULT_GAP;
  const views: LabView[] = [], blocks: LabBlock[] = [], beats: LabBeat[] = [];
  const stakes = { small: defaultConfiguration.smallBlind, big: defaultConfiguration.bigBlind }, buyIn = 1000;
  const seats: Record<string, Seat> = { [YOU]: { stack: buyIn - stakes.small, wager: stakes.small, contribution: stakes.small }, [BOT]: { stack: buyIn - stakes.big, wager: stakes.big, contribution: stakes.big } };
  let phases: PresentationPhase[] = [], board = 0, street: Street = 'preflop', cursor = 0, windowOpensAt = 0;
  const decisions: { decisionId: string; action: { participantId: string; action: ConcreteAction } }[] = [];
  const log: { at: number; who: string; type: ConcreteAction['type']; toPot: boolean }[] = [];
  let result: { payouts: { participantId: string; amount: number }[]; shown: boolean } | undefined;

  const table = (at: number, actor: string | null, opensAt: number | null, extra: { countdown?: { startsAt: number; endsAt: number } } = {}): ObservableTableSession => {
    const complete = !!result, started = phases.length > 0;
    const participants: ObservableParticipant[] = [[YOU, 1], [BOT, 2]].map(([id, seat]) => {
      const s = seats[id as string]!;
      return {
        participantId: id as string, seat: seat as number, sittingOut: false, stack: complete ? s.stack + (result!.payouts.find(p => p.participantId === id)?.amount ?? 0) : s.stack,
        ...(started ? { inHand: true, folded: false, allIn: false, contribution: s.contribution, wager: s.wager, cardCount: 2, ...(id === YOU || (complete && result!.shown) ? { holeCards: id === YOU ? ['As', 'Kd'] : ['Qh', 'Jc'] } : {}) } : {}),
      };
    });
    const total = Object.values(seats).reduce((sum, s) => sum + s.contribution, 0);
    const online = mode === 'online';
    return {
      tableSessionId: 'motion-lab', mode, options: { actionTimeLimitSeconds: online ? 30 : null, allowLiveAnalysis: true }, viewerParticipantId: YOU, ownerParticipantId: YOU,
      pokerRevision: views.length + 1, sessionRevision: views.length + 1, serverTime: at, pendingChanges: [], trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
      ...(online ? { connectedParticipantIds: [YOU] } : {}),
      bindings: [{ participantId: YOU, name: 'You', controller: { kind: 'human' } }, { participantId: BOT, name: 'Bot Ada', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }],
      schedule: { phases: [...phases], actionWindow: actor && opensAt !== null ? { participantId: actor, decisionId: `d${decisions.length}`, opensAt, ...(online && actor === YOU ? { deadlineAt: opensAt + 30_000 } : {}) } : null, ...(extra.countdown ? { nextHandCountdown: { ...extra.countdown, durationMs: extra.countdown.endsAt - extra.countdown.startsAt } } : {}) },
      view: {
        configuration: { ...defaultConfiguration, seatCount: 2 },
        history: started ? [{ handId: HAND, description: '', decisions: decisions.map(d => ({ ...d, state: {} as never })) }] : [],
        state: started ? {
          status: complete ? 'completed-hand' : 'active-hand', buttonSeat: 1, handId: HAND, street, board: BOARD.slice(0, board), pots: complete ? [{ amount: total, eligibleParticipantIds: [YOU, BOT] }] : [],
          actorId: complete ? null : actor, decisionId: complete ? null : `d${decisions.length}`, legalActions: [], smallBlindParticipantId: YOU, bigBlindParticipantId: BOT, participants,
          ...(complete ? { payouts: result!.payouts, returns: [] } : {}),
        } : { status: 'between-hands', buttonSeat: 1, board: [], pots: [], actorId: null, legalActions: [], participants: [[YOU, 1], [BOT, 2]].map(([id, seat]) => ({ participantId: id as string, seat: seat as number, sittingOut: false, stack: buyIn })) },
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

  // Before the Hand: the table waits, then deals.
  views.push({ at: 0, table: table(0, null, null) });
  cursor = gap;
  add('deal', 'preflop', { dealt: [YOU, BOT].map(participantId => ({ participantId, cardCount: 2 })), blinds: [YOU, BOT], refills: [] });
  windowOpensAt = cursor;
  views.push({ at: phases[0]!.startsAt, table: table(phases[0]!.startsAt, YOU, windowOpensAt) });

  for (const step of heads) {
    const at = windowOpensAt + gap, acts = seats[step.who]!, other = seats[step.who === YOU ? BOT : YOU]!;
    const to = step.action.type === 'bet' ? step.action.betTo : step.action.type === 'call' ? other.wager : acts.wager;
    acts.stack -= to - acts.wager; acts.contribution += to - acts.wager; acts.wager = to;
    decisions.push({ decisionId: `d${decisions.length}`, action: { participantId: step.who, action: step.action } });
    cursor = at;
    log.push({ at, who: step.who, type: step.action.type, toPot: !!step.closes && step.action.type !== 'check' && street !== 'river' });
    if (!step.closes) { windowOpensAt = at; views.push({ at, table: table(at, step.who === YOU ? BOT : YOU, at) }); continue; }
    const swept = [YOU, BOT].filter(id => seats[id]!.wager > 0), wagers = swept.map(id => seats[id]!.wager);
    for (const id of [YOU, BOT]) seats[id]!.wager = 0;
    if (street === 'river') {
      // Betting is over: the hands are shown, then the pot is paid. The line stays in the view; the showdown sweeps it.
      swept.forEach((id, i) => { seats[id]!.wager = wagers[i]!; });
      add('showdown', 'river', { swept, shown: [{ participantId: BOT, cardCount: 2 }, { participantId: YOU, cardCount: 2 }] });
      const pot = Object.values(seats).reduce((sum, s) => sum + s.contribution, 0);
      result = { payouts: [{ participantId: YOU, amount: pot }], shown: true };
      add('payout', 'river', { awards: [{ participantId: YOU, won: pot, returned: 0 }] });
      views.push({ at, table: table(at, null, null) });
      continue;
    }
    street = street === 'preflop' ? 'flop' : street === 'flop' ? 'turn' : 'river';
    board = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
    add('street', street, { swept, cardCount: street === 'flop' ? 3 : 1 });
    windowOpensAt = cursor;
    views.push({ at, table: table(at, BOT, windowOpensAt) });
  }

  // Every beat, from its phase's start, as the table plays it: the shared beat functions at the phase's own length.
  const name = (id: string) => (id === YOU ? 'You' : 'Ada');
  const bar = (lane: Lane, label: string, start: number, beat: { startsAt: number; endsAt: number }) => beats.push({ lane, label, startsAt: start + beat.startsAt, endsAt: start + beat.endsAt });
  const sweep = (start: number, sw: SweepBeats) => { for (const w of sw.wagers) bar('chips', `${name(w.participantId)} chips to pot`, start, w); if (sw.pot) bar('chips', 'Pot brightens', start, sw.pot); };
  for (const p of phases) {
    if (p.kind === 'deal') {
      const b = dealBeats(p.inputs, p.durationMs, timings);
      bar('cards', 'Cards return', p.startsAt, b.cardsReturn); bar('seats', 'Button moves', p.startsAt, b.buttonMoves);
      for (const r of b.refills) bar('stacks', `${name(r.participantId)} refill`, p.startsAt, r);
      for (const blind of b.blinds) bar('chips', `${name(blind.participantId)} blind`, p.startsAt, blind);
      for (const c of b.cards) { bar('cards', `${name(c.participantId)} card ${c.card + 1}`, p.startsAt, c); if (c.participantId === YOU) bar('cards', `${name(c.participantId)} card ${c.card + 1} turns`, p.startsAt, c.turn); }
    } else if (p.kind === 'street') {
      const b = streetBeats(p.inputs, p.durationMs, timings);
      sweep(p.startsAt, b.sweep); bar('board', 'Burn', p.startsAt, b.burn);
      for (const c of b.cards) { bar('board', `Board card ${c.card + 1}`, p.startsAt, c); if (c.spread) bar('board', 'Flop spreads', p.startsAt, c.spread); bar('board', `Board card ${c.card + 1} turns`, p.startsAt, c.turn); }
    } else if (p.kind === 'showdown') {
      const b = showdownBeats(p.inputs, p.durationMs, timings);
      sweep(p.startsAt, b.sweep);
      for (const h of b.hands) for (const c of h.cards) bar('cards', `${name(h.participantId)} card ${c.card + 1} turns`, p.startsAt, c.turn);
    } else if (p.kind === 'payout') {
      const b = payoutBeats(p.inputs, p.durationMs, timings);
      bar('chips', 'Pot pulses', p.startsAt, b.pot);
      for (const a of b.awards) { bar('stacks', `${name(a.participantId)} award`, p.startsAt, a); bar('stacks', `${name(a.participantId)} award fades`, p.startsAt, a.fade); bar('seats', `${name(a.participantId)} caption`, p.startsAt, a.caption); }
    }
  }
  // Motion with no Presentation Phase, from the view that carried it.
  for (const a of log) {
    if (a.type === 'check') bar('seats', `${name(a.who)} checks`, a.at, { startsAt: 0, endsAt: timings.motion.check });
    else bar('chips', `${name(a.who)} ${a.type}s`, a.at, { startsAt: 0, endsAt: a.toPot ? timings.motion.betToPot : timings.motion.betFlight });
    bar('seats', `${name(a.who)} caption`, a.at, { startsAt: 0, endsAt: timings.motion.caption });
  }
  beats.sort((x, y) => x.startsAt - y.startsAt || x.endsAt - y.endsAt);

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

  const breakpoints = [...new Set([...views.map(v => v.at), ...blocks.flatMap(b => [b.startsAt, b.endsAt]), ...views.flatMap(v => v.table.schedule.actionWindow ? [v.table.schedule.actionWindow.opensAt] : [])])].sort((a, b) => a - b);
  const viewAt = (time: number) => (views.findLast(v => v.at <= time) ?? views[0]!).table;
  return { views, blocks, beats, totalMs, breakpoints, viewAt };
}
