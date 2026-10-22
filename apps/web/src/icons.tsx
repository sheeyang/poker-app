const paths = {
  spade: 'M12 3C9 7 3 10 3 14a5 5 0 0 0 8 4c0 2-1 3-2 4h6c-1-1-2-2-2-4a5 5 0 0 0 8-4c0-4-6-7-9-11Z',
  settings: 'M4 7h16M4 17h16M9 4v6m6 4v6',
  chart: 'M4 20V4m0 16h17M9 15v-4m5 4V6m5 9v-6',
  close: 'm6 6 12 12M6 18 18 6',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  chevron: 'm9 5 7 7-7 7',
  tables: 'M3 6h18v12H3zM8 6v12m8-12v12',
  cards: 'M4 4h11v16H4zM15 6l5 1-2 13-3-1',
  info: 'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check: 'm5 12 4 4L19 6',
  exit: 'M9 4H4v16h5m5-13 5 5-5 5m-5-5h13',
} as const;
export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
