import { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.js';
import { EASE_IN } from './motion.js';

export interface ContextMenuItem { id: string; label: string; disabled?: boolean; reason?: string; action: () => void }

/** A top-layer menu, positioned beside its trigger rather than clipped by the table or analysis layout. */
export function ContextMenu({ anchor, title, items, close }: { anchor: HTMLElement; title: string; items: ContextMenuItem[]; close: (restore?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null), id = useId();
  const dismiss = useRef(close); dismiss.current = close;
  useLayoutEffect(() => {
    const menu = ref.current!;
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
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (menu.matches(':popover-open')) menu.hidePopover(); };
  }, [anchor]);
  const enabled = items.findIndex(item => !item.disabled);
  // Dismissed from the menu itself, it shrinks back towards its trigger, faster than it grew, then closes.
  const leaving = useRef(false);
  const leave = (restore?: boolean) => {
    const menu = ref.current;
    if (!menu || leaving.current) { close(restore); return; }
    leaving.current = true;
    const animation = menu.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.97' }], { duration: 120, easing: EASE_IN, fill: 'forwards' });
    animation.onfinish = () => {
      close(restore);
      requestAnimationFrame(() => { if (menu.isConnected) { animation.cancel(); leaving.current = false; } });
    };
  };
  return createPortal(<div ref={ref} popover="auto" className="context-menu" onToggle={event => { if (event.newState === 'closed') close(false); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); leave(); return; }
    if (event.key === 'Tab') { close(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}><div className="context-menu-heading"><strong id={id}>{title}</strong><button className="icon-button" aria-label="Close actions" onClick={() => leave()}><Icon name="close" size={16} /></button></div><div role="menu" aria-labelledby={id}>{items.length ? items.map((item, index) => <button role="menuitem" tabIndex={index === enabled ? 0 : -1} key={item.id} disabled={item.disabled} onClick={item.action}>{item.label}{item.reason && <small>{item.reason}</small>}</button>) : <p className="muted">No actions available.</p>}</div></div>, document.body);
}
