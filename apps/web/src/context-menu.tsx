import { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.js';
import { menuLeaves, registerMenu } from './overlay-motion.js';

export interface ContextMenuItem { id: string; label: string; disabled?: boolean; reason?: string; action: () => void }

/**
 * A top-layer menu, positioned beside its trigger rather than clipped by the table or analysis layout. It grows out of
 * its trigger and, however it closes (Escape, a press elsewhere, a chosen item), shrinks back into it.
 */
export function ContextMenu({ anchor, title, items, close }: { anchor: HTMLElement; title: string; items: ContextMenuItem[]; close: (restore?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null), id = useId();
  const dismiss = useRef(close); dismiss.current = close;
  useLayoutEffect(() => {
    const menu = ref.current!;
    let unmounting = false;
    registerMenu(menu, anchor);
    // Fires while the menu is still shown, for every way it closes.
    const leaving = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') menuLeaves(menu, unmounting); };
    menu.addEventListener('beforetoggle', leaving);
    menu.showPopover();
    const place = () => {
      if (!anchor.isConnected) { dismiss.current(false); return; }
      const target = anchor.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
      const below = target.bottom + 8, above = target.top - bounds.height - 8;
      const left = Math.max(12, Math.min(target.left, innerWidth - bounds.width - 12)), under = below + bounds.height <= innerHeight - 12;
      menu.style.left = `${left}px`;
      menu.style.top = `${under ? below : Math.max(12, above)}px`;
      // The menu grows out of the thing it belongs to.
      menu.style.transformOrigin = `${target.left + target.width / 2 - left}px ${under ? 0 : bounds.height}px`;
    };
    place();
    menu.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place); observer.observe(menu);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      unmounting = true;
      if (menu.matches(':popover-open')) menu.hidePopover();
      menu.removeEventListener('beforetoggle', leaving);
    };
  }, [anchor]);
  const enabled = items.findIndex(item => !item.disabled);
  return createPortal(<div ref={ref} popover="auto" className="context-menu" onToggle={event => { if (event.newState === 'closed') close(false); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') { close(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}><div className="context-menu-heading"><strong id={id}>{title}</strong><button className="icon-button" aria-label="Close actions" onClick={() => close()}><Icon name="close" size={16} /></button></div><div role="menu" aria-labelledby={id}>{items.length ? items.map((item, index) => <button role="menuitem" tabIndex={index === enabled ? 0 : -1} key={item.id} disabled={item.disabled} onClick={item.action}>{item.label}{item.reason && <small>{item.reason}</small>}</button>) : <p className="muted">No actions available.</p>}</div></div>, document.body);
}
