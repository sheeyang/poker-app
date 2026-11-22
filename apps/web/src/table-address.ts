import { maximumComparedStrategies, strategyFromToken, strategyToken, type JoinLinkPreview, type OpenJoinLinkPreview, type ProtectedJoinLinkPreview, type SavedTable, type StrategyDescriptor, type TableMode } from '@poker/contracts';
import { RequestFailure } from '@poker/client';
import { formatAndStakes, modeLabel } from './table-model.js';

/** Each mode's list: the Practice screen and the Online screen. */
export const listPath = (mode: TableMode) => `/${mode}` as const;
/** A table's one address, under its own mode. */
export const tablePath = (mode: TableMode, tableSessionId: string) => `/${mode}/${tableSessionId}`;
/**
 * A table's Table History: its own screen, under its own address and mode. `hand` opens it at that Hand's replay, and
 * `step` at that Replay Step of it (`stepKey`); a step needs its Hand.
 */
export const historyPath = (mode: TableMode, tableSessionId: string, handId?: string, step?: string, compare?: readonly StrategyDescriptor[]) => {
  const compared = compareParam(compare ?? []);
  return `${tablePath(mode, tableSessionId)}/history${handId ? `?hand=${handId}${step ? `&step=${step}` : ''}${compared ? `&compare=${compared}` : ''}` : ''}`;
};
/**
 * What an address's path names, the inverse of `listPath` and `tablePath`: a mode's section, and the table in it when
 * there is one; undefined outside the two modes. The table ID is as written: whether it names a table is for the server.
 */
export function parseAddress(pathname: string): { readonly mode: TableMode; readonly tableSessionId?: string; readonly history?: true } | undefined {
  const [, first, second, third] = pathname.split('/');
  if (first !== 'practice' && first !== 'online') return undefined;
  if (!second) return { mode: first };
  return third === 'history' ? { mode: first, tableSessionId: second, history: true } : { mode: first, tableSessionId: second };
}

/** An Online Table's Join Link: its own address, which never changes and which anyone at the table can pass on (ADR-0033). */
export const joinLink = (origin: string, tableSessionId: string) => origin + tablePath('online', tableSessionId);

/** The table read as its visitor got it: the table, for a Participant, or "not found" for anyone else. */
type TableRead = { readonly mode: TableMode } | 'not-found';

/**
 * What a table address shows its visitor. Pure: the server alone decides who may see a table, and answers
 * "not found" to anyone who is not one of its Participants, so a Practice Table is never revealed to anyone
 * but its human, whatever mode the address names.
 *
 * - `table`: the visitor is a Participant and the address names the table's own mode.
 * - `corrected`: the visitor is a Participant, but the address names the other mode; replace it with `to`.
 * - `join-form`: the visitor is not at the Online Table the address names, which is its Join Link: they may join it,
 *   or return to it if they left (`preview.returningAs`).
 * - `password-join-form`: the same, at an Online Table with a Table Password: the preview names only the owner, and
 *   joining needs the password.
 * - `missing`: "This table doesn't exist".
 * - `closed`: "This table closed": the Online Table is a Closed Table, which nobody can open or join.
 *
 * Undefined while an Online address waits for its Join Link's preview (`joinPreviewWanted`).
 */
export type TableAddressOutcome =
  | { readonly show: 'table' }
  | { readonly show: 'corrected'; readonly to: string }
  | { readonly show: 'join-form'; readonly preview: OpenJoinLinkPreview }
  | { readonly show: 'password-join-form'; readonly preview: ProtectedJoinLinkPreview }
  | { readonly show: 'missing' }
  | { readonly show: 'closed' };

/** The Join Link's preview as its visitor got it: what it opens, or that there is no Online Table there, or that it closed. */
export type PreviewRead = JoinLinkPreview | 'not-found' | 'closed';

export function tableAddress(routeMode: TableMode, tableSessionId: string, read: TableRead, preview?: PreviewRead): TableAddressOutcome | undefined {
  if (read !== 'not-found') return read.mode === routeMode ? { show: 'table' } : { show: 'corrected', to: tablePath(read.mode, tableSessionId) };
  if (!joinPreviewWanted(routeMode, read)) return { show: 'missing' };
  if (preview === undefined) return undefined;
  if (preview === 'not-found') return { show: 'missing' };
  if (preview === 'closed') return { show: 'closed' };
  return preview.passwordRequired ? { show: 'password-join-form', preview } : { show: 'join-form', preview };
}

/** Whether the address is an Online Table's Join Link to a visitor who is not at it: only then is its preview asked for. */
export const joinPreviewWanted = (routeMode: TableMode, read: TableRead) => routeMode === 'online' && read === 'not-found';

