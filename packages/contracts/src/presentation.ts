import { committedTimings, type Timings } from './timings.js';
import type { ChipAmount, ParticipantId, PresentationPhaseKind, PresentingPhaseKind, TableMode } from './index.js';

/**
 * Presentation timing, shared by the server and the Trainer (ADR-0039). The server schedules Presentation Phases and
 * the Next-Hand Countdown from it; the Trainer times the table's motion from it. Every value is in milliseconds.
 * Overlays (menus, dialogs, notices, the analysis panel) are not table events and keep their own timings in the web app.
 *
 * Every timing lives in `timings.json` (ADR-0040); the beat functions take a `Timings` and default to the committed ones.
 * Motion offsets are from the moment the motion presents: a phase's start, or the view that carried it.
 */

/**
 * A Presentation Phase's Phase Inputs, by kind, for each kind whose length comes from its beats: what it presents. The
 * phase carries them as `inputs`. They hold only what the view already makes public, so every viewer computes the
 * same beats.
 */
export interface PhaseInputs {
  readonly deal: DealInputs;
  readonly street: StreetInputs;
  readonly showdown: ShowdownInputs;
  readonly payout: PayoutInputs;
}

/** A phase's kind and what it presents: all the server needs for its length, and a Trainer for its beats. */
export type PresentedPhase = { readonly [K in PresentationPhaseKind]: { readonly kind: K } & (K extends keyof PhaseInputs ? { readonly inputs: PhaseInputs[K] } : unknown) }[PresentationPhaseKind];
/** A presenting phase's kind and its Phase Inputs. */
export type PresentingPhase<K extends PresentingPhaseKind = PresentingPhaseKind> = { readonly [P in K]: { readonly kind: P; readonly inputs: PhaseInputs[P] } }[K];

/** A presenting phase of `kind` that presents `inputs`. */
export const presentingPhase = <K extends PresentingPhaseKind>(kind: K, inputs: PhaseInputs[K]): PresentingPhase => ({ kind, inputs }) as PresentingPhase;

/** How long a presenting Presentation Phase lasts: the total of its beats for its Phase Inputs. */
export const presentationPhaseLength = (phase: PresentingPhase): number => beatsOf(phase.kind, phase.inputs).totalMs;

/**
 * The Phase Inputs of a phase of `kind`, read field by field from `value`: nothing a field added elsewhere carries, and
 * `undefined` when `value` is not Phase Inputs of that kind (as from a server of another version, during a deploy).
 */
export const readPhaseInputs = <K extends PresentingPhaseKind>(kind: K, value: unknown): PhaseInputs[K] | undefined => byKind[kind].read(value);

/** Something that moves, from `startsAt` until `endsAt`, in milliseconds from its phase's start. */
export interface Beat { readonly startsAt: number; readonly endsAt: number }

/** What every beat function returns: the phase's beats and their total, the phase's length. No beat ends after it. */
export interface PhaseBeats { readonly totalMs: number }

/**
 * A phase's beat function, from its choreography: `plan(inputs, at)` lays out every beat, passing each offset through
 * `at`. Given the phase's own length, the beats are scaled to fit it exactly, since the phase is authoritative (a
 * Trainer and the server may briefly disagree during a deploy); without one, they keep their natural timing.
 */
function beatFunction<I, B extends PhaseBeats>(plan: (inputs: I, at: (ms: number) => number, timings: Timings) => B): (inputs: I, durationMs?: number, timings?: Timings) => B {
  return (inputs, durationMs, timings = committedTimings) => {
    const natural = plan(inputs, ms => ms, timings);
    if (durationMs === undefined || durationMs === natural.totalMs || natural.totalMs <= 0) return natural;
    const scale = durationMs / natural.totalMs;
    return { ...plan(inputs, ms => ms * scale, timings), totalMs: durationMs };
  };
}

/** The length of the Settle after each presenting phase, by the phase it follows; after the payout, by table mode too. */
export interface SettleLengths {
  readonly deal: number;
  readonly street: number;
  readonly showdown: number;
  readonly payout: Readonly<Record<TableMode, number>>;
}

/**
 * The Settle lengths: a moment to take in the deal or a street before acting; after the showdown, the time to read the
 * turned hands before the pot is pushed (the showdown's own beats end once the last hand is face up); and a moment to
 * see the result before the next Hand can start. Each may be 0: a Settle of 0 is not scheduled, and what follows
 * starts when the phase before it ends.
 */
