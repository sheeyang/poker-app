/** The shareable Join Link: the page origin plus the table's secret token. */
export const joinLink = (origin: string, token: string) => `${origin}/join/${encodeURIComponent(token)}`;
