import { useEffect, useLayoutEffect, useRef } from 'react';
import { payoutMotion as P, showdownMotion as SD, streetMotion as ST, tableMotion as T, wagerMotion as W, type Beat, type ObservableTableSession } from '@poker/contracts';
import { at, box, flipUp, fly, play, q, reveal, snapshot, stay, type Box, type MotionContext, type Snapshot } from './motion.js';
import { planMotion, sceneOf, type Cue, type TableScene } from './table-motion.js';
import { chips } from './table-model.js';

/**
 * The table's motion (ADR-0038). The Hand is dealt from the deck: cards leave it one at a time in dealing order,
 * chips slide to the betting line and are swept to the pot, folded hands are mucked, and the pot is pushed to the
 * winner. Seats settle in place; chips added to a stack come in from the table's edge, and a refill that comes with a
 * deal lands before it. When you change seats the ring of seats dissolves into its new places. Motion only presents what the
 * view already says, from the server time of the moment it shows; it never waits for, or holds back, play. Its
 * timings are the shared presentation timing's (ADR-0039).
 */

const S = {
  body: (id: string) => `[data-seat-body="${id}"]`, card: (id: string, k: number) => `[data-card="${id}-${k}"]`,
  wager: (id: string) => `[data-wager="${id}"]`, chip: (id: string) => `[data-wager-chip="${id}"]`, stack: (id: string) => `[data-stack="${id}"]`,
  caption: (id: string) => `[data-caption="${id}"]`, seat: (n: number) => `[data-table-seat="${n}"]`, buttonAnchor: (n: number) => `[data-button-anchor="${n}"]`,
  board: (i: number) => `[data-board="${i}"]`, deck: '[data-motion="deck"]', burn: '[data-motion="burn"]', pot: '[data-motion="pot"]', center: '[data-motion="center"]', button: '[data-motion="button"]',
};
const SNAPSHOT = ['data-card', 'data-board', 'data-wager', 'data-wager-chip', 'data-button-anchor', 'data-seat-body', 'data-table-seat', 'data-stack'];
/** Motion more than this far behind the clock is over: the view shows its end state. */
const LONGEST = 4000;
const tilt = (k: number, cards: number) => (k === 0 ? -7 : k === cards - 1 ? 7 : 0);

/** The chip icon of a wager now: where a bet's chip lands. */
const chipAt = (ctx: MotionContext, id: string) => at(ctx, S.chip(id));
/** The middle of the table, as a destination for a card: its centre point, at the card's own size. */
function middleFor(ctx: MotionContext, card: Box | undefined): Box | undefined {
  const c = at(ctx, S.center);
  return c && card ? { x: c.x, y: c.y, w: card.w, h: card.h } : undefined;
}

function chipIn(ctx: MotionContext, id: string, delay: number, el: number) {
  fly(ctx, 'chip', at(ctx, S.body(id)), chipAt(ctx, id), { duration: W.chipFlight, delay, elapsed: el, hideBefore: true });
  // Appears whole just before the chip lands on it, so the hand-off cannot be seen.
  reveal(ctx, q(ctx, S.wager(id)), { delay: delay + W.amountAppears, elapsed: el, duration: 1 });
}

/** Sweeps the betting line into the pot; how long that takes, for whatever follows it. */
function sweep(ctx: MotionContext, ids: readonly string[], delay: number, el: number) {
  ids.forEach((id, n) => {
    fly(ctx, 'chip', ctx.last.get(S.chip(id))?.box, at(ctx, S.pot), { duration: W.sweepFlight, delay: delay + n * W.sweepStagger, elapsed: el, fadeOut: true });
    // The amount stays until its chip leaves, then fades: the chip itself is the flying ghost.
    const w = ctx.last.get(S.wager(id));
    if (w) stay(ctx, 'clone', w.box, [{ opacity: 1 }, { opacity: 0 }], { duration: W.sweepAmountFade, delay: delay + n * W.sweepStagger, elapsed: el, easing: 'linear', html: w.html.replace('<i', '<i style="visibility:hidden"') });
  });
  if (ids.length) play(ctx, q(ctx, S.pot), [{ opacity: .35 }, { opacity: 1 }], { duration: W.potBrightens, delay: delay + W.potAfterSweep + ids.length * W.sweepStagger, elapsed: el, easing: 'linear' });
}
const sweptFor = (count: number) => (count ? W.sweptBase + count * W.sweepStagger : 0);

/** The burn pile, even before its first card: just right of the deck. */
function burnBox(ctx: MotionContext) {
  const d = at(ctx, S.deck);
  return at(ctx, S.burn) ?? (d && { ...d, x: d.x + d.w + 10 });
}