export const settleLengths: SettleLengths = committedTimings.settle;

/** The length of the Settle after a phase of `kind` at a table of `mode`. */
export const settleAfter = (kind: PresentingPhaseKind, mode: TableMode, lengths: SettleLengths = settleLengths): number => kind === 'payout' ? lengths.payout[mode] : lengths[kind];

/** How long an Online Table's Next-Hand Countdown runs, from its announcement to the next Hand. */
export const nextHandCountdownMs = committedTimings.nextHandCountdownMs;

/** Seats in the order the engine deals them: clockwise from left of the button, or heads-up the button first. */
export function dealingOrder<S extends { readonly seat: number }>(seats: readonly S[], buttonSeat: number): S[] {
  const pastButton = (seat: number) => (seat > buttonSeat ? 0 : 1);
  const clockwise = [...seats].sort((a, b) => pastButton(a.seat) - pastButton(b.seat) || a.seat - b.seat);
  return seats.length === 2 ? clockwise.reverse() : clockwise;
}

/**
 * The betting line swept into the pot: each swept wager's chip flies to the pot, one after another, its amount fading as
 * it leaves (`amountFades`), and the pot brightens once the chips reach it (absent with nothing swept).
 */
export interface SweepBeats {
  readonly wagers: readonly (Beat & { readonly participantId: ParticipantId; readonly amountFades: Beat })[];
  readonly pot?: Beat;
}

/**
 * The sweep of `swept`, in the order given, at `tableMotion`'s sweep timings; when its last chip reaches the pot
 * (`lands`), and when its last beat ends (`endsAt`), both 0 with nothing swept.
 */
function sweepPlan(swept: readonly ParticipantId[], at: (ms: number) => number, tableMotion: Timings['motion']): { readonly beats: SweepBeats; readonly lands: number; readonly endsAt: number } {
  const leaves = (n: number) => tableMotion.sweepAt + n * tableMotion.sweepStagger;
  const wagers = swept.map((participantId, n) => ({ participantId, startsAt: at(leaves(n)), endsAt: at(leaves(n) + tableMotion.sweepFlight), amountFades: { startsAt: at(leaves(n)), endsAt: at(leaves(n) + tableMotion.sweepAmountFade) } }));
  if (!swept.length) return { beats: { wagers }, lands: 0, endsAt: 0 };
  const potAt = tableMotion.sweepAt + tableMotion.potAfterSweep + swept.length * tableMotion.sweepStagger;
  const pot = { startsAt: at(potAt), endsAt: at(potAt + tableMotion.potBrightens) };
  return { beats: { wagers, pot }, lands: leaves(swept.length - 1) + tableMotion.sweepFlight, endsAt: Math.max(pot.endsAt, ...wagers.flatMap(w => [w.endsAt, w.amountFades.endsAt])) };
}

/**
 * The line swept with no Presentation Phase to present it (a Hand won by folds): the same beats a street reveal or a
 * showdown plays first, from the view that carried it.
 */
export const sweepBeats = (swept: readonly ParticipantId[], timings: Timings = committedTimings): SweepBeats => sweepPlan(swept, ms => ms, timings.motion).beats;

/**
 * The deal: the last Hand's cards back to the deck, the button on, any refill and the blinds in, and the cards out in
 * dealing order. The deal phase lasts as long as these beats (`dealBeats`).
 */

/** What the deal presents. Every field is public in the view: who holds cards, the blinds' wagers, and stacks. */
export interface DealInputs {
  /** Who is dealt in, in the order the engine deals (`dealingOrder`), and how many cards each (`cardCount`). */
  readonly dealt: readonly { readonly participantId: ParticipantId; readonly cardCount: number }[];
  /** The blinds, in the order they go in. */
  readonly blinds: readonly ParticipantId[];
  /** Who was refilled with the deal from an empty stack (Practice's Rebuy & deal), and by how much. */
  readonly refills: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}

