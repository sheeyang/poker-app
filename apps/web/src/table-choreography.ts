import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ObservableTableSession } from '@poker/contracts';
import { at, box, flipUp, fly, play, q, reveal, snapshot, stay, type Box, type MotionContext, type Snapshot } from './motion.js';
import { PAYOUT_LANDS, PAYOUT_STAGGER, planMotion, sceneOf, type Cue, type TableScene } from './table-motion.js';
import { chips } from './table-model.js';

/**
 * The table's motion (ADR-0038). The Hand is dealt from the deck: cards leave it one at a time in dealing order,
 * chips slide to the betting line and are swept to the pot, folded hands are mucked, and the pot is pushed to the
 * winner. Seats settle in place; chips added to a stack come in from the table's edge. Motion only presents what the
 * view already says, from the server time of the moment it shows; it never waits for, or holds back, play.
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
  fly(ctx, 'chip', at(ctx, S.body(id)), chipAt(ctx, id), { duration: 300, delay, elapsed: el });
  // Appears whole just before the chip lands on it, so the hand-off cannot be seen.
  reveal(ctx, q(ctx, S.wager(id)), { delay: delay + 290, elapsed: el, duration: 1 });
}

/** Sweeps the betting line into the pot; how long that takes, for whatever follows it. */
function sweep(ctx: MotionContext, ids: readonly string[], delay: number, el: number) {
  ids.forEach((id, n) => {
    fly(ctx, 'chip', ctx.last.get(S.chip(id))?.box, at(ctx, S.pot), { duration: 280, delay: delay + n * 40, elapsed: el, fadeOut: true });
    // The amount stays until its chip leaves, then fades: the chip itself is the flying ghost.
    const w = ctx.last.get(S.wager(id));
    if (w) stay(ctx, 'clone', w.box, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay: delay + n * 40, elapsed: el, easing: 'linear', html: w.html.replace('<i', '<i style="visibility:hidden"') });
  });
  if (ids.length) play(ctx, q(ctx, S.pot), [{ opacity: .35 }, { opacity: 1 }], { duration: 160, delay: delay + 260 + ids.length * 40, elapsed: el, easing: 'linear' });
}
const sweptFor = (count: number) => (count ? 320 + count * 40 : 0);

/** The burn pile, even before its first card: just right of the deck. */
function burnBox(ctx: MotionContext) {
  const d = at(ctx, S.deck);
  return at(ctx, S.burn) ?? (d && { ...d, x: d.x + d.w + 10 });
}

/** A copy of what stood at `seat`, played in place over the change. */
function fadeOutClone(ctx: MotionContext, seat: number, frames: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }], duration = 180, el = 0) {
  const c = ctx.last.get(S.seat(seat));
  stay(ctx, 'clone', c?.box, frames, { duration, elapsed: el, html: c?.html });
}
const arrive = (ctx: MotionContext, seat: number, delay: number, el: number) => play(ctx, q(ctx, S.seat(seat)), [{ opacity: 0, scale: '.92' }, { opacity: 1, scale: '1' }], { duration: 240, delay, elapsed: el });

