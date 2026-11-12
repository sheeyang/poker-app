import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons.js';
import { useOverlayScrollbar } from './overlay-scroll.js';
/** A modal dialog. Opening focuses the first `[data-autofocus]` descendant, or else the close control. */
export function Dialog({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), scroller = useRef<HTMLDivElement>(null), thumb = useRef<HTMLDivElement>(null);
  useOverlayScrollbar(scroller, thumb);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => dialog.close(); }, []);
  // The dialog has no padding, so a press that lands on the dialog element itself is on the backdrop. Requiring the press to start there too keeps a text selection dragged out of a field from closing it.
  const pressedBackdrop = useRef(false);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} onCancel={e => { e.preventDefault(); close(); }} onPointerDown={e => { pressedBackdrop.current = e.target === e.currentTarget; }} onClick={e => { if (e.target === e.currentTarget && pressedBackdrop.current) close(); }} aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={close}><Icon name="close" /></button></div><div className="dialog-body"><div className="dialog-scroller" ref={scroller}><div className="dialog-content">{children}</div></div><div className="shell-thumb" ref={thumb} hidden aria-hidden="true" /></div></dialog>;
}
