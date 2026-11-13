/**
 * Table motion on the Web Animations API. Presentation only: nothing here sends, delays or retries a request, and
 * no animation gates a turn, a deadline or a deal (ADR-0038).
 *
 * Every animation takes `elapsed`: how long ago, on the estimated server clock, the moment it presents happened. It
 * becomes the animation's currentTime, so a viewer who arrives late (a reconnect, a hidden tab, a slow device) joins
 * the motion part-way, and one who arrives after it would have finished sees only the end state.
 */
export const EASE = 'cubic-bezier(.16,1,.3,1)';
export const EASE_IN_OUT = 'cubic-bezier(.65,0,.35,1)';
export const EASE_IN = 'cubic-bezier(.5,0,.75,0)';

/** A centre point and a size, in the stage's coordinates. */
export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** Where an anchor rested at the previous commit, and its markup, for motion of things the new state removed. */
export type Snapshot = ReadonlyMap<string, { readonly box: Box; readonly html: string }>;

export interface MotionContext {
  readonly stage: HTMLElement;
  /** The effects layer over the whole table: chips, labels, copies of removed seats. */
  readonly fx: HTMLElement;
  /** The effects layer under the seats, over the felt: travelling cards pass beneath every seat, as real cards sit. */
  readonly under: HTMLElement;
  readonly last: Snapshot;
  /** Keeps an animation so the table can cancel it when it goes away. */
  readonly track: (animation: Animation) => void;
}

export interface Timing { readonly duration: number; readonly delay?: number; readonly elapsed?: number; readonly easing?: string; readonly fill?: FillMode }

export const q = (ctx: MotionContext, selector: string) => ctx.stage.querySelector<HTMLElement>(selector);

/** Centre and size of `node` in stage coordinates; the size is unrotated (a tilted hole card's bounds are larger). */
export function box(ctx: MotionContext, node: Element | null | undefined): Box | undefined {
  if (!node) return undefined;
  const stage = ctx.stage.getBoundingClientRect(), r = node.getBoundingClientRect();
  const w = node instanceof HTMLElement && node.offsetWidth ? node.offsetWidth : r.width;
  const h = node instanceof HTMLElement && node.offsetHeight ? node.offsetHeight : r.height;
  return { x: r.left - stage.left + r.width / 2, y: r.top - stage.top + r.height / 2, w, h };
}
/** Where `selector` is now, or where it was at the previous commit if the new state removed it. */
export const at = (ctx: MotionContext, selector: string) => box(ctx, q(ctx, selector)) ?? ctx.last.get(selector)?.box;

/** Whether a motion starting `delay` after its moment and lasting `duration` is already over `elapsed` after it. */
const over = (t: Timing) => (t.elapsed ?? 0) >= (t.delay ?? 0) + t.duration;

export function play(ctx: MotionContext, node: Element | null | undefined, frames: Keyframe[], t: Timing, pseudoElement?: string): Animation | undefined {
  if (!node || over(t)) return undefined;
  const animation = node.animate(frames, { duration: t.duration, delay: t.delay ?? 0, easing: t.easing ?? EASE, fill: t.fill ?? 'backwards', ...(pseudoElement ? { pseudoElement } : {}) });
  animation.currentTime = t.elapsed ?? 0;
  ctx.track(animation);
  return animation;
}

/**
 * Hidden until `delay`, then fades in over `duration`: a thing arriving where it belongs. A two-faced card fades its
 * faces, not itself: opacity below 1 on the card flattens its 3D faces, which would show the front while it is
 * turned face down for a flip.
 */