/**
 * Where a refusal to create, join or return to an Online Table sends a Guest who is already at another one: their
 * Current Table, and its format and stakes when their saved tables list it. Undefined for any other failure.
 */
export function currentTableRefusal(error: unknown, saved: readonly SavedTable[] | undefined): { readonly tableSessionId: string; readonly table?: string } | undefined {
  if (!(error instanceof RequestFailure) || error.code !== 'current-table-elsewhere' || !error.currentTableId) return undefined;
  const tableSessionId = error.currentTableId;
  const listed = saved?.find(table => table.tableSessionId === tableSessionId);
  return listed?.seatCount !== undefined && listed.stakes
    ? { tableSessionId, table: formatAndStakes(listed.seatCount, listed.stakes.smallBlind, listed.stakes.bigBlind) } : { tableSessionId };
}

export type AnalysisTab ='live' | 'hand' | 'session';
/** The analysis tab an address names; anything absent or invalid names none, and the current default applies. */
export function analysisTabParam(value: unknown): AnalysisTab | undefined {
  return value === 'live' || value === 'hand' || value === 'session' ? value : undefined;
}
/** The search a table route accepts: `analysis=live|hand|session`. */
export function tableSearch(search: Record<string, unknown>): { analysis?: AnalysisTab } {
  const analysis = analysisTabParam(search.analysis);
  return analysis ? { analysis } : {};
}

/**
 * The Strategies a Counterfactual Comparison holds beside the Reference Strategy, as the address's `compare`: supported
 * Strategies' tokens (`strategyToken`), comma-separated in the order chosen. Anything unsupported or repeated is dropped,
 * and no more than the maximum are kept. Undefined when none are left. Selecting Strategies never touches the Guest's
 * Trainer Configuration: the address is the only place they live.
 */
export function compareParam(strategies: readonly StrategyDescriptor[]): string | undefined {
  const tokens = strategies.map(strategyToken).filter((token, index, all) => strategyFromToken(token) && all.indexOf(token) === index).slice(0, maximumComparedStrategies);
  return tokens.length ? tokens.join(',') : undefined;
}
/** The Strategies a `compare` value names, in order; none for anything that is not a text of supported tokens. */
export function comparedStrategies(compare: unknown): StrategyDescriptor[] {
  if (typeof compare !== 'string') return [];
  const named = compare.split(',').map(strategyFromToken).filter((strategy): strategy is StrategyDescriptor => !!strategy);
  return named.filter((strategy, index) => named.indexOf(strategy) === index).slice(0, maximumComparedStrategies);
}

/**
 * The search a Table History route accepts: `hand=hand-N`, the Hand to replay, and with it `step`, the Replay Step to open
 * it at: `decision-N` (before that decision), `flop`, `turn`, `river` (after that street's reveal) or `result`; and
 * `compare`, the Strategies compared at the reader's decisions (`compareParam`). Both need their Hand.
 */
export function historySearch(search: Record<string, unknown>): { hand?: string; step?: string; compare?: string } {
  if (typeof search.hand !== 'string' || !/^hand-[0-9]+$/.test(search.hand)) return {};
  const compare = compareParam(comparedStrategies(search.compare));
  return {
    hand: search.hand,
    ...(typeof search.step === 'string' && /^(?:decision-[0-9]+|flop|turn|river|result)$/.test(search.step) ? { step: search.step } : {}),
    ...(compare ? { compare } : {}),
  };
}

const app = 'Poker Trainer';
export type Page =
  | { readonly page: 'list'; readonly mode: TableMode }
  | { readonly page: 'table'; readonly seatCount: number; readonly smallBlind: number; readonly bigBlind: number }
  | { readonly page: 'history'; readonly seatCount: number; readonly smallBlind: number; readonly bigBlind: number }
  | { readonly page: 'join'; readonly ownerName: string }
  | { readonly page: 'missing-table' }
  | { readonly page: 'closed-table' }
  | { readonly page: 'not-found' };

/** Each page's browser-tab title: a table goes by its format and stakes, so several open tables can be told apart. */
export function pageTitle(page: Page): string {
  switch (page.page) {
    case 'list': return `${modeLabel(page.mode)} · ${app}`;
    case 'table': return `${formatAndStakes(page.seatCount, page.smallBlind, page.bigBlind)} · ${app}`;
    case 'history': return `Table History · ${formatAndStakes(page.seatCount, page.smallBlind, page.bigBlind)} · ${app}`;
    case 'join': return `Join ${page.ownerName}’s table · ${app}`;
    case 'missing-table': return `Table not found · ${app}`;
    case 'closed-table': return `Table closed · ${app}`;
    case 'not-found': return `Page not found · ${app}`;
  }
}