/** A copy of what stood at `seat`, played in place over the change. */
function fadeOutClone(ctx: MotionContext, seat: number, frames: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }], duration: number, el: number) {
  const c = ctx.last.get(S.seat(seat));
  stay(ctx, 'clone', c?.box, frames, { duration, elapsed: el, html: c?.html });
}
const arrive = (ctx: MotionContext, seat: number, delay: number, el: number) => play(ctx, q(ctx, S.seat(seat)), [{ opacity: 0, scale: '.92' }, { opacity: 1, scale: '1' }], { duration: T.seatArrives, delay, elapsed: el });

/**
 * Chips added to a stack: in from the table's edge over `flight`, while the amount floats up off the stack and the
 * figure rolls to its new total (StackFigure).
 */
function chipsIn(ctx: MotionContext, id: string, amount: number, flight: { delay: number; duration: number; elapsed: number }, el: number) {
  const s = at(ctx, S.stack(id));
  fly(ctx, 'stack', s && { x: ctx.stage.clientWidth + 10, y: ctx.stage.clientHeight - 20, w: 0, h: 0 }, s, { ...flight, arc: 40, fadeOut: true });
  if (s) stay(ctx, 'label', { ...s, y: s.y - 14 }, [{ opacity: 0, translate: '0px 6px' }, { opacity: 1, translate: '0px -4px', offset: .25 }, { opacity: 1, translate: '0px -8px', offset: .7 }, { opacity: 0, translate: '0px -14px' }], { duration: T.chipsLabel, delay: flight.delay, elapsed: el, easing: 'linear', text: `+${chips(amount)} chips` });
}