function perform(cue: Cue, ctx: MotionContext, el: number) {
  switch (cue.kind) {
    case 'new-hand': {
      // The last Hand's cards go back to the deck.
      const cards = Array.from(ctx.last.keys()).filter(k => k.startsWith('[data-card=') || k.startsWith('[data-board='));
      cards.forEach((key, n) => { fly(ctx, key.startsWith('[data-board') ? 'back' : 'small-back', ctx.last.get(key)?.box, at(ctx, S.deck), { duration: 360, delay: n * 18, elapsed: el, fadeOut: true }); });
      const from = cue.fromButton === null ? undefined : ctx.last.get(S.buttonAnchor(cue.fromButton))?.box, button = q(ctx, S.button), to = box(ctx, button);
      if (from && to) play(ctx, button, [{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: '0px 0px' }], { duration: 520, elapsed: el });
      break;
    }
    case 'deal': {
      cue.blinds.forEach((id, n) => { chipIn(ctx, id, n * 80, el); });
      const total = cue.order.reduce((sum, s) => sum + s.cards, 0), most = Math.max(0, ...cue.order.map(s => s.cards));
      // Fits the deal phase at any table size: 75 ms a card, closer together past twelve.
      const step = Math.min(75, 900 / Math.max(1, total));
      for (let k = 0; k < most; k++) cue.order.forEach((s, j) => {
        if (k >= s.cards) return;
        const delay = 220 + (k * cue.order.length + j) * step, dest = q(ctx, S.card(s.participantId, k));
        fly(ctx, s.viewer ? 'back' : 'small-back', at(ctx, S.deck), box(ctx, dest), { duration: 340, delay, elapsed: el, spin: [-40, tilt(k, s.cards)] });
        reveal(ctx, dest, { delay: delay + 330, elapsed: el, duration: 1 });
        if (s.viewer) flipUp(ctx, dest, { duration: 260, delay: delay + 360, elapsed: el });
      });
      break;
    }
    case 'bet':
      if (cue.toPot) fly(ctx, 'chip', at(ctx, S.body(cue.participantId)), at(ctx, S.pot), { duration: 340, elapsed: el, fadeOut: true });
      else chipIn(ctx, cue.participantId, 0, el);
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: 150, elapsed: el });
      break;
    case 'fold':
      if (cue.muck) for (let k = 0; k < cue.cards; k++) {
        const from = ctx.last.get(S.card(cue.participantId, k))?.box;
        fly(ctx, 'small-back', from, middleFor(ctx, from), { duration: 340, delay: k * 40, elapsed: el, fadeOut: true, spin: [tilt(k, cue.cards), 90] });
      }
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: 150, elapsed: el });
      break;
    case 'check':
      play(ctx, q(ctx, S.body(cue.participantId)), [{ scale: '1' }, { scale: '.96', offset: .35 }, { scale: '1' }], { duration: 240, elapsed: el });
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: 150, elapsed: el });
      break;
    case 'sweep':
      sweep(ctx, cue.participantIds, 120, el);
      break;
    case 'board': {
      const burnAt = Math.max(160, sweptFor(cue.swept) - 40);
      fly(ctx, 'small-back', at(ctx, S.deck), burnBox(ctx), { duration: 200, delay: burnAt, elapsed: el, spin: [0, 12] });
      // The pile's first card arrives with the flop's burn; later burns land on it.
      if (cue.from === 0) reveal(ctx, q(ctx, S.burn), { delay: burnAt + 190, elapsed: el, duration: 1 });
      const start = burnAt + 200, first = at(ctx, S.board(cue.from));
      for (let k = cue.from; k < cue.to; k++) {
        const node = q(ctx, S.board(k)), b = box(ctx, node);
        if (cue.to - cue.from > 1) {
          // The flop leaves the deck as one stack, then spreads and turns.
          fly(ctx, 'back', at(ctx, S.deck), first, { duration: 220, delay: start, elapsed: el, spin: [-20, 0] });
          reveal(ctx, node, { delay: start + 215, elapsed: el, duration: 1 });
          if (first && b) play(ctx, node, [{ translate: `${first.x - b.x}px 0px` }, { translate: '0px 0px' }], { duration: 180, delay: start + 220, elapsed: el });
          flipUp(ctx, node, { duration: 240, delay: start + 240 + (k - cue.from) * 40, elapsed: el });
        } else {
          fly(ctx, 'back', at(ctx, S.deck), b, { duration: 260, delay: start, elapsed: el, spin: [-20, 0] });
          reveal(ctx, node, { delay: start + 255, elapsed: el, duration: 1 });
          flipUp(ctx, node, { duration: 260, delay: start + 270, elapsed: el });
        }
      }
      break;
    }
    case 'showdown': {
      const swept = sweptFor(cue.swept);
      for (const id of cue.participantIds) for (let k = 0; k < 2; k++) flipUp(ctx, q(ctx, S.card(id, k)), { duration: 380, delay: swept + 150 + k * 120, elapsed: el });
      break;
    }
    case 'payout': {
      play(ctx, q(ctx, S.pot), [{ opacity: 1 }, { opacity: .45, offset: .3 }, { opacity: 1 }], { duration: 700, delay: 150, elapsed: el, easing: 'linear' });
      cue.awards.forEach(({ participantId }, i) => {
        // Pushed onto the winner's stack figure, which keeps its old value until the chips land (heldStacks).
        const dest = at(ctx, S.stack(participantId)), lands = PAYOUT_LANDS + i * PAYOUT_STAGGER;
        fly(ctx, 'stack', at(ctx, S.pot), dest, { duration: 560, delay: lands - 560, elapsed: el, arc: 30 });
        stay(ctx, 'stack', dest, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.7' }], { duration: 160, delay: lands, elapsed: el, easing: 'linear' });
        reveal(ctx, q(ctx, S.caption(participantId)), { delay: lands - 20, elapsed: el, duration: 160 });
      });
      break;
    }
    case 'sit':
      fadeOutClone(ctx, cue.seat, undefined, 140, el);
      arrive(ctx, cue.seat, 80, el);
      break;
    case 'stand':
      fadeOutClone(ctx, cue.seat, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.94' }], 200, el);
      arrive(ctx, cue.seat, 140, el);
      break;
    case 'move':
      fadeOutClone(ctx, cue.fromSeat, [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.94' }], 200, el);
      fadeOutClone(ctx, cue.seat, undefined, 140, el);
      arrive(ctx, cue.seat, 140, el);
      arrive(ctx, cue.fromSeat, 200, el);
      break;
    case 'chips': {
      // In from the table's edge, while the amount floats up off the stack and the figure rolls to its new total (StackFigure).
      const s = at(ctx, S.stack(cue.participantId));
      fly(ctx, 'stack', s && { x: ctx.stage.clientWidth + 10, y: ctx.stage.clientHeight - 20, w: 0, h: 0 }, s, { duration: 560, arc: 40, elapsed: el, fadeOut: true });
      if (s) stay(ctx, 'label', { ...s, y: s.y - 14 }, [{ opacity: 0, translate: '0px 6px' }, { opacity: 1, translate: '0px -4px', offset: .25 }, { opacity: 1, translate: '0px -8px', offset: .7 }, { opacity: 0, translate: '0px -14px' }], { duration: 1100, elapsed: el, easing: 'linear', text: `+${chips(cue.amount)} chips` });
      break;
    }
    case 'status':
      reveal(ctx, q(ctx, S.caption(cue.participantId)), { duration: 180, elapsed: el });
      reveal(ctx, q(ctx, `${S.body(cue.participantId)} .connection-label`), { duration: 180, elapsed: el });
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
    if (stack !== undefined) rolls.set(cue.participantId, { from: stack - cue.amount, id: `${cue.participantId}@${cue.at}` });
  }
  return { stage, rolls };
}

