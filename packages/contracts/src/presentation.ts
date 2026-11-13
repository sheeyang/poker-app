import type { ChipAmount, ParticipantId, PresentationPhaseKind, PresentingPhaseKind, TableMode } from './index.js';

/**
 * Presentation timing, shared by the server and the Trainer (ADR-0039). The server schedules Presentation Phases and
 * the Next-Hand Countdown from it; the Trainer times the table's motion from it. Every value is in milliseconds.
 * Overlays (menus, dialogs, notices, the analysis panel) are not table events and keep their own timings in the web app.
 *
 * Motion offsets are from the moment the motion presents: a phase's start, or the view that carried it.
 */

/**
 * What a Presentation Phase presents, by kind, for each kind whose length comes from its beats. The phase carries
 * them as `inputs`. They hold only what the view already makes public, so every viewer computes the same beats.
 */
export interface PresentationPhaseInputs {
  readonly deal: DealInputs;
  readonly street: StreetInputs;
  readonly showdown: ShowdownInputs;
  readonly payout: PayoutInputs;
}

/** A phase's kind and what it presents: all the server needs for its length, and a Trainer for its beats. */
export type PresentedPhase = { readonly [K in PresentationPhaseKind]: { readonly kind: K } & (K extends keyof PresentationPhaseInputs ? { readonly inputs: PresentationPhaseInputs[K] } : unknown) }[PresentationPhaseKind];

/** How long a presenting Presentation Phase lasts: the total of its beats for what it presents. */
export function presentationPhaseLength(phase: PresentedPhase & { readonly kind: PresentingPhaseKind }): number {
  switch (phase.kind) {
    case 'deal': return dealBeats(phase.inputs).totalMs;
    case 'street': return streetBeats(phase.inputs).totalMs;
    case 'showdown': return showdownBeats(phase.inputs).totalMs;
    case 'payout': return payoutBeats(phase.inputs).totalMs;
  }
}

/** Something that moves, from `startsAt` until `endsAt`, in milliseconds from its phase's start. */
export interface Beat { readonly startsAt: number; readonly endsAt: number }

/** What every beat function returns: the phase's beats and their total, the phase's length. No beat ends after it. */
export interface PhaseBeats { readonly totalMs: number }

/**
 * A phase's beat function, from its choreography: `plan(inputs, at)` lays out every beat, passing each offset through
 * `at`. Given the phase's own length, the beats are scaled to fit it exactly, since the phase is authoritative (a
 * Trainer and the server may briefly disagree during a deploy); without one, they keep their natural timing.
 */
