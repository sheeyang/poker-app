import { useEffect, useLayoutEffect, useRef } from 'react';
import { returnBeat, sweepBeats, tableMotion as T, type Beat, type SweepBeats } from '@poker/contracts';
import type { FeltView } from './felt-view.js';
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
/** Motion more than this far behind the clock is over: the view shows its end state. A phase's motion lasts as long as its beats. */
const LONGEST = 4000;
const lasts = (cue: Cue) => Math.max(LONGEST, 'beats' in cue && 'totalMs' in cue.beats ? cue.beats.totalMs : 0);
const span = (beat: Beat, el: number) => ({ delay: beat.startsAt, duration: beat.endsAt - beat.startsAt, elapsed: el });
const tilt = (k: number, cards: number) => (k === 0 ? -7 : k === cards - 1 ? 7 : 0);

/** The chip icon of a wager now: where a bet's chip lands. */
const chipAt = (ctx: MotionContext, id: string) => at(ctx, S.chip(id));
/** The middle of the table, as a destination for a card: its centre point, at the card's own size. */
function middleFor(ctx: MotionContext, card: Box | undefined): Box | undefined {
  const c = at(ctx, S.center);
  return c && card ? { x: c.x, y: c.y, w: card.w, h: card.h } : undefined;
}

/** A bet's chip sliding to the betting line over `flight`, its amount appearing at `appearsAt`: a bet's, or a blind's beat. */
function chipIn(ctx: MotionContext, id: string, flight: Beat & { readonly appearsAt: number }, el: number) {
  fly(ctx, 'chip', at(ctx, S.body(id)), chipAt(ctx, id), { ...span(flight, el), hideBefore: true });
  // Appears whole just before the chip lands on it, so the hand-off cannot be seen.
  reveal(ctx, q(ctx, S.wager(id)), { delay: flight.appearsAt, elapsed: el, duration: 1 });
}
/** A bet's chip flight, from the view that carried it. */
const betFlight = { startsAt: 0, endsAt: T.betFlight, appearsAt: T.betAmountAppears };

/** Sweeps the betting line into the pot, at the sweep's own beats: a street reveal's or showdown's, or its own. */
function sweep(ctx: MotionContext, beats: SweepBeats, el: number) {
  for (const wager of beats.wagers) {
    fly(ctx, 'chip', ctx.last.get(S.chip(wager.participantId))?.box, at(ctx, S.pot), { ...span(wager, el), fadeOut: true });
    // The amount stays until its chip leaves, then fades: the chip itself is the flying ghost.
    const w = ctx.last.get(S.wager(wager.participantId));
    if (w) stay(ctx, 'clone', w.box, [{ opacity: 1 }, { opacity: 0 }], { ...span(wager.amountFades, el), easing: 'linear', html: w.html.replace('<i', '<i style="visibility:hidden"') });
  }
  if (beats.pot) play(ctx, q(ctx, S.pot), [{ opacity: .35 }, { opacity: 1 }], { ...span(beats.pot, el), easing: 'linear' });
}

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
function chipsIn(ctx: MotionContext, id: string, amount: number, flight: Beat, el: number) {
  const s = at(ctx, S.stack(id));
  fly(ctx, 'stack', s && { x: ctx.stage.clientWidth + 10, y: ctx.stage.clientHeight - 20, w: 0, h: 0 }, s, { ...span(flight, el), arc: 40, fadeOut: true });
  if (s) stay(ctx, 'label', { ...s, y: s.y - 14 }, [{ opacity: 0, translate: '0px 6px' }, { opacity: 1, translate: '0px -4px', offset: .25 }, { opacity: 1, translate: '0px -8px', offset: .7 }, { opacity: 0, translate: '0px -14px' }], { duration: T.chipsLabel, delay: flight.startsAt, elapsed: el, easing: 'linear', text: `+${chips(amount)} chips` });
}
/** Chips added to a stack between Hands, from the view that carried them. */
const chipsFlight = { startsAt: 0, endsAt: T.chipsFlight };

