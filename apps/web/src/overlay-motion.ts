import { EASE, EASE_IN } from './motion.js';

/**
 * Overlays return to what opened them (ADR-0038). A menu grows out of its trigger and shrinks back into it; a dialog
 * grows out of the control that opened it (a menu item hands off: the dialog grows out of the menu) and shrinks back
 * into that control, or into the seat whose menu opened it; a notice the app removes folds away, so the ones below
 * slide up.
 *
 * Every close plays its exit, whoever closes it: the overlay's owner unmounts it at once (focus, state and the next
 * thing on screen never wait), and an inert copy of it plays the exit where it stood.
 */

interface Press { readonly from: DOMRect; readonly back: Element; readonly menu?: Element; readonly at: number }
let lastPress: Press | undefined;
/** Each open menu's trigger, so a dialog opened from one of its items can return to it. */
const anchors = new WeakMap<Element, Element>();
/** Menus whose chosen item opened a dialog: they fade and let the dialog grow out of them. */
const handedOff = new WeakSet<Element>();

if (typeof document !== 'undefined') document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button, [role="menuitem"], a') : null;
  if (!target) return;
  const menu = target.closest('.context-menu') ?? undefined;
  lastPress = { from: (menu ?? target).getBoundingClientRect(), back: (menu && anchors.get(menu)) ?? target, ...(menu ? { menu } : {}), at: performance.now() };
}, true);

export function registerMenu(menu: Element, anchor: Element) { anchors.set(menu, anchor); }

/** Where an overlay opening now comes from: the control pressed just before, if any. */
export function overlayOrigin(): Press | undefined {
  return lastPress && performance.now() - lastPress.at < 1000 ? lastPress : undefined;
}

/** Maps `box` onto `to`, scaled from its top-left corner. */
const onto = (box: DOMRect, to: DOMRect) => `translate(${to.left - box.left}px, ${to.top - box.top}px) scale(${to.width / box.width}, ${to.height / box.height})`;
const usable = (r: DOMRect | undefined) => !!r && r.width > 0 && r.height > 0;

/**
 * An inert copy of `node` standing exactly where it is, outside the top layer, for its exit. Measured now, while the
 * node is on screen; shown only once the node has really gone (StrictMode unmounts and remounts in development).
 */
function copyOf(node: HTMLElement) {
  const rect = node.getBoundingClientRect(), copy = node.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) { el.removeAttribute('id'); el.removeAttribute('popover'); el.removeAttribute('data-autofocus'); }
  copy.classList.add('overlay-copy');
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  Object.assign(copy.style, { position: 'fixed', inset: 'auto', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', maxWidth: 'none', maxHeight: 'none' });
  return { copy, rect };
}
/** Runs `exit` once `node` has left the page in the change that is unmounting it. */
const once = (node: Element, exit: () => void) => queueMicrotask(() => { if (!node.isConnected) exit(); });

/** A dialog opening: it grows out of what opened it, or, opened by the app, rises into place. */
export function dialogEnters(dialog: HTMLDialogElement, origin: Press | undefined) {
  if (origin?.menu) handedOff.add(origin.menu);
  // Measured where it rests: an entrance already running (StrictMode mounts twice) would report its shrunken box.
  for (const animation of dialog.getAnimations()) animation.cancel();
  const box = dialog.getBoundingClientRect();
  if (origin && usable(origin.from)) {
    dialog.animate([{ transformOrigin: 'top left', transform: onto(box, origin.from), opacity: .3 }, { transformOrigin: 'top left', transform: 'none', opacity: 1 }], { duration: 300, easing: EASE });
    dialog.querySelector('.dialog-body')?.animate([{ opacity: 0 }, { opacity: 0, offset: .35 }, { opacity: 1 }], { duration: 300, easing: 'linear' });
  } else dialog.animate([{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }], { duration: 240, easing: EASE });
  dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'linear', pseudoElement: '::backdrop' });
}

/** A dialog closing, called while it is still on screen: a copy shrinks back into what opened it (or sinks, with nowhere to go). */
export function dialogLeaves(dialog: HTMLDialogElement, origin: Press | undefined) {
  if (!dialog.open) return;
  const { copy, rect } = copyOf(dialog);
  copy.setAttribute('open', '');
  once(dialog, () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-copy-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.append(backdrop, copy);
    const to = origin?.back.isConnected ? origin.back.getBoundingClientRect() : undefined;
    const out = { duration: usable(to) ? 220 : 160, easing: EASE_IN, fill: 'forwards' as const };
    const animation = usable(to)
      ? copy.animate([{ transformOrigin: 'top left', transform: 'none', opacity: 1 }, { transformOrigin: 'top left', transform: onto(rect, to!), opacity: 0 }], out)
      : copy.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 8px' }], out);
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { ...out, easing: 'linear' });
    const done = () => { copy.remove(); backdrop.remove(); };
    animation.addEventListener('finish', done);
    animation.addEventListener('cancel', done);
  });
}

/**
 * A menu closing, called while it is still on screen: a copy shrinks back into its trigger, or fades if it handed off
 * to a dialog. `unmounting`: its owner is removing it, so the copy waits until it has gone; otherwise the browser
 * dismissed it (a press elsewhere) and the copy shows at once.
 */
export function menuLeaves(menu: HTMLElement, unmounting: boolean) {
  if (!menu.matches(':popover-open')) return;
  const { copy } = copyOf(menu);
  copy.style.transformOrigin = menu.style.transformOrigin;
  const show = () => document.body.append(copy);
  if (unmounting) once(menu, show); else show();
  // A dialog its item opened mounts in this same change; wait a frame to know.
  requestAnimationFrame(() => {
    if (!copy.isConnected) return;
    const out = { easing: EASE_IN, fill: 'forwards' as const };
    const animation = handedOff.has(menu)
      ? copy.animate([{ opacity: 1 }, { opacity: 0 }], { ...out, duration: 140 })
      : copy.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.35' }], { ...out, duration: 200 });
    animation.addEventListener('finish', () => copy.remove());
    animation.addEventListener('cancel', () => copy.remove());
  });
}

/**
 * Notices the app removes from `container` fold away: the removed notice is put back where it stood, inert, and its
 * height closes so the notices below slide up. Returns a function that stops watching.
 */
export function foldRemovedNotices(container: HTMLElement) {
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.removedNodes)) {
      // Skips a notice React only moved, and one already leaving.
      if (!(node instanceof HTMLElement) || node.isConnected || node.dataset.leaving !== undefined) continue;
      const after = record.nextSibling?.parentNode === container ? record.nextSibling : null;
      node.dataset.leaving = '';
      node.inert = true;
      container.insertBefore(node, after);
      const cs = getComputedStyle(node), height = node.offsetHeight, gap = getComputedStyle(container).rowGap;
      node.style.overflow = 'hidden';
      const animation = node.animate([
        { opacity: 1, height: `${height}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, marginBottom: '0px' },
        { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', marginBottom: gap === 'normal' ? '0px' : `-${gap}` },
      ], { duration: 240, easing: EASE, fill: 'forwards' });
      animation.addEventListener('finish', () => node.remove());
      animation.addEventListener('cancel', () => node.remove());
    }
  });
  observer.observe(container, { childList: true });
  return () => observer.disconnect();
}