function perform(cue: Cue, ctx: MotionContext, el: number) {
  switch (cue.kind) {
    case 'deal': {
      // Every timing is the deal phase's own beat, already fitted to the phase (dealBeats).
      const { beats } = cue, span = (beat: Beat) => ({ delay: beat.startsAt, duration: beat.endsAt - beat.startsAt, elapsed: el });
      // The last Hand's cards go back to the deck, and the button moves on.
      const returning = Array.from(ctx.last.keys()).filter(k => k.startsWith('[data-card=') || k.startsWith('[data-board='));
      returning.forEach((key, n) => { fly(ctx, key.startsWith('[data-board') ? 'back' : 'small-back', ctx.last.get(key)?.box, at(ctx, S.deck), { ...span(beats.cardsReturn), delay: beats.cardsReturn.startsAt + n * beats.returnStagger, fadeOut: true }); });
      const from = cue.fromButton === null ? undefined : ctx.last.get(S.buttonAnchor(cue.fromButton))?.box, button = q(ctx, S.button), to = box(ctx, button);
      if (from && to) play(ctx, button, [{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: '0px 0px' }], span(beats.buttonMoves));
      // A refill's chips land on the stack before the blinds go in.
      for (const refill of cue.refills) {
        const beat = beats.refills.find(b => b.participantId === refill.participantId);
        if (beat) chipsIn(ctx, refill.participantId, refill.amount, span(beat), el);
      }
      for (const blind of beats.blinds) {
        fly(ctx, 'chip', at(ctx, S.body(blind.participantId)), chipAt(ctx, blind.participantId), { ...span(blind), hideBefore: true });
        reveal(ctx, q(ctx, S.wager(blind.participantId)), { delay: blind.appearsAt, elapsed: el, duration: 1 });
      }
      const held = new Map<string, number>();
      for (const c of beats.cards) held.set(c.participantId, (held.get(c.participantId) ?? 0) + 1);
      for (const c of beats.cards) {
        const yours = c.participantId === cue.viewerId, dest = q(ctx, S.card(c.participantId, c.card));
        fly(ctx, yours ? 'back' : 'small-back', at(ctx, S.deck), box(ctx, dest), { ...span(c), spin: [-40, tilt(c.card, held.get(c.participantId)!)] });
        reveal(ctx, dest, { delay: c.appearsAt, elapsed: el, duration: 1 });
        if (yours) flipUp(ctx, dest, span(c.turn));
      }
      break;
    }
    case 'bet':
      if (cue.toPot) fly(ctx, 'chip', at(ctx, S.body(cue.participantId)), at(ctx, S.pot), { duration: T.betToPot, elapsed: el, fadeOut: true });
      else chipIn(ctx, cue.participantId, 0, el);
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: T.caption, elapsed: el });
      break;
    case 'fold':
      if (cue.muck) for (let k = 0; k < cue.cards; k++) {
        const from = ctx.last.get(S.card(cue.participantId, k))?.box;
        fly(ctx, 'small-back', from, middleFor(ctx, from), { duration: T.muckFlight, delay: k * T.muckStagger, elapsed: el, fadeOut: true, spin: [tilt(k, cue.cards), 90] });
      }
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: T.caption, elapsed: el });
      break;
    case 'check':
      play(ctx, q(ctx, S.body(cue.participantId)), [{ scale: '1' }, { scale: '.96', offset: .35 }, { scale: '1' }], { duration: T.check, elapsed: el });
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: T.caption, elapsed: el });
      break;
    case 'sweep':
      sweep(ctx, cue.participantIds, T.sweepAt, el);
      break;
    case 'board': {
      const burnAt = Math.max(ST.burnEarliest, sweptFor(cue.swept) - ST.burnOverlapsSweep);
      fly(ctx, 'small-back', at(ctx, S.deck), burnBox(ctx), { duration: ST.burnFlight, delay: burnAt, elapsed: el, spin: [0, 12] });
      // The pile's first card arrives with the flop's burn; later burns land on it.
      if (cue.from === 0) reveal(ctx, q(ctx, S.burn), { delay: burnAt + ST.burnPileAppears, elapsed: el, duration: 1 });
      const start = burnAt + ST.boardAfterBurn, first = at(ctx, S.board(cue.from));
      for (let k = cue.from; k < cue.to; k++) {
        const node = q(ctx, S.board(k)), b = box(ctx, node);
        if (cue.to - cue.from > 1) {
          // The flop leaves the deck as one stack, then spreads and turns.
          fly(ctx, 'back', at(ctx, S.deck), first, { duration: ST.flopFlight, delay: start, elapsed: el, spin: [-20, 0] });
          reveal(ctx, node, { delay: start + ST.flopAppears, elapsed: el, duration: 1 });
          if (first && b) play(ctx, node, [{ translate: `${first.x - b.x}px 0px` }, { translate: '0px 0px' }], { duration: ST.flopSpread, delay: start + ST.flopSpreadsAt, elapsed: el });
          flipUp(ctx, node, { duration: ST.flopTurn, delay: start + ST.flopTurnsAt + (k - cue.from) * ST.flopTurnStagger, elapsed: el });
        } else {
          fly(ctx, 'back', at(ctx, S.deck), b, { duration: ST.cardFlight, delay: start, elapsed: el, spin: [-20, 0] });
          reveal(ctx, node, { delay: start + ST.cardAppears, elapsed: el, duration: 1 });
          flipUp(ctx, node, { duration: ST.cardTurn, delay: start + ST.cardTurnsAt, elapsed: el });
        }
      }
      break;
    }
    case 'showdown': {
      const swept = sweptFor(cue.swept);
      for (const id of cue.participantIds) for (let k = 0; k < 2; k++) flipUp(ctx, q(ctx, S.card(id, k)), { duration: SD.turn, delay: swept + SD.turnsAfterSweep + k * SD.cardStagger, elapsed: el });
      break;
    }
    case 'payout': {
      play(ctx, q(ctx, S.pot), [{ opacity: 1 }, { opacity: .45, offset: .3 }, { opacity: 1 }], { duration: P.potPulse, delay: P.potAt, elapsed: el, easing: 'linear' });
      cue.awards.forEach(({ participantId }, i) => {
        // Pushed onto the winner's stack figure, which keeps its old value until the chips land (heldStacks).
        const dest = at(ctx, S.stack(participantId)), lands = P.firstLands + i * P.stagger;
        fly(ctx, 'stack', at(ctx, S.pot), dest, { duration: P.push, delay: lands - P.push, elapsed: el, arc: 30 });
        stay(ctx, 'stack', dest, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.7' }], { duration: P.landFade, delay: lands, elapsed: el, easing: 'linear' });
        reveal(ctx, q(ctx, S.caption(participantId)), { delay: lands - P.captionBeforeLanding, elapsed: el, duration: P.caption });
      });
      break;
    }
    case 'sit':
      fadeOutClone(ctx, cue.seat, undefined, T.sitFade, el);
      arrive(ctx, cue.seat, T.sitArrivesAt, el);
      break;
    case 'stand':
      fadeOutClone(ctx, cue.seat, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.94' }], T.leaveFade, el);
      arrive(ctx, cue.seat, T.leaveArrivesAt, el);
      break;
    case 'move':
      fadeOutClone(ctx, cue.fromSeat, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.94' }], T.leaveFade, el);
      fadeOutClone(ctx, cue.seat, undefined, T.sitFade, el);
      arrive(ctx, cue.seat, T.leaveArrivesAt, el);
      arrive(ctx, cue.fromSeat, T.moveVacatedArrivesAt, el);
      break;
    case 'chips':
      chipsIn(ctx, cue.participantId, cue.amount, { delay: 0, duration: T.chipsFlight, elapsed: el }, el);
      break;
    case 'turn': {
      // Every seat is in a new place: the ring dissolves into it while the felt, board and pot stay, and a label at the
      // bottom says where you are now.
      for (const [key, was] of ctx.last) if (key.startsWith('[data-table-seat=')) stay(ctx, 'clone', was.box, [{ opacity: 1 }, { opacity: 0 }], { duration: T.seatChangeFade, elapsed: el, easing: 'linear', html: was.html });
      for (const node of Array.from(ctx.stage.querySelectorAll('[data-table-seat]'))) play(ctx, node, [{ opacity: 0, scale: '.97' }, { opacity: 1, scale: '1' }], { duration: T.seatChangeArrives, delay: T.seatChangeArrivesAt, elapsed: el });
      const you = at(ctx, S.seat(cue.seat));
      if (you) stay(ctx, 'label', { ...you, y: you.y - you.h / 2 - 16 }, [{ opacity: 0, translate: '0px 6px' }, { opacity: 1, translate: '0px 0px', offset: .15 }, { opacity: 1, translate: '0px 0px', offset: .8 }, { opacity: 0, translate: '0px -6px' }], { duration: T.seatChangeLabel, delay: T.seatChangeArrivesAt, elapsed: el, text: `You’re in seat ${cue.seat}` });
      break;
    }
    case 'status':
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: T.status, elapsed: el });
      reveal(ctx, q(ctx, `${S.body(cue.participantId)} .connection-label`), { duration: T.status, elapsed: el });
      break;
  }
}

