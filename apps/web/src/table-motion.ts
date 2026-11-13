import { dealBeats, payoutBeats, showdownBeats, streetBeats, type BoardStreet, type DealBeats, type ObservableTableSession, type PayoutBeats, type PresentationPhaseKind, type ShowdownBeats, type Street, type StreetBeats } from '@poker/contracts';
import { connectionOf } from './online-status.js';

/**
 * What changed at the table between two presented views, as motion cues with the server time of the moment each one
 * presents. Pure: the table's choreography plays the cues (ADR-0038). A Presentation Phase's motion is timed from the
 * phase's start, so a late viewer joins it part-way; anything else is timed from the view that carried it.
 */

/** One seated Participant, as motion reads them. */
export interface SeatScene {
  readonly participantId: string;
  readonly seat: number;
  readonly cards: number;
  /** Their hole cards are face up to this viewer. */
  readonly shown: boolean;
  readonly folded: boolean;
  readonly wager: number;
  readonly stack: number;
  readonly sittingOut: boolean;
  readonly offline: boolean;
}

/** The presented table, reduced to what motion compares. */
export interface TableScene {
  readonly tableSessionId: string;
  readonly handId?: string;
  readonly settled: boolean;
  readonly board: readonly string[];
  readonly buttonSeat: number | null;
  readonly viewerId: string;
  readonly viewerSeat: number | null;
  readonly seatCount: number;
  readonly seats: readonly SeatScene[];
  /** The current Hand's decisions so far, oldest first. */
  readonly decisions: readonly { readonly participantId: string; readonly type: string }[];
}

export type Cue = { readonly at: number } & (
  /**
   * The deal phase, played from its own beats (ADR-0039): the last Hand's cards go back to the deck and the button moves
   * on from `fromButton` (when this viewer saw the last Hand), any refill lands, the blinds go in, and the cards are
   * dealt; the viewer's own turn face up. `refills`: the refills to show, those this viewer has not already seen land.
   */
  | { readonly kind: 'deal'; readonly beats: DealBeats; readonly viewerId: string; readonly fromButton: number | null; readonly refills: readonly { readonly participantId: string; readonly amount: number }[] }
  /** Chips go in: to the betting line, or, when the bet closed the street, straight into the pot. */
  | { readonly kind: 'bet'; readonly participantId: string; readonly toPot: boolean }
  /** A fold: an opponent's cards are mucked; your own stay, dimmed. */
  | { readonly kind: 'fold'; readonly participantId: string; readonly muck: boolean; readonly cards: number }
  | { readonly kind: 'check'; readonly participantId: string }
  /** The betting line is swept into the pot, when no street reveal or showdown presents the sweep (a Hand won by folds). */
  | { readonly kind: 'sweep'; readonly participantIds: readonly string[] }
  /**
   * A street reveal, played from its own beats (ADR-0039): the line swept, the burn, then the board cards from position
   * `from` up to `to`.
   */
  | { readonly kind: 'board'; readonly from: number; readonly to: number; readonly beats: StreetBeats }
  /** The showdown, played from its own beats: the line swept, then each hand turned up; the viewer's own is already face up. */
  | { readonly kind: 'showdown'; readonly beats: ShowdownBeats; readonly viewerId: string }
  /**
   * The payout phase, played from its own beats (ADR-0039): the pot is pushed to each winner in turn, with any uncalled
   * chips that came back to them, in seat order.
   */
  | { readonly kind: 'payout'; readonly beats: PayoutBeats }
  | { readonly kind: 'sit'; readonly seat: number }
  | { readonly kind: 'stand'; readonly seat: number }
  | { readonly kind: 'move'; readonly fromSeat: number; readonly seat: number }
  /** Chips added to a stack between Hands: a rebuy or a top-up. `from`: the stack before them. */
  | { readonly kind: 'chips'; readonly participantId: string; readonly amount: number; readonly from: number }
  /** The viewer moved to `seat`: the table is drawn turned, so every seat is in a new place. */
  | { readonly kind: 'turn'; readonly seat: number }
  /** Sitting out, returning, disconnecting or reconnecting: the seat's words change. */
  | { readonly kind: 'status'; readonly participantId: string }
);

