import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons.js';
/** A modal dialog. Opening focuses the first `[data-autofocus]` descendant, or else the close control. */
export function Dialog({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} onCancel={e => { e.preventDefault(); close(); }} aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={close}><Icon name="close" /></button></div><div className="dialog-content">{children}</div></dialog>;
}
