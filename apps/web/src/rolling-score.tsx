import { useLayoutEffect, useRef, useState } from 'react';

/** Presentation only: all values are confirmed server scores, never interpolated scores. */
export function RollingScore({ value, memory, identity }: { value?: number; memory?: Map<string, string>; identity: string }) {
  const next = value === undefined ? undefined : (value * 100).toFixed(1).padStart(5, '\u2007');
  const localMemory = useRef(new Map<string, string>()).current;
  const seen = memory ?? localMemory;
  const [transition, setTransition] = useState<{ from: string; to: string; sequence: number }>();
  const sequence = useRef(0);
  useLayoutEffect(() => {
    if (!next) { setTransition(undefined); return; }
    const from = seen.get(identity) ?? '\u2007'.repeat(5);
    seen.set(identity, next);
    if (from === next) { setTransition(undefined); return; }
    setTransition({ from, to: next, sequence: ++sequence.current });
    const timer = setTimeout(() => setTransition(undefined), 300);
    return () => clearTimeout(timer);
  }, [next, identity, seen]);
  if (!next) return <>—</>;
  return <><span className="rolling-number" aria-hidden="true">{[...next].map((digit, index) => {
    const changing = digit !== '.' && transition?.to === next && transition.from[index] !== digit;
    return <span className={`score-digit${digit === '.' ? ' decimal' : ''}${changing ? ' changing' : ''}`} key={`${index}/${changing ? transition.sequence : 'steady'}`}><span className="digit-static">{digit}</span>{changing && <><span className="digit-out">{transition.from[index]}</span><span className="digit-in">{digit}</span></>}</span>;
  })}</span><span className="visually-hidden">{next.trim()}</span></>;
}