export interface DealBeats extends PhaseBeats {
  /**
   * The last Hand's cards flying back to the deck: however many a Trainer shows, every one sets off and lands within
   * this beat, each `flight` long and the next up to `stagger` later (`returnBeat`). Their count is no Phase Input:
   * only the cards a viewer saw can return.
   */
  readonly cardsReturn: Beat & { readonly flight: number; readonly stagger: number };
  readonly buttonMoves: Beat;
  /** Each refill's chips (`amount`) flying in, landing before the blinds go in. */
  readonly refills: readonly (Beat & { readonly participantId: ParticipantId; readonly amount: ChipAmount })[];
  /** Each blind's chip flying to the betting line; its amount appears at `appearsAt`. */
  readonly blinds: readonly (Beat & { readonly participantId: ParticipantId; readonly appearsAt: number })[];
  /**
   * Each card, in the order dealt: it leaves the deck at `startsAt` and lands at `endsAt`, appearing in place at
   * `appearsAt`; for its own Participant it then turns face up (`turn`).
   */
  readonly cards: readonly (Beat & { readonly participantId: ParticipantId; readonly card: number; readonly appearsAt: number; readonly turn: Beat })[];
}

/** The `n`th of `count` returning cards' flight back to the deck: within the deal's `cardsReturn`, so within the deal. */
export function returnBeat(cardsReturn: DealBeats['cardsReturn'], n: number, count: number): Beat {
  const room = cardsReturn.endsAt - cardsReturn.startsAt - cardsReturn.flight;
  const gap = count > 1 ? Math.min(cardsReturn.stagger, room / (count - 1)) : 0, startsAt = cardsReturn.startsAt + Math.min(n, count - 1) * gap;
  return { startsAt, endsAt: startsAt + cardsReturn.flight };
}

/**
 * The deal's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. Cards go
 * one at a time to each Participant in dealing order, then round again: the more there are, the closer together.
 */
export const dealBeats = beatFunction((inputs: DealInputs, at, timings): DealBeats => {
  const motion = timings.deal;
  const blindsAt = inputs.refills.length ? motion.refillLands + motion.blindsAfterRefill : 0;
  const refills = inputs.refills.map(({ participantId, amount }) => ({ participantId, amount, startsAt: at(0), endsAt: at(motion.refillLands) }));
  const blinds = inputs.blinds.map((participantId, n) => {
    const leaves = blindsAt + n * motion.blindStagger, lands = leaves + motion.blindFlight;
    return { participantId, startsAt: at(leaves), endsAt: at(lands), appearsAt: at(lands - motion.blindAppearsBefore) };
  });
  const count = inputs.dealt.reduce((sum, s) => sum + s.cardCount, 0), rounds = Math.max(0, ...inputs.dealt.map(s => s.cardCount));
  const gap = Math.min(motion.cardGap, Math.floor(motion.cardsRoom / Math.max(1, count)));
  const cards: DealBeats['cards'][number][] = [];
  for (let card = 0; card < rounds; card++) for (const { participantId, cardCount: held } of inputs.dealt) {
    if (card >= held) continue;
    const leaves = blindsAt + motion.cardsAfterBlinds + cards.length * gap, lands = leaves + motion.cardFlight, turns = lands + motion.turnAfterLanding;
    cards.push({ participantId, card, startsAt: at(leaves), endsAt: at(lands), appearsAt: at(lands - motion.cardAppearsBefore), turn: { startsAt: at(turns), endsAt: at(turns + motion.turn) } });
  }
  const cardsReturn = { startsAt: at(0), endsAt: at(motion.returnRoom + motion.returnFlight), flight: at(motion.returnFlight) - at(0), stagger: at(motion.returnStagger) - at(0) };
  const buttonMoves = { startsAt: at(0), endsAt: at(motion.buttonMoves) };
  const totalMs = Math.max(cardsReturn.endsAt, buttonMoves.endsAt, ...refills.map(b => b.endsAt), ...blinds.map(b => b.endsAt), ...cards.map(c => c.turn.endsAt));
  return { totalMs, cardsReturn, buttonMoves, refills, blinds, cards };
});

/**
 * A street reveal: the line swept, the burn once the last swept chip reaches the pot, then the board cards: the flop
 * leaves the deck as one stack and spreads, the turn and the river one card each, and each card turns face up once it
 * lands. The street reveal lasts as long as these beats (`streetBeats`).
 */

/** What a street reveal presents. Every field is public in the view: whose wagers left the line, and the board. */
export interface StreetInputs {
  /** Whose wagers the street reveal sweeps into the pot, in seat order: none for a runout's later streets. */
  readonly swept: readonly ParticipantId[];
  /** How many board cards it reveals: 3 for the flop, 1 for the turn and the river. */
  readonly cardCount: number;
}