/**
 * Whether the current Hand's betting is over: it has a showdown or payout phase, or it is complete. The last street's
 * wagers stay in the view, but they are in the pot from then on, so the line is shown empty and swept.
 */
export function bettingOver(table: ObservableTableSession): boolean {
  const state = table.view.state;
  return state.status === 'completed-hand' || table.schedule.phases.some(p => p.handId === state.handId && (p.kind === 'showdown' || p.kind === 'payout'));
}

export function sceneOf(table: ObservableTableSession): TableScene {
  const state = table.view.state, over = bettingOver(table);
  const viewerSeat = state.participants.find(p => p.participantId === table.viewerParticipantId)?.seat ?? null;
  return {
    tableSessionId: table.tableSessionId,
    ...(state.handId ? { handId: state.handId } : {}),
    settled: state.status === 'completed-hand',
    board: state.board,
    buttonSeat: state.buttonSeat ?? null,
    viewerId: table.viewerParticipantId,
    viewerSeat,
    seatCount: table.view.configuration.seatCount,
    seats: state.participants.filter(p => p.seat !== null).map(p => ({
      participantId: p.participantId, seat: p.seat!, cards: p.cardCount ?? 0, shown: !!p.holeCards?.length, folded: !!p.folded,
      wager: over ? 0 : p.wager ?? 0, stack: p.stack, sittingOut: !!p.sittingOut, offline: connectionOf(table, p.participantId) === 'disconnected',
    })),
    decisions: (table.view.history.find(h => h.handId === state.handId)?.decisions ?? []).map(d => ({ participantId: d.action.participantId, type: d.action.action.type })),
  };
}

/** When the current Hand's phase of `kind` (for a street reveal, of `street`) started, if the schedule has one. */
export function phaseStart(table: ObservableTableSession, kind: PresentationPhaseKind, street?: Street): number | undefined {
  return table.schedule.phases.find(p => p.handId === table.view.state.handId && p.kind === kind && (street === undefined || p.street === street))?.startsAt;
}

/** How many board cards are out before each street reveal. */
const boardBefore: Readonly<Record<BoardStreet, number>> = { flop: 0, turn: 3, river: 4 };
const fitted = (phase: { readonly startsAt: number; readonly endsAt: number }) => phase.endsAt - phase.startsAt;

/**
 * The street reveals and the showdown this view is the first to show, each planned from its own phase's inputs and
 * fitted to its length, so every viewer plays the same beats at the same server times: in an all-in runout, each street
 * from its own phase. A viewer with no earlier view (`prev` undefined) gets the identical cues.
 */
function revealCues(prev: TableScene | undefined, next: TableScene, table: ObservableTableSession): Extract<Cue, { kind: 'board' | 'showdown' }>[] {
  const sameHand = !!prev && prev.handId === next.handId, cues: Extract<Cue, { kind: 'board' | 'showdown' }>[] = [];
  const seen = sameHand ? prev.board.length : 0;
  for (const phase of table.schedule.phases) {
    if (phase.handId !== next.handId) continue;
    if (phase.kind === 'street' && phase.street !== 'preflop') {
      const from = boardBefore[phase.street], to = from + phase.inputs.cardCount;
      if (next.board.length >= to && seen < to) cues.push({ kind: 'board', from, to, beats: streetBeats(phase.inputs, fitted(phase)), at: phase.startsAt });
    }
    if (phase.kind === 'showdown') {
      // The showdown has been presented once an opponent's hand is face up.
      const shown = (scene: TableScene) => scene.seats.some(s => s.shown && s.participantId !== scene.viewerId);
      if (shown(next) && !(sameHand && shown(prev))) cues.push({ kind: 'showdown', beats: showdownBeats(phase.inputs, fitted(phase)), viewerId: next.viewerId, at: phase.startsAt });
    }
  }
  return cues;
}

