import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons.js';
import { EASE_IN } from './motion.js';
import { useOverlayScrollbar } from './overlay-scroll.js';
/** A modal dialog. Opening focuses the first `[data-autofocus]` descendant, or else the close control. */
export function Dialog({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), scroller = useRef<HTMLDivElement>(null), thumb = useRef<HTMLDivElement>(null);
  useOverlayScrollbar(scroller, thumb);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => dialog.close(); }, []);
  // Closing from the dialog itself sinks it and fades its backdrop, faster than it rose, then closes. If the owner keeps
  // it open after all, it comes back.
  const leaving = useRef(false);
  const leave = () => {
    const dialog = ref.current;
    if (!dialog || leaving.current) return;
    leaving.current = true;
    const out = { duration: 160, easing: EASE_IN, fill: 'forwards' as const };
    const animations = [dialog.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 8px' }], out), dialog.animate([{ opacity: 1 }, { opacity: 0 }], { ...out, duration: 120, pseudoElement: '::backdrop' })];
    animations[0]!.onfinish = () => {
      close();
      requestAnimationFrame(() => { if (dialog.isConnected) { for (const animation of animations) animation.cancel(); leaving.current = false; } });
    };
  };
  // The dialog has no padding, so a press that lands on the dialog element itself is on the backdrop. Requiring the press to start there too keeps a text selection dragged out of a field from closing it.
  const pressedBackdrop = useRef(false);
  // biome-ignore lint/a11y/useKeyWithClickEvents: Backdrop click is a pointer-only shortcut; keyboard users close with Escape (onCancel) or the Close button.
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} onCancel={e => { e.preventDefault(); leave(); }} onPointerDown={e => { pressedBackdrop.current = e.target === e.currentTarget; }} onClick={e => { if (e.target === e.currentTarget && pressedBackdrop.current) leave(); }} aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={leave}><Icon name="close" /></button></div><div className="dialog-body"><div className="dialog-scroller" ref={scroller}><div className="dialog-content">{children}</div></div><div className="shell-thumb" ref={thumb} hidden aria-hidden="true" /></div></dialog>;
}