export interface StreetBeats extends PhaseBeats {
  readonly sweep: SweepBeats;
  /** The burn card's flight to the burn pile; it appears there at `appearsAt`. */
  readonly burn: Beat & { readonly appearsAt: number };
  /**
   * Each board card the street reveals (`card` counts from the street's first): it leaves the deck at `startsAt` and
   * lands at `endsAt`, appearing in place at `appearsAt`; a flop card then spreads to its place (`spread`); it turns
   * face up (`turn`).
   */
  readonly cards: readonly (Beat & { readonly card: number; readonly appearsAt: number; readonly spread?: Beat; readonly turn: Beat })[];
}

/** A street reveal's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. */
export const streetBeats = beatFunction((inputs: StreetInputs, at, timings): StreetBeats => {
  const motion = timings.street, sweep = sweepPlan(inputs.swept, at, timings.motion);
  const burnAt = Math.max(motion.burnEarliest, sweep.lands), boardAt = burnAt + motion.boardAfterBurn, flop = inputs.cardCount > 1;
  const burn = { startsAt: at(burnAt), endsAt: at(burnAt + motion.burnFlight), appearsAt: at(burnAt + motion.burnFlight - motion.appearsBefore) };
  const lands = boardAt + (flop ? motion.flopFlight : motion.cardFlight);
  const cards = Array.from({ length: inputs.cardCount }, (_, card) => {
    const turns = flop ? lands + motion.flopTurnsAfterLanding + card * motion.flopTurnStagger : lands + motion.cardTurnsAfterLanding, turn = flop ? motion.flopTurn : motion.cardTurn;
    return { card, startsAt: at(boardAt), endsAt: at(lands), appearsAt: at(lands - motion.appearsBefore), ...(flop ? { spread: { startsAt: at(lands), endsAt: at(lands + motion.flopSpread) } } : {}), turn: { startsAt: at(turns), endsAt: at(turns + turn) } };
  });
  const totalMs = Math.max(burn.endsAt, sweep.endsAt, ...cards.flatMap(c => [c.turn.endsAt, c.spread?.endsAt ?? 0]));
  return { totalMs, sweep: sweep.beats, burn, cards };
});

/**
 * The showdown: the line swept, then each hand turned up in turn, card by card, once the last swept chip reaches the
 * pot. The showdown lasts as long as these beats (`showdownBeats`); the time to read the hands is the Settle after it.
 */

/** What the showdown presents. Every field is public in the view: whose wagers left the line, and whose hands are face up. */
export interface ShowdownInputs {
  /** Whose wagers the showdown sweeps into the pot, in seat order. In an all-in runout the showdown comes first, so it sweeps the line. */
  readonly swept: readonly ParticipantId[];
  /** Whose hands are turned up, in the order they are shown, and how many cards each. */
  readonly shown: readonly { readonly participantId: ParticipantId; readonly cardCount: number }[];
}

export interface ShowdownBeats extends PhaseBeats {
  readonly sweep: SweepBeats;
  /** Each hand turned up, in the order shown: each of its cards turning face up (`turn`). */
  readonly hands: readonly { readonly participantId: ParticipantId; readonly cards: readonly { readonly card: number; readonly turn: Beat }[] }[];
}

/** The showdown's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. */
export const showdownBeats = beatFunction((inputs: ShowdownInputs, at, timings): ShowdownBeats => {
  const motion = timings.showdown, sweep = sweepPlan(inputs.swept, at, timings.motion), first = sweep.lands + motion.turnsAfterSweep;
  const hands = inputs.shown.map(({ participantId, cardCount }, h) => ({ participantId, cards: Array.from({ length: cardCount }, (_, card) => {
    const turns = first + h * motion.handStagger + card * motion.cardStagger;
    return { card, turn: { startsAt: at(turns), endsAt: at(turns + motion.turn) } };
  }) }));
  const totalMs = Math.max(sweep.endsAt, ...hands.flatMap(h => h.cards.map(c => c.turn.endsAt)));
  return { totalMs, sweep: sweep.beats, hands };
});

/**
 * The payout: the pot pushed onto each winner's stack in turn. The payout phase lasts as long as these beats
 * (`payoutBeats`).
 */

/** What the payout presents. Every field is public in the view once the Hand is complete: its payouts and returns. */
export interface PayoutInputs {
  /**
   * Each Participant the payout pushes chips to, in seat order: what they won from the pots, and what came back to
   * them uncalled. A Participant appears once, however many pots they won.
   */
  readonly awards: readonly { readonly participantId: ParticipantId; readonly won: ChipAmount; readonly returned: ChipAmount }[];
}