function beatFunction<I, B extends PhaseBeats>(plan: (inputs: I, at: (ms: number) => number) => B): (inputs: I, durationMs?: number) => B {
  return (inputs, durationMs) => {
    const natural = plan(inputs, ms => ms);
    if (durationMs === undefined || durationMs === natural.totalMs || natural.totalMs <= 0) return natural;
    const scale = durationMs / natural.totalMs;
    return { ...plan(inputs, ms => ms * scale), totalMs: durationMs };
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
 * The Settle lengths: a moment to take in the deal or a street before acting, time to read the turned hands before the
 * pot is pushed, and a moment to see the result before the next Hand can start. Each may be 0: a Settle of 0 is not
 * scheduled, and what follows starts when the phase before it ends.
 */
export const settleLengths: SettleLengths = Object.freeze({ deal: 300, street: 300, showdown: 1200, payout: Object.freeze({ practice: 600, online: 3000 }) });

/** The length of the Settle after a phase of `kind` at a table of `mode`. */
export const settleAfter = (kind: PresentingPhaseKind, mode: TableMode, lengths: SettleLengths = settleLengths): number => kind === 'payout' ? lengths.payout[mode] : lengths[kind];

/** How long an Online Table's Next-Hand Countdown runs, from its announcement to the next Hand. */
export const nextHandCountdownMs = 5000;

/**
 * The betting line swept into the pot: each swept wager's chip flies to the pot, one after another, its amount fading as
 * it leaves (`amountFades`), and the pot brightens once the chips reach it (absent with nothing swept).
 */
export interface SweepBeats {
  readonly wagers: readonly (Beat & { readonly participantId: ParticipantId; readonly amountFades: Beat })[];
  readonly pot?: Beat;
}

/** The sweep of `swept`, in the order given, at `tableMotion`'s sweep timings, and when its last chip reaches the pot (0 with none). */
function sweepPlan(swept: readonly ParticipantId[], at: (ms: number) => number): { readonly beats: SweepBeats; readonly lands: number } {
  const T = tableMotion, leaves = (n: number) => T.sweepAt + n * T.sweepStagger;
  const wagers = swept.map((participantId, n) => ({ participantId, startsAt: at(leaves(n)), endsAt: at(leaves(n) + T.sweepFlight), amountFades: { startsAt: at(leaves(n)), endsAt: at(leaves(n) + T.sweepAmountFade) } }));
  if (!swept.length) return { beats: { wagers }, lands: 0 };
  const potAt = T.sweepAt + T.potAfterSweep + swept.length * T.sweepStagger;
  return { beats: { wagers, pot: { startsAt: at(potAt), endsAt: at(potAt + T.potBrightens) } }, lands: leaves(swept.length - 1) + T.sweepFlight };
}

/**
 * The line swept with no Presentation Phase to present it (a Hand won by folds): the same beats a street reveal or a
 * showdown plays first, from the view that carried it.
 */
export const sweepBeats = (swept: readonly ParticipantId[]): SweepBeats => sweepPlan(swept, ms => ms).beats;

/**
 * The deal: the last Hand's cards back to the deck, the button on, any refill and the blinds in, and the cards out in
 * dealing order. The deal phase lasts as long as these beats (`dealBeats`).
 */
export const dealMotion = Object.freeze({
  /** Each of the last Hand's cards returning to the deck, one after another. */
  returnFlight: 540, returnStagger: 27,
  buttonMoves: 780,
  /** A refill that came with the deal (Practice's Rebuy & deal): its chips fly in, and the blinds follow once they land. */
  refillLands: 720, blindsAfterRefill: 30,
  /** Each blind's chip flight to the betting line, its amount appearing just before it lands, and the gap to the next. */
  blindFlight: 450, blindAppearsBefore: 15, blindStagger: 120,
  /**
   * When the first card leaves the deck, after the blinds start; the room the cards share, and the most between two
   * of them, so the spacing tightens past twelve cards; each card's flight, and when it appears in place before landing.
   */
  cardsAfterBlinds: 330, cardsRoom: 1350, cardGap: 112, cardFlight: 510, cardAppearsBefore: 15,
  /** A Participant's own cards turning face up, after each lands. */
  turnAfterLanding: 30, turn: 390,
});

/** What the deal presents. Every field is public in the view: who holds cards, the blinds' wagers, and stacks. */
export interface DealInputs {
  /** Who is dealt in, in the order the engine deals (clockwise from left of the button; heads-up, the button first), and how many cards each (`cardCount`). */
  readonly dealt: readonly { readonly participantId: ParticipantId; readonly cardCount: number }[];
  /** The blinds, in the order they go in. */
  readonly blinds: readonly ParticipantId[];
  /** Who was refilled between Hands from an empty stack (a rebuy, as Practice's Rebuy & deal makes), and by how much. */
  readonly refills: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}

export interface DealBeats extends PhaseBeats {
  /** The first of the last Hand's cards flying back to the deck; each next one sets off `returnStagger` later. */
  readonly cardsReturn: Beat; readonly returnStagger: number;
  readonly buttonMoves: Beat;
  /** Each refill's chips flying in, landing before the blinds go in. */
  readonly refills: readonly (Beat & { readonly participantId: ParticipantId })[];
  /** Each blind's chip flying to the betting line; its amount appears at `appearsAt`. */
  readonly blinds: readonly (Beat & { readonly participantId: ParticipantId; readonly appearsAt: number })[];
  /**
   * Each card, in the order dealt: it leaves the deck at `startsAt` and lands at `endsAt`, appearing in place at
   * `appearsAt`; for its own Participant it then turns face up (`turn`).
   */
  readonly cards: readonly (Beat & { readonly participantId: ParticipantId; readonly card: number; readonly appearsAt: number; readonly turn: Beat })[];
}

/**
 * The deal's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. Cards go
 * one at a time to each Participant in dealing order, then round again: the more there are, the closer together.
 */
export const dealBeats = beatFunction((inputs: DealInputs, at): DealBeats => {
  const D = dealMotion;
  const blindsAt = inputs.refills.length ? D.refillLands + D.blindsAfterRefill : 0;
  const refills = inputs.refills.map(({ participantId }) => ({ participantId, startsAt: at(0), endsAt: at(D.refillLands) }));
  const blinds = inputs.blinds.map((participantId, n) => {
    const leaves = blindsAt + n * D.blindStagger, lands = leaves + D.blindFlight;
    return { participantId, startsAt: at(leaves), endsAt: at(lands), appearsAt: at(lands - D.blindAppearsBefore) };
  });
  const count = inputs.dealt.reduce((sum, s) => sum + s.cardCount, 0), rounds = Math.max(0, ...inputs.dealt.map(s => s.cardCount));
  const gap = Math.min(D.cardGap, Math.floor(D.cardsRoom / Math.max(1, count)));
  const cards: DealBeats['cards'][number][] = [];
  for (let card = 0; card < rounds; card++) for (const { participantId, cardCount: held } of inputs.dealt) {
    if (card >= held) continue;
    const leaves = blindsAt + D.cardsAfterBlinds + cards.length * gap, lands = leaves + D.cardFlight, turns = lands + D.turnAfterLanding;
    cards.push({ participantId, card, startsAt: at(leaves), endsAt: at(lands), appearsAt: at(lands - D.cardAppearsBefore), turn: { startsAt: at(turns), endsAt: at(turns + D.turn) } });
  }
  const cardsReturn = { startsAt: at(0), endsAt: at(D.returnFlight) }, buttonMoves = { startsAt: at(0), endsAt: at(D.buttonMoves) };
  const totalMs = Math.max(cardsReturn.endsAt, buttonMoves.endsAt, ...refills.map(b => b.endsAt), ...blinds.map(b => b.endsAt), ...cards.map(c => c.turn.endsAt));
  return { totalMs, cardsReturn, returnStagger: at(D.returnStagger) - at(0), buttonMoves, refills, blinds, cards };
});

/**
 * A street reveal: the line swept (`tableMotion`'s sweep), the burn once the last swept chip reaches the pot, then the
 * board cards: the flop leaves the deck as one stack and spreads, the turn and the river one card each, and each card
 * turns face up once it lands. The street reveal lasts as long as these beats (`streetBeats`), 1.5× the M5 timings.
 */
export const streetMotion = Object.freeze({
  /** When the burn sets off with nothing swept; with a sweep, it sets off as the last chip reaches the pot. */
  burnEarliest: 240,
  burnFlight: 300,
  /** A card (the burn, or a board card) appearing in place, just before it lands. */
  appearsBefore: 15,
  /** When the board cards leave the deck, after the burn sets off. */
  boardAfterBurn: 300,
  /** The flop: its stack's flight, its spread once it lands, and its cards turning one after another. */
  flopFlight: 330, flopSpread: 270, flopTurnsAfterLanding: 30, flopTurnStagger: 60, flopTurn: 360,
  /** The turn and the river: the card's flight, and its turn once it lands. */
  cardFlight: 390, cardTurnsAfterLanding: 15, cardTurn: 390,
});

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
export const streetBeats = beatFunction((inputs: StreetInputs, at): StreetBeats => {
  const ST = streetMotion, sweep = sweepPlan(inputs.swept, at);
  const burnAt = Math.max(ST.burnEarliest, sweep.lands), boardAt = burnAt + ST.boardAfterBurn, flop = inputs.cardCount > 1;
  const burn = { startsAt: at(burnAt), endsAt: at(burnAt + ST.burnFlight), appearsAt: at(burnAt + ST.burnFlight - ST.appearsBefore) };
  const lands = boardAt + (flop ? ST.flopFlight : ST.cardFlight);
  const cards = Array.from({ length: inputs.cardCount }, (_, card) => {
    const turns = flop ? lands + ST.flopTurnsAfterLanding + card * ST.flopTurnStagger : lands + ST.cardTurnsAfterLanding, turn = flop ? ST.flopTurn : ST.cardTurn;
    return { card, startsAt: at(boardAt), endsAt: at(lands), appearsAt: at(lands - ST.appearsBefore), ...(flop ? { spread: { startsAt: at(lands), endsAt: at(lands + ST.flopSpread) } } : {}), turn: { startsAt: at(turns), endsAt: at(turns + turn) } };
  });
  const totalMs = Math.max(burn.endsAt, ...sweep.beats.wagers.flatMap(w => [w.endsAt, w.amountFades.endsAt]), sweep.beats.pot?.endsAt ?? 0, ...cards.flatMap(c => [c.turn.endsAt, c.spread?.endsAt ?? 0]));
  return { totalMs, sweep: sweep.beats, burn, cards };
});

/**
 * The showdown: the line swept (`tableMotion`'s sweep), then each hand turned up in turn, card by card, once the last
 * swept chip reaches the pot. The showdown lasts as long as these beats (`showdownBeats`); the Settle after it is the
 * time to read the hands.
 */
export const showdownMotion = Object.freeze({
  /** When the first card turns, after the sweep; the gap to the next hand, and to a hand's next card; and each turn. */
  turnsAfterSweep: 225, handStagger: 300, cardStagger: 180, turn: 570,
});

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
export const showdownBeats = beatFunction((inputs: ShowdownInputs, at): ShowdownBeats => {
  const SD = showdownMotion, sweep = sweepPlan(inputs.swept, at), first = sweep.lands + SD.turnsAfterSweep;
  const hands = inputs.shown.map(({ participantId, cardCount }, h) => ({ participantId, cards: Array.from({ length: cardCount }, (_, card) => {
    const turns = first + h * SD.handStagger + card * SD.cardStagger;
    return { card, turn: { startsAt: at(turns), endsAt: at(turns + SD.turn) } };
  }) }));
  const totalMs = Math.max(0, ...sweep.beats.wagers.flatMap(w => [w.endsAt, w.amountFades.endsAt]), sweep.beats.pot?.endsAt ?? 0, ...hands.flatMap(h => h.cards.map(c => c.turn.endsAt)));
  return { totalMs, sweep: sweep.beats, hands };
});

/**
 * The payout: the pot pushed onto each winner's stack in turn. The payout phase lasts as long as these beats
 * (`payoutBeats`).
 */
export const payoutMotion = Object.freeze({
  /** The pot dimming and brightening as it is pushed. */
  potAt: 225, potPulse: 1050,
  /**
   * When the first award lands on its winner's stack, and the gap to each next landing: wide enough that each winner's
   * figure is seen to change on its own, while the next push is already on its way.
   */
  firstLands: 1065, stagger: 300,
  /** Each award's push from the pot, ending as it lands. */
  push: 840,
  /** The pushed chips fading into the stack once they land. */
  landFade: 240,
  /** The winner's caption appearing, from just before the chips land. */
  captionBeforeLanding: 30, caption: 240,
});

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
export const payoutBeats = beatFunction((inputs: PayoutInputs, at): PayoutBeats => {
  const P = payoutMotion;
  const pot = { startsAt: at(P.potAt), endsAt: at(P.potAt + P.potPulse) };
  const awards = inputs.awards.map(({ participantId, won, returned }, i) => {
    const lands = P.firstLands + i * P.stagger, caption = lands - P.captionBeforeLanding;
    return { participantId, amount: won + returned, startsAt: at(lands - P.push), endsAt: at(lands), fade: { startsAt: at(lands), endsAt: at(lands + P.landFade) }, caption: { startsAt: at(caption), endsAt: at(caption + P.caption) } };
  });
  const totalMs = Math.max(pot.endsAt, ...awards.flatMap(a => [a.endsAt, a.fade.endsAt, a.caption.endsAt]));
  return { totalMs, pot, awards };
});

/**
 * Table motion with no Presentation Phase: it is timed from the view that carried it and never gates play. It plays at
 * the phases' followable tempo, 1.5× the M5 motion's timings.
 */
export const tableMotion = Object.freeze({
  /** A bet's chip flight from the seat to the betting line, and when its amount appears, just before the chip lands. */
  betFlight: 450, betAmountAppears: 435,
  /** A bet straight into the pot (when there is no betting line to land on). */
  betToPot: 510,
  /** An acting seat's caption appearing. */
  caption: 225,
  /** A folded hand mucked to the middle of the table, card after card. */
  muckFlight: 510, muckStagger: 60,
  check: 360,
  /** The line swept to the pot: when it starts, after the view that carried it. */
  sweepAt: 180,
  /** A swept chip's flight to the pot, and the gap between one wager's chip and the next. */
  sweepFlight: 420, sweepStagger: 60,
  /** A swept wager's amount fading as its chip leaves. */
  sweepAmountFade: 210,
  /** The pot brightening once the chips reach it, after the sweep starts (plus one stagger per wager). */
  potAfterSweep: 390, potBrightens: 240,
  /** A seat settling in place. */
  seatArrives: 360,
  /** A Participant sitting down: the empty seat fading, then the seat arriving. */
  sitFade: 210, sitArrivesAt: 120,
  /** A Participant standing up or moving: the seat they left fading and shrinking, then the seats arriving. */
  leaveFade: 300, leaveArrivesAt: 210, moveVacatedArrivesAt: 300,
  /** Chips added to a stack: their flight in from the table's edge, the floating amount, and the figure's roll. */
  chipsFlight: 840, chipsLabel: 1650, stackRoll: 1050,
  /** The viewer's own seat change: the old seats fading, the new ones arriving, and the label naming the seat. */
  seatChangeFade: 240, seatChangeArrivesAt: 180, seatChangeArrives: 330, seatChangeLabel: 2400,
  /** A seat's status changing: its caption and connection label. */
  status: 270,
});