/**
 * The deal, when this view is the first to show its cards: planned from the deal phase's own inputs and fitted to its
 * length, so every viewer, one who joined late included, plays the same beats at the same server times. A viewer with
 * no earlier view (`prev` undefined) gets the identical deal, without the last Hand's cards or button to move.
 */
function dealCue(prev: TableScene | undefined, next: TableScene, table: ObservableTableSession): Extract<Cue, { kind: 'deal' }> | undefined {
  const phase = table.schedule.phases.find(p => p.handId === next.handId && p.kind === 'deal');
  if (phase?.kind !== 'deal' || !phase.inputs || !next.seats.some(s => s.cards > 0)) return undefined;
  // The view before this Hand, when this viewer saw it.
  const last = prev && prev.handId !== next.handId ? prev : undefined;
  if (prev && !last && prev.seats.some(s => s.cards > 0)) return undefined;
  // A rebuy this viewer saw arrive between Hands has landed already; the deal keeps its timing without it.
  const landed = (id: string) => (last?.seats.find(s => s.participantId === id)?.stack ?? 0) > 0;
  return { kind: 'deal', at: phase.startsAt, beats: dealBeats(phase.inputs, fitted(phase)), viewerId: next.viewerId,
    fromButton: last?.handId ? last.buttonSeat : null, refills: phase.inputs.refills.filter(r => !landed(r.participantId)).map(r => ({ participantId: r.participantId, amount: r.amount })) };
}

/** The current Hand's payout phase, when it has one. */
function payoutPhase(table: ObservableTableSession) {
  const phase = table.schedule.phases.find(p => p.handId === table.view.state.handId && p.kind === 'payout');
  return phase?.kind === 'payout' ? phase : undefined;
}

/**
 * The payout, when this view is the first to show the Hand complete: planned from the payout phase's own inputs and
 * fitted to its length, so a viewer with no earlier view (`prev` undefined) gets the identical payout, joined part-way.
 */
function payoutCue(prev: TableScene | undefined, next: TableScene, table: ObservableTableSession): Extract<Cue, { kind: 'payout' }> | undefined {
  const phase = payoutPhase(table);
  if (!phase || !next.settled || (prev?.handId === next.handId && prev?.settled)) return undefined;
  return { kind: 'payout', at: phase.startsAt, beats: payoutBeats(phase.inputs, fitted(phase)) };
}

/**
 * The cues for going from `prev` to the presented `table`. A first view moves nothing but the phases it presents, and
 * nothing moves when the viewer sits down or stands up. When the viewer moves seats, the table is drawn turned so they
 * stay at the bottom and every seat is in a new place: that is one cue, a turn, and nothing else moves with it.
 */