export interface PayoutBeats extends PhaseBeats {
  /** The pot dimming and brightening as it is pushed. */
  readonly pot: Beat;
  /**
   * Each award, in turn: its chips (`amount`, won and returned together) leave the pot at `startsAt` and land on the
   * winner's stack at `endsAt`, when the stack figure takes its new value; they then fade into the stack (`fade`), and
   * the winner's caption shows (`caption`).
   */
  readonly awards: readonly (Beat & { readonly participantId: ParticipantId; readonly amount: ChipAmount; readonly fade: Beat; readonly caption: Beat })[];
}

/** The payout's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. */
export const payoutBeats = beatFunction((inputs: PayoutInputs, at, timings): PayoutBeats => {
  const motion = timings.payout;
  const pot = { startsAt: at(motion.potAt), endsAt: at(motion.potAt + motion.potPulse) };
  const awards = inputs.awards.map(({ participantId, won, returned }, i) => {
    const lands = motion.firstLands + i * motion.stagger, caption = lands - motion.captionBeforeLanding;
    return { participantId, amount: won + returned, startsAt: at(lands - motion.push), endsAt: at(lands), fade: { startsAt: at(lands), endsAt: at(lands + motion.landFade) }, caption: { startsAt: at(caption), endsAt: at(caption + motion.caption) } };
  });
  const totalMs = Math.max(pot.endsAt, ...awards.flatMap(a => [a.endsAt, a.fade.endsAt, a.caption.endsAt]));
  return { totalMs, pot, awards };
});

/** Table motion with no Presentation Phase: timed from the view that carried it, and never gates play. */
export const tableMotion = committedTimings.motion;

/** Reading Phase Inputs field by field: each reader returns `undefined` for a value of the wrong shape. */
const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const participant = (value: unknown): ParticipantId | undefined => (typeof value === 'string' ? value : undefined);
/** Each item of a list read by `item`, or `undefined` unless every one reads. */
function list<T>(value: unknown, item: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item);
  return items.every(read => read !== undefined) ? items as T[] : undefined;
}
/** A list of objects, each read from its fields by `fields`. */
const listOf = <T>(value: unknown, fields: (item: Record<string, unknown>) => T | undefined) => list(value, item => { const r = record(item); return r && fields(r); });
/** Participants paired with a count, as `{ participantId, [key]: count }`. */
const counted = <K extends string>(value: unknown, key: K) => listOf(value, item => {
  const participantId = participant(item.participantId), n = count(item[key]);
  return participantId === undefined || n === undefined ? undefined : { participantId, [key]: n } as { readonly participantId: ParticipantId } & { readonly [P in K]: number };
});
/** `fields`, unless one of them failed to read. */
const whole = <T extends object>(fields: { readonly [P in keyof T]: T[P] | undefined }): T | undefined => (Object.values(fields).every(field => field !== undefined) ? fields as T : undefined);

/** Each presenting phase kind's beat function and its Phase Inputs reader. */
const byKind: { readonly [K in PresentingPhaseKind]: { readonly beats: (inputs: PhaseInputs[K], durationMs?: number) => PhaseBeats; readonly read: (value: unknown) => PhaseInputs[K] | undefined } } = {
  deal: { beats: dealBeats, read: value => { const r = record(value); return r && whole<DealInputs>({ dealt: counted(r.dealt, 'cardCount'), blinds: list(r.blinds, participant), refills: counted(r.refills, 'amount') }); } },
  street: { beats: streetBeats, read: value => { const r = record(value); return r && whole<StreetInputs>({ swept: list(r.swept, participant), cardCount: count(r.cardCount) }); } },
  showdown: { beats: showdownBeats, read: value => { const r = record(value); return r && whole<ShowdownInputs>({ swept: list(r.swept, participant), shown: counted(r.shown, 'cardCount') }); } },
  payout: { beats: payoutBeats, read: value => { const r = record(value); return r && whole<PayoutInputs>({ awards: listOf(r.awards, item => whole({ participantId: participant(item.participantId), won: count(item.won), returned: count(item.returned) })) }); } },
};

/** The beats of a phase of `kind` presenting `inputs`; with `durationMs`, fitted to that length. */
function beatsOf<K extends PresentingPhaseKind>(kind: K, inputs: PhaseInputs[K], durationMs?: number): PhaseBeats {
  return byKind[kind].beats(inputs, durationMs);
}