/**
 * The last scene and resting places each table showed, kept across remounts: Practice swaps the table for its
 * preparing screen between Hands, and the next Hand should still be dealt. Kept briefly, so a table opened again
 * later starts still.
 */
const remembered = new Map<string, { scene: TableScene; last: Snapshot; at: number }>();
const REMEMBER_FOR = 30_000;

/** A stack figure that should roll to its new total, and from what. */
export interface StackRoll { readonly from: number; readonly id: string }

/**
 * Plays the table's motion. Returns the stage's ref, and the stack figures that roll in this render: chips added to a
 * stack roll its figure up from the old total. `serverNow` is the estimated server time this render shows.
 */
export function useTableMotion(table: ObservableTableSession, serverNow: number) {
  const stage = useRef<HTMLElement>(null);
  const kept = remembered.get(table.tableSessionId), fresh = kept && Date.now() - kept.at < REMEMBER_FOR ? kept : undefined;
  const scene = useRef<TableScene | undefined>(fresh?.scene), last = useRef<Snapshot>(fresh?.last ?? new Map()), running = useRef(new Set<Animation>());
  const cues = planMotion(scene.current, table).filter(cue => serverNow - cue.at < LONGEST);
  useLayoutEffect(() => {
    const node = stage.current, fx = node?.querySelector<HTMLElement>('[data-motion-layer="over"]'), under = node?.querySelector<HTMLElement>('[data-motion-layer="under"]');
    scene.current = sceneOf(table);
    if (!node || !fx || !under) return;
    const ctx: MotionContext = { stage: node, fx, under, last: last.current, track: animation => {
      running.current.add(animation);
      const done = () => running.current.delete(animation);
      animation.addEventListener('finish', done); animation.addEventListener('cancel', done);
    } };
    for (const cue of cues) perform(cue, ctx, Math.max(0, serverNow - cue.at));
    // Where things rest now, for the next change. Things still moving keep where they rested before.
    const now = snapshot(node, SNAPSHOT), resting = new Map<string, { box: Box; html: string }>();
    for (const [key, value] of now) {
      const old = last.current.get(key), moving = node.querySelector(key)?.getAnimations({ subtree: true }).length;
      resting.set(key, old && moving ? old : value);
    }
    last.current = resting;
    remembered.set(table.tableSessionId, { scene: scene.current, last: resting, at: Date.now() });
  });
  useEffect(() => () => { for (const animation of running.current) animation.cancel(); }, []);
  const rolls = new Map<string, StackRoll>();
  for (const cue of cues) if (cue.kind === 'chips') {
    const stack = table.view.state.participants.find(p => p.participantId === cue.participantId)?.stack;
    if (stack !== undefined) rolls.set(cue.participantId, { from: cue.from, id: `${cue.participantId}@${cue.at}` });
  } else if (cue.kind === 'deal') {
    // A refill is a rebuy: the stack rolls up from empty.
    for (const refill of cue.refills) rolls.set(refill.participantId, { from: 0, id: `${refill.participantId}@${cue.at}` });
  }
  return { stage, rolls };
}

