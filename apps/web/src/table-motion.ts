import type { ObservableTableSession, PresentationPhaseKind, Street } from '@poker/contracts';
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
  /** The current Hand's blinds. */
  readonly blinds: readonly string[];
  /** The current Hand's decisions so far, oldest first. */
  readonly decisions: readonly { readonly participantId: string; readonly type: string }[];
}

export type Cue = { readonly at: number } & (
  /** A new Hand: the last one's cards go back to the deck, and the button moves on. */
  | { readonly kind: 'new-hand'; readonly fromButton: number | null }
  /** Hole cards are dealt one at a time, clockwise from left of the button; the blinds go in first. */
  | { readonly kind: 'deal'; readonly order: readonly { readonly participantId: string; readonly cards: number; readonly viewer: boolean }[]; readonly blinds: readonly string[] }
  /** Chips go in: to the betting line, or, when the bet closed the street, straight into the pot. */
  | { readonly kind: 'bet'; readonly participantId: string; readonly toPot: boolean }
  /** A fold: an opponent's cards are mucked; your own stay, dimmed. */
  | { readonly kind: 'fold'; readonly participantId: string; readonly muck: boolean; readonly cards: number }
  | { readonly kind: 'check'; readonly participantId: string }
  /** The betting line is swept into the pot. */
  | { readonly kind: 'sweep'; readonly participantIds: readonly string[] }
  /** A street's board cards, after a burn. `swept`: chips swept in the same change, which go first. */
  | { readonly kind: 'board'; readonly from: number; readonly to: number; readonly swept: number }
  /** Hands turned up at showdown. */
  | { readonly kind: 'showdown'; readonly participantIds: readonly string[]; readonly swept: number }
  /** The pot is pushed to the winners, and uncalled chips go back. */
  | { readonly kind: 'payout'; readonly awards: readonly { readonly participantId: string; readonly amount: number }[] }
  | { readonly kind: 'sit'; readonly seat: number }
  | { readonly kind: 'stand'; readonly seat: number }
  | { readonly kind: 'move'; readonly fromSeat: number; readonly seat: number }
  /** Chips added to a stack between Hands: a rebuy or a top-up. */
  | { readonly kind: 'chips'; readonly participantId: string; readonly amount: number }
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
    blinds: [state.smallBlindParticipantId, state.bigBlindParticipantId].filter((id): id is string => !!id),
    decisions: (table.view.history.find(h => h.handId === state.handId)?.decisions ?? []).map(d => ({ participantId: d.action.participantId, type: d.action.action.type })),
  };
}

/** When the current Hand's phase of `kind` (for a street reveal, of `street`) started, if the schedule has one. */
export function phaseStart(table: ObservableTableSession, kind: PresentationPhaseKind, street?: Street): number | undefined {
  return table.schedule.phases.find(p => p.handId === table.view.state.handId && p.kind === kind && (street === undefined || p.street === street))?.startsAt;
}

const streetOf: Readonly<Record<number, Street>> = { 3: 'flop', 4: 'turn', 5: 'river' };

/** Seated Participants in dealing order: clockwise, starting left of the button. */
function dealingOrder<T extends { readonly seat: number }>(seats: readonly T[], buttonSeat: number | null, seatCount: number): T[] {
  const from = buttonSeat ?? 0;
  return [...seats].sort((a, b) => ((a.seat - from - 1 + seatCount) % seatCount) - ((b.seat - from - 1 + seatCount) % seatCount));
}

/**
 * The cues for going from `prev` to the presented `table`. Nothing moves on a first view, or when the viewer's own
 * seat changed (the whole table turns so they stay at the bottom, and every seat would seem to move).
 */
