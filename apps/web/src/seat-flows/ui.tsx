import type { ReactNode } from 'react';

export function Icon({ name, size = 18 }: { name: 'arrow' | 'reset' | 'close' | 'chevron' | 'check' | 'spade' | 'settings' | 'plus'; size?: number }) {
  const paths = { arrow: <path d="M4 12h15m-6-6 6 6-6 6" />, reset: <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />, close: <path d="m6 6 12 12M6 18 18 6" />, chevron: <path d="m9 5 7 7-7 7" />, check: <path d="m5 12 4 4L19 6" />, spade: <path d="M12 2C9 7 3 9 3 14a4 4 0 0 0 7 2c0 3-1 5-3 6h10c-2-1-3-3-3-6a4 4 0 0 0 7-2c0-5-6-7-9-12Z" />, settings: <path d="M4 7h16M4 17h16M8 4v6m8 4v6" /> };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name === 'plus' ? <path d="M12 5v14M5 12h14" /> : paths[name]}</svg>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