function perform(cue: Cue, ctx: MotionContext, el: number) {
  switch (cue.kind) {
    case 'deal': {
      // Every timing is the deal phase's own beat, already fitted to the phase (dealBeats).
      const { beats } = cue, spanned = (beat: Beat) => span(beat, el);
      // The last Hand's cards go back to the deck, however many this viewer saw, within the deal's return beat; and the button moves on.
      const returning = Array.from(ctx.last.keys()).filter(k => k.startsWith('[data-card=') || k.startsWith('[data-board='));
      returning.forEach((key, n) => { fly(ctx, key.startsWith('[data-board') ? 'back' : 'small-back', ctx.last.get(key)?.box, at(ctx, S.deck), { ...spanned(returnBeat(beats.cardsReturn, n, returning.length)), fadeOut: true }); });
      const from = cue.fromButton === null ? undefined : ctx.last.get(S.buttonAnchor(cue.fromButton))?.box, button = q(ctx, S.button), to = box(ctx, button);
      if (from && to) play(ctx, button, [{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: '0px 0px' }], spanned(beats.buttonMoves));
      // A refill's chips land on the stack before the blinds go in.
      for (const refill of beats.refills) chipsIn(ctx, refill.participantId, refill.amount, refill, el);
      for (const blind of beats.blinds) chipIn(ctx, blind.participantId, blind, el);
      const held = new Map<string, number>();
      for (const c of beats.cards) held.set(c.participantId, (held.get(c.participantId) ?? 0) + 1);
      for (const c of beats.cards) {
        const yours = c.participantId === cue.viewerId, dest = q(ctx, S.card(c.participantId, c.card));
        fly(ctx, yours ? 'back' : 'small-back', at(ctx, S.deck), box(ctx, dest), { ...spanned(c), spin: [-40, tilt(c.card, held.get(c.participantId)!)] });
        reveal(ctx, dest, { delay: c.appearsAt, elapsed: el, duration: 1 });
        if (yours) flipUp(ctx, dest, spanned(c.turn));
      }
      break;
    }
    case 'bet':
      if (cue.toPot) fly(ctx, 'chip', at(ctx, S.body(cue.participantId)), at(ctx, S.pot), { duration: T.betToPot, elapsed: el, fadeOut: true });
      else chipIn(ctx, cue.participantId, betFlight, el);
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
      sweep(ctx, sweepBeats(cue.participantIds), el);
      break;
    case 'board': {
      // Every timing is the street reveal's own beat, already fitted to the phase (streetBeats): the burn waits for the sweep.
      const { beats } = cue;
      sweep(ctx, beats.sweep, el);
      fly(ctx, 'small-back', at(ctx, S.deck), burnBox(ctx), { ...span(beats.burn, el), spin: [0, 12] });
      // The pile's first card arrives with the flop's burn; later burns land on it.
      if (cue.from === 0) reveal(ctx, q(ctx, S.burn), { delay: beats.burn.appearsAt, elapsed: el, duration: 1 });
      const first = at(ctx, S.board(cue.from));
      for (const card of beats.cards) {
        const node = q(ctx, S.board(cue.from + card.card)), b = box(ctx, node);
        // The flop leaves the deck as one stack, then spreads and turns; the turn and the river fly to their place.
        fly(ctx, 'back', at(ctx, S.deck), card.spread ? first : b, { ...span(card, el), spin: [-20, 0] });
        reveal(ctx, node, { delay: card.appearsAt, elapsed: el, duration: 1 });
        if (card.spread && first && b) play(ctx, node, [{ translate: `${first.x - b.x}px 0px` }, { translate: '0px 0px' }], span(card.spread, el));
        flipUp(ctx, node, span(card.turn, el));
      }
      break;
    }
    case 'showdown':
      // The line is swept first, then each hand turns up in the order shown; the viewer's own is face up already.
      sweep(ctx, cue.beats.sweep, el);
      for (const hand of cue.beats.hands) if (hand.participantId !== cue.viewerId) for (const card of hand.cards) flipUp(ctx, q(ctx, S.card(hand.participantId, card.card)), span(card.turn, el));
      break;
    case 'payout': {
      // Every timing is the payout phase's own beat, already fitted to the phase (payoutBeats).
      const { beats } = cue;
      play(ctx, q(ctx, S.pot), [{ opacity: 1 }, { opacity: .45, offset: .3 }, { opacity: 1 }], { ...span(beats.pot, el), easing: 'linear' });
      for (const award of beats.awards) {
        // Pushed onto the winner's stack figure, which keeps its old value until the chips land (heldStacks).
        const dest = at(ctx, S.stack(award.participantId));
        fly(ctx, 'stack', at(ctx, S.pot), dest, { ...span(award, el), arc: 30 });
        stay(ctx, 'stack', dest, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.7' }], { ...span(award.fade, el), easing: 'linear' });
        reveal(ctx, q(ctx, S.caption(award.participantId)), span(award.caption, el));
      }
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
      chipsIn(ctx, cue.participantId, cue.amount, chipsFlight, el);
      break;
    case 'turn': {
      // Every seat is in a new place: the ring dissolves into it while the felt, board and pot stay, and a label at the
      // bottom says where you are now.
      for (const [key, was] of ctx.last) if (key.startsWith('[data-table-seat=')) stay(ctx, 'clone', was.box, [{ opacity: 1 }, { opacity: 0 }], { duration: T.seatChangeFade, elapsed: el, easing: 'linear', html: was.html });
      for (const node of Array.from(ctx.stage.querySelectorAll('[data-table-seat]'))) play(ctx, node, [{ opacity: 0, scale: '.97' }, { opacity: 1, scale: '1' }], { duration: T.seatChangeArrives, delay: T.seatChangeArrivesAt, elapsed: el });
      const viewer = at(ctx, S.seat(cue.seat));
      if (viewer) stay(ctx, 'label', { ...viewer, y: viewer.y - viewer.h / 2 - 16 }, [{ opacity: 0, translate: '0px 6px' }, { opacity: 1, translate: '0px 0px', offset: .15 }, { opacity: 1, translate: '0px 0px', offset: .8 }, { opacity: 0, translate: '0px -6px' }], { duration: T.seatChangeLabel, delay: T.seatChangeArrivesAt, elapsed: el, text: `You’re in seat ${cue.seat}` });
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
 * A replay felt's motion (replay-motion.ts), played as given on the client clock rather than planned from the view. Each
 * step input has its own `key`: a new one snaps whatever is still playing to its end state before its own cues play.
 */
export interface ReplayPlayback {
  readonly key: string;
  /** Cues timed on the client clock: a later phase of the step waits for its moment. */
  readonly cues: readonly Cue[];
  /**
   * Play the cues backward: the felt draws the later step, and its own motion runs back to where the earlier step
   * begins. The resting places it starts from are the previous render's, so draw the earlier step just before.
   */
  readonly reverse: boolean;
  /** Called once this key's motion is over, at once when it has none; never for a motion a later key snapped. */
  readonly settled: () => void;
}

/**
 * Runs `animations`, all started together, backward as one: each shows at every moment what it showed that long before
 * the end of the whole motion, so the last thing to happen is undone first.
 */
function reverseAll(animations: readonly Animation[]) {
  const time = (value: CSSNumberish | null | undefined) => Number(value ?? 0);
  // Each one's end, in the time since they started together (one timed later started at a negative time).
  const ends = animations.map(animation => time(animation.effect?.getComputedTiming().endTime) - time(animation.currentTime));
  const total = Math.max(0, ...ends);
  animations.forEach((animation, i) => {
    animation.playbackRate = -1;
    animation.currentTime = time(animation.effect?.getComputedTiming().endTime) + total - ends[i]!;
  });
}

/**
 * Plays the table's motion. Returns the stage's ref, and the stack figures that roll in this render: chips added to a
 * stack roll its figure up from the old total. `serverNow` is the estimated server time this render shows. A `replay`
 * felt plays the motion it is given instead of planning it, and leaves the live table's remembered scene alone.
 */
export function useTableMotion(felt: FeltView, serverNow: number, replay?: ReplayPlayback) {
  const stage = useRef<HTMLElement>(null);
  const kept = replay ? undefined : remembered.get(felt.tableSessionId), fresh = kept && Date.now() - kept.at < REMEMBER_FOR ? kept : undefined;
  const scene = useRef<TableScene | undefined>(fresh?.scene), last = useRef<Snapshot>(fresh?.last ?? new Map()), running = useRef(new Set<Animation>());
  // The replay key whose motion has been played.
  const played = useRef<string>(undefined);
  const cues = replay ? (replay.key === played.current ? [] : replay.cues) : planMotion(scene.current, felt).filter(cue => serverNow - cue.at < lasts(cue));
  useLayoutEffect(() => {
    const node = stage.current, fx = node?.querySelector<HTMLElement>('[data-motion-layer="over"]'), under = node?.querySelector<HTMLElement>('[data-motion-layer="under"]');
    scene.current = sceneOf(felt);
    if (!node || !fx || !under) return;
    const ctx: MotionContext = { stage: node, fx, under, last: last.current, track: animation => {
      running.current.add(animation);
      const done = () => running.current.delete(animation);
      animation.addEventListener('finish', done); animation.addEventListener('cancel', done);
    } };
    const fresh = replay && replay.key !== played.current;
    if (fresh) {
      // A new step input: whatever still plays snaps to its end state, which is the felt as this render draws it. That
      // includes a step back's finished motion, which still holds the earlier step's look until this render replaced it.
      played.current = replay.key;
      const snapped = new Set([...running.current, ...node.getAnimations({ subtree: true })]);
      running.current.clear();
      for (const animation of snapped) animation.cancel();
      // Its travelling copies go with it now, not when their cancel event comes.
      fx.replaceChildren(); under.replaceChildren();
    }
    // A replay's later phases wait for their moment; a live view joins motion part-way and never ahead of it.
    for (const cue of cues) perform(cue, ctx, replay ? serverNow - cue.at : Math.max(0, serverNow - cue.at));
    if (fresh) {
      const started = Array.from(running.current), { settled } = replay;
      if (replay.reverse) reverseAll(started);
      if (!started.length) settled();
      // A motion a later input snapped is cancelled, and its finish never comes.
      else void Promise.all(started.map(animation => animation.finished)).then(settled, () => {});
    }
    // Where things rest now, for the next change. Things still moving keep where they rested before.
    const now = snapshot(node, SNAPSHOT), resting = new Map<string, { box: Box; html: string }>();
    for (const [key, value] of now) {
      const old = last.current.get(key), moving = node.querySelector(key)?.getAnimations({ subtree: true }).length;
      resting.set(key, old && moving ? old : value);
    }
    last.current = resting;
    if (!replay) remembered.set(felt.tableSessionId, { scene: scene.current, last: resting, at: Date.now() });
  });
  useEffect(() => () => { for (const animation of running.current) animation.cancel(); }, []);
  const rolls = new Map<string, StackRoll>();
  for (const cue of cues) if (cue.kind === 'chips') {
    const stack = felt.state.participants.find(p => p.participantId === cue.participantId)?.stack;
    if (stack !== undefined) rolls.set(cue.participantId, { from: cue.from, id: `${cue.participantId}@${cue.at}` });
  } else if (cue.kind === 'deal') {
    // A refill is a rebuy: the stack rolls up from empty.
    for (const refill of cue.beats.refills) rolls.set(refill.participantId, { from: 0, id: `${refill.participantId}@${cue.at}` });
  }
  return { stage, rolls };
}

