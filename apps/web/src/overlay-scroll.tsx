import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/**
 * A scroll area whose scrollbar floats over the content instead of taking a column beside it, so the page never
 * shifts sideways when it grows past the viewport. The native bar is hidden; the thumb is drawn here and dragged here.
 * Keyboard, wheel and touch scrolling stay native.
 */
/** Breathing room above and below the thumb, so it never touches the header or the live strip above it. */
const INSET = 10;

export function useOverlayScrollbar(scroller: RefObject<HTMLElement | null>, thumb: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const area = scroller.current, bar = thumb.current;
    if (!area || !bar) return;
    let idle: number | undefined;
    const place = () => {
      const { scrollTop, scrollHeight, clientHeight } = area;
      const scrollable = scrollHeight > clientHeight + 1;
      bar.hidden = !scrollable;
      if (!scrollable) return;
      const track = clientHeight - 2 * INSET, height = Math.max(36, track * clientHeight / scrollHeight);
      bar.style.height = `${height}px`;
      bar.style.transform = `translateY(${INSET + scrollTop / (scrollHeight - clientHeight) * (track - height)}px)`;
    };
    const reveal = () => { bar.dataset.active = ''; window.clearTimeout(idle); idle = window.setTimeout(() => { if (!bar.matches(':hover') && !bar.dataset.drag) delete bar.dataset.active; }, 900); };
    const onScroll = () => { place(); reveal(); };
    const observer = new ResizeObserver(place);
    observer.observe(area);
    if (area.firstElementChild) observer.observe(area.firstElementChild);
    area.addEventListener('scroll', onScroll, { passive: true });
    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      bar.setPointerCapture(event.pointerId);
      bar.dataset.drag = '';
      const startY = event.clientY, startTop = area.scrollTop;
      const move = (e: PointerEvent) => {
        const room = area.clientHeight - 2 * INSET - bar.offsetHeight;
        area.scrollTop = startTop + (e.clientY - startY) * (area.scrollHeight - area.clientHeight) / Math.max(1, room);
      };
      const up = () => { delete bar.dataset.drag; bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); reveal(); };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
    };
    bar.addEventListener('pointerdown', onDown);
    place();
    return () => { observer.disconnect(); area.removeEventListener('scroll', onScroll); bar.removeEventListener('pointerdown', onDown); window.clearTimeout(idle); };
  }, [scroller, thumb]);
}

export function OverlayScroll({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null), thumb = useRef<HTMLDivElement>(null);
  useOverlayScrollbar(scroller, thumb);
  return <div className="shell-body">
    <div className="shell-scroller" ref={scroller}><div className="shell-content">{children}</div></div>
    <div className="shell-thumb" ref={thumb} hidden aria-hidden="true" />
  </div>;
}