export function reveal(ctx: MotionContext, node: Element | null | undefined, t: Omit<Timing, 'duration'> & { readonly duration?: number }) {
  const targets = node?.classList.contains('two-faced') ? Array.from(node.children) : [node];
  for (const target of targets) play(ctx, target, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear', ...t });
}

/**
 * Turns a two-faced card face up about its own axis, inside its tilt (hole cards sit at ±7°): turning the outer
 * frame instead would mirror the tilt while the card is face down.
 */
export function flipUp(ctx: MotionContext, node: Element | null | undefined, t: Timing) {
  if (!node) return;
  const tilt = getComputedStyle(node).transform, base = tilt && tilt !== 'none' ? `${tilt} ` : '';
  play(ctx, node, [{ transform: `${base}rotateY(180deg)` }, { transform: `${base}rotateY(0deg)` }], { easing: EASE_IN_OUT, ...t });
}

export type GhostKind = 'back' | 'small-back' | 'chip' | 'stack' | 'label' | 'clone';
/** A temporary element on an effects layer, centred on `b`, removed when its animation ends or is cancelled. */
function ghost(ctx: MotionContext, kind: GhostKind, b: Box, opts: { readonly text?: string; readonly html?: string; readonly className?: string }) {
  const g = document.createElement('div');
  g.className = `motion-ghost ghost-${kind}${opts.className ? ` ${opts.className}` : ''}`;
  if (kind === 'back' || kind === 'small-back') g.innerHTML = '<span class="card-back-face"></span>';
  if (kind === 'stack') g.innerHTML = '<i></i><i></i><i></i>';
  if (kind === 'label') g.textContent = opts.text ?? '';
  if (kind === 'clone') {
    g.innerHTML = opts.html ?? '';
    // A copy must never answer for the real thing: drop its anchors, and keep it out of the tab order.
    for (const node of Array.from(g.querySelectorAll('*'))) {
      for (const attr of Array.from(node.attributes)) if (attr.name.startsWith('data-') || attr.name === 'id') node.removeAttribute(attr.name);
      if (node instanceof HTMLElement) node.tabIndex = -1;
    }
  }
  g.style.left = `${b.x}px`; g.style.top = `${b.y}px`;
  if (kind === 'back' || kind === 'small-back' || kind === 'clone') { g.style.width = `${b.w}px`; g.style.height = `${b.h}px`; }
  (kind === 'back' || kind === 'small-back' ? ctx.under : ctx.fx).append(g);
  return g;
}
function disposeWith(g: HTMLElement, animation: Animation | undefined) {
  if (!animation) { g.remove(); return; }
  animation.addEventListener('finish', () => g.remove());
  animation.addEventListener('cancel', () => g.remove());
}

/**
 * A ghost travels from `from` to `to`. It sits at its destination and is animated back from the source, so its last
 * frame is exactly where the real thing appears.
 */
export function fly(ctx: MotionContext, kind: GhostKind, from: Box | undefined, to: Box | undefined, t: Timing & { readonly fadeOut?: boolean; readonly spin?: readonly [number, number]; readonly text?: string; readonly scaleFrom?: number; readonly arc?: number }) {
  if (!from || !to || over(t)) return;
  const g = ghost(ctx, kind, to, { text: t.text });
  const s = t.scaleFrom ?? (kind === 'back' || kind === 'small-back' ? from.w / to.w : 1);
  const dx = from.x - to.x, dy = from.y - to.y;
  const [r0, r1] = t.spin ?? [0, 0];
  const mid: Keyframe[] = t.arc ? [{ offset: .5, translate: `${dx / 2}px ${dy / 2 - t.arc}px`, scale: String((s + 1) / 2), rotate: `${(r0 + r1) / 2}deg` }] : [];
  const frames: Keyframe[] = [{ translate: `${dx}px ${dy}px`, scale: String(s), rotate: `${r0}deg`, opacity: 1 }, ...mid, { translate: '0px 0px', scale: '1', rotate: `${r1}deg`, opacity: t.fadeOut ? 0 : 1 }];
  disposeWith(g, play(ctx, g, frames, { fill: 'both', ...t }));
}

/** A ghost that plays in place: a label, a fading copy of something removed. */
export function stay(ctx: MotionContext, kind: GhostKind, b: Box | undefined, frames: Keyframe[], t: Timing & { readonly text?: string; readonly html?: string; readonly className?: string }) {
  if (!b || over(t)) return;
  const g = ghost(ctx, kind, b, { text: t.text, html: t.html, className: t.className });
  disposeWith(g, play(ctx, g, frames, { fill: 'both', ...t }));
}

/** The anchors' boxes and markup as they rest now, keyed `[data-x="value"]`, for the next change to animate what it removes. */
export function snapshot(stage: HTMLElement, attributes: readonly string[]): Map<string, { box: Box; html: string }> {
  const map = new Map<string, { box: Box; html: string }>();
  const ctx = { stage } as MotionContext;
  for (const attribute of attributes) for (const node of Array.from(stage.querySelectorAll<HTMLElement>(`[${attribute}]`))) {
    const b = box(ctx, node);
    if (b) map.set(`[${attribute}="${node.getAttribute(attribute)}"]`, { box: b, html: node.outerHTML });
  }
  return map;
}
