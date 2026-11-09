import type { ReactNode } from 'react';

/** Who holds a place in a table preview: the viewer, someone else (a Bot, say), or nobody yet. */
export type SeatMark = 'you' | 'taken' | 'open';

/** Seat `index` of `count` around an oval, the first at the bottom centre, where the viewer sits at the table. */
function around(index: number, count: number) {
  const angle = Math.PI / 2 + index * Math.PI * 2 / count;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** A table's format at a glance: a small oval with one dot per seat. The viewer's seat, when there is one, is brass. */
export function SeatGlyph({ seats, you = false, dim = false }: { seats: number; you?: boolean; dim?: boolean }) {
  const w = 40, h = 25, rx = 16.5, ry = 9.5;
  return <svg className={`seat-glyph${dim ? ' is-dim' : ''}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
    <ellipse className="seat-glyph-felt" cx={w / 2} cy={h / 2} rx={rx - 4} ry={ry - 3.2} />
    {Array.from({ length: seats }, (_, i) => {
      const p = around(i, seats);
      return <circle key={i} className={you && i === 0 ? 'seat-glyph-you' : 'seat-glyph-seat'} cx={w / 2 + p.x * rx} cy={h / 2 + p.y * ry} r={you && i === 0 ? 2.9 : 2.1} />;
    })}
  </svg>;
}

/**
 * The table being made, drawn as the felt it will be: the rail, its inner line, and one place per seat. The
 * viewer's place is brass, taken places are filled and open ones are hollow. Optional content sits on the felt.
 */
export function FeltPreview({ seats, children, label }: { seats: readonly SeatMark[]; children?: ReactNode; label: string }) {
  return <div className="felt-preview" role="img" aria-label={label}>
    <span className="felt-preview-inset" aria-hidden="true" />
    {seats.map((mark, i) => {
      const p = around(i, seats.length);
      return <span key={i} className={`felt-preview-seat is-${mark}`} style={{ left: `calc(50% + ${p.x.toFixed(4)} * (50% + var(--rail) / 2))`, top: `calc(50% + ${p.y.toFixed(4)} * (50% + var(--rail) / 2))` }} aria-hidden="true" />;
    })}
    {children && <div className="felt-preview-centre" aria-hidden="true">{children}</div>}
  </div>;
}