export function planMotion(prev: TableScene | undefined, table: ObservableTableSession): Cue[] {
  const next = sceneOf(table);
  if (!prev || prev.tableSessionId !== next.tableSessionId || prev.viewerSeat !== next.viewerSeat) return [];
  const viewAt = table.serverTime, cues: Cue[] = [];
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
  const newHand = !!next.handId && prev.handId !== next.handId;
  const settling = sameHand && !prev.settled && next.settled;
  for (const s of next.seats) {
    const was = before.get(s.participantId);
    if (!was || was.seat !== s.seat) continue;
    if (was.sittingOut !== s.sittingOut || was.offline !== s.offline) cues.push({ kind: 'status', participantId: s.participantId, at: viewAt });
    // Stacks only grow inside a Hand when it settles; any other growth in place is a rebuy or a top-up.
    if (s.stack > was.stack && !settling && prev.handId === next.handId) cues.push({ kind: 'chips', participantId: s.participantId, amount: s.stack - was.stack, at: viewAt });
  }
  if (!next.handId) return cues;

  // Dealt: everyone holding cards in a new Hand, or, in the same Hand, those whose cards the deal phase has just shown.
  const dealt = next.seats.filter(s => s.cards > 0 && (newHand || before.get(s.participantId)?.cards === 0));
  if (newHand && prev.handId) cues.push({ kind: 'new-hand', fromButton: prev.buttonSeat, at: phaseStart(table, 'deal') ?? viewAt });
  // The blinds go in as the deal starts.
  const blinds = dealt.length ? next.blinds.filter(id => (after.get(id)?.wager ?? 0) > 0) : [];
  if (dealt.length) cues.push({
    kind: 'deal', at: phaseStart(table, 'deal') ?? viewAt, blinds,
    order: dealingOrder(dealt, next.buttonSeat, next.seatCount).map(s => ({ participantId: s.participantId, cards: s.cards, viewer: s.participantId === next.viewerId })),
  });
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
  const swept = prev.seats.filter(s => s.wager > 0 && (after.get(s.participantId)?.wager ?? 0) === 0).map(s => s.participantId);
  if (swept.length) cues.push({ kind: 'sweep', participantIds: swept, at: viewAt });

  // Each street presented since the last view, from its own phase: the flop's three cards together, then one by one.
  const streets: { from: number; to: number }[] = [];
  if (prev.board.length < 3 && next.board.length >= 3) streets.push({ from: prev.board.length, to: 3 });
  for (let count = Math.max(prev.board.length, 3) + 1; count <= next.board.length; count++) streets.push({ from: count - 1, to: count });
  streets.forEach((street, i) => { cues.push({ kind: 'board', ...street, swept: i === 0 ? swept.length : 0, at: phaseStart(table, 'street', streetOf[street.to]) ?? viewAt }); });
  const revealed = next.seats.filter(s => s.shown && s.participantId !== next.viewerId && !before.get(s.participantId)?.shown).map(s => s.participantId);
  if (revealed.length) cues.push({ kind: 'showdown', participantIds: revealed, swept: next.board.length > prev.board.length ? 0 : swept.length, at: phaseStart(table, 'showdown') ?? viewAt });
  if (settling) cues.push({ kind: 'payout', awards: awardsOf(table), at: phaseStart(table, 'payout') ?? viewAt });
  return cues;
}

/** Pot awards and returned chips, per Participant, in seat order. */
function awardsOf(table: ObservableTableSession) {
  const state = table.view.state, total = new Map<string, number>();
  for (const t of [...(state.payouts ?? []), ...(state.returns ?? [])]) total.set(t.participantId, (total.get(t.participantId) ?? 0) + t.amount);
  const seatOf = (id: string) => state.participants.find(p => p.participantId === id)?.seat ?? 0;
  return [...total].filter(([, amount]) => amount > 0).sort(([a], [b]) => seatOf(a) - seatOf(b)).map(([participantId, amount]) => ({ participantId, amount }));
}

/** How long after the payout phase starts each award's chips land on the winner's stack: the first, then a stagger. */
export const PAYOUT_LANDS = 710, PAYOUT_STAGGER = 60;

/**
 * The stack figures a payout has not reached yet at server time `serverNow`: each winner keeps showing their old stack
 * until the chips pushed to them land, then the new total at once. Keyed by Participant.
 */
export function heldStacks(table: ObservableTableSession, serverNow: number): Map<string, { readonly value: number; readonly until: number }> {
  const held = new Map<string, { value: number; until: number }>();
  const start = phaseStart(table, 'payout');
  if (start === undefined || table.view.state.status !== 'completed-hand') return held;
  awardsOf(table).forEach(({ participantId, amount }, i) => {
    const until = start + PAYOUT_LANDS + i * PAYOUT_STAGGER;
    const stack = table.view.state.participants.find(p => p.participantId === participantId)?.stack;
    if (serverNow < until && stack !== undefined) held.set(participantId, { value: stack - amount, until });
  });
  return held;
}