export function planMotion(prev: TableScene | undefined, table: ObservableTableSession): Cue[] {
  const next = sceneOf(table);
  if (!prev || prev.tableSessionId !== next.tableSessionId) return [dealCue(undefined, next, table), ...(next.handId ? revealCues(undefined, next, table) : []), payoutCue(undefined, next, table)].filter(cue => cue !== undefined);
  const viewAt = table.serverTime, cues: Cue[] = [];
  if (prev.viewerSeat !== next.viewerSeat) return prev.viewerSeat !== null && next.viewerSeat !== null ? [{ kind: 'turn', seat: next.viewerSeat, at: viewAt }] : [];
  const before = new Map(prev.seats.map(s => [s.participantId, s]));
  const after = new Map(next.seats.map(s => [s.participantId, s]));

  // Who is at the table: arrivals, departures and moves, between Hands or not.
  for (const s of next.seats) {
    const was = before.get(s.participantId);
    if (!was) cues.push({ kind: 'sit', seat: s.seat, at: viewAt });
    else if (was.seat !== s.seat) cues.push({ kind: 'move', fromSeat: was.seat, seat: s.seat, at: viewAt });
  }
  for (const s of prev.seats) if (!after.has(s.participantId)) cues.push({ kind: 'stand', seat: s.seat, at: viewAt });

  const sameHand = !!next.handId && prev.handId === next.handId;
  const settling = sameHand && !prev.settled && next.settled;
  for (const s of next.seats) {
    const was = before.get(s.participantId);
    if (!was || was.seat !== s.seat) continue;
    if (was.sittingOut !== s.sittingOut || was.offline !== s.offline) cues.push({ kind: 'status', participantId: s.participantId, at: viewAt });
    // Stacks only grow inside a Hand when it settles; any other growth in place is a rebuy or a top-up.
    // A refill that came with the next Hand (Practice's Rebuy & deal) lands with the deal, from the deal phase's beats.
    if (s.stack > was.stack && !settling && prev.handId === next.handId) cues.push({ kind: 'chips', participantId: s.participantId, amount: s.stack - was.stack, from: was.stack, at: viewAt });
  }
  if (!next.handId) return cues;

  const deal = dealCue(prev, next, table);
  if (deal) cues.push(deal);
  // The blinds went in with the deal.
  const blinds = deal?.beats.blinds.map(b => b.participantId) ?? [];
  if (!sameHand) return cues;

  // Actions since the last view.
  for (const d of next.decisions.slice(prev.decisions.length)) {
    const s = after.get(d.participantId), was = before.get(d.participantId);
    if (!s || !was) continue;
    if (d.type === 'fold') cues.push({ kind: 'fold', participantId: s.participantId, muck: s.participantId !== next.viewerId, cards: was.cards, at: viewAt });
    else if (d.type === 'check') cues.push({ kind: 'check', participantId: s.participantId, at: viewAt });
    // A bet that closed the street was swept at once: its chips go straight to the pot.
    else if (s.wager === 0 && !blinds.includes(s.participantId)) cues.push({ kind: 'bet', participantId: s.participantId, toPot: true, at: viewAt });
  }
  for (const s of next.seats) {
    const was = before.get(s.participantId);
    if (was && s.wager > was.wager && !blinds.includes(s.participantId)) cues.push({ kind: 'bet', participantId: s.participantId, toPot: false, at: viewAt });
  }
  // A street reveal or showdown sweeps the line as its first beat, so the burn and the hands wait for it; the sweep is
  // played here only when no such phase presents it, already or still to come (a Hand won by folds).
  const reveals = revealCues(prev, next, table);
  const presented = new Set(table.schedule.phases.flatMap(p => p.handId === next.handId && (p.kind === 'street' || p.kind === 'showdown') && (p.startsAt > viewAt || reveals.some(c => c.at === p.startsAt)) ? p.inputs.swept : []));
  const swept = prev.seats.filter(s => s.wager > 0 && (after.get(s.participantId)?.wager ?? 0) === 0 && !presented.has(s.participantId)).map(s => s.participantId);
  if (swept.length) cues.push({ kind: 'sweep', participantIds: swept, at: viewAt });
  cues.push(...reveals);
  const paid = payoutCue(prev, next, table);
  if (paid) cues.push(paid);
  return cues;
}

/**
 * The stack figures a payout has not reached yet at server time `serverNow`: each winner keeps showing their old stack
 * until their award's landing beat, from the payout phase's own beats, then the new total at once. It needs no earlier
 * view, so a viewer who joins mid-payout sees the same figures as everyone else. Keyed by Participant.
 */
export function heldStacks(table: ObservableTableSession, serverNow: number): Map<string, { readonly value: number; readonly until: number }> {
  const held = new Map<string, { value: number; until: number }>();
  const phase = payoutPhase(table);
  if (!phase || table.view.state.status !== 'completed-hand') return held;
  for (const award of payoutBeats(phase.inputs, fitted(phase)).awards) {
    const until = phase.startsAt + award.endsAt, stack = table.view.state.participants.find(p => p.participantId === award.participantId)?.stack;
    if (serverNow < until && stack !== undefined) held.set(award.participantId, { value: stack - award.amount, until });
  }
  return held;
}
