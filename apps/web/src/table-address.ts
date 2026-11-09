import type { TableMode } from '@poker/contracts';
import { chips, modeLabel, tableFormat } from './table-model.js';

/** Each mode's list: the Practice screen and the Online screen. */
export const listPath = (mode: TableMode) => `/${mode}` as const;
/** A table's one address, under its own mode. */
export const tablePath = (mode: TableMode, tableSessionId: string) => `/${mode}/${tableSessionId}`;

/**
 * What a table address shows its visitor. Pure: the server alone decides who may see a table, and answers
 * "not found" to anyone who is not one of its Participants, so a Practice Table is never revealed to anyone
 * but its human, whatever mode the address names.
 *
 * - `table`: the visitor is a Participant and the address names the table's own mode.
 * - `corrected`: the visitor is a Participant, but the address names the other mode; replace it with `to`.
 * - `missing`: "This table doesn't exist".
 */
export type TableAddressOutcome = { readonly show: 'table' } | { readonly show: 'corrected'; readonly to: string } | { readonly show: 'missing' };

export function tableAddress(routeMode: TableMode, tableSessionId: string, read: { readonly mode: TableMode } | 'not-found'): TableAddressOutcome {
  if (read === 'not-found') return { show: 'missing' };
  return read.mode === routeMode ? { show: 'table' } : { show: 'corrected', to: tablePath(read.mode, tableSessionId) };
}

export type AnalysisTab = 'live' | 'hand' | 'session';
/** The analysis tab an address names; anything absent or invalid names none, and the current default applies. */
export function analysisTabParam(value: unknown): AnalysisTab | undefined {
  return value === 'live' || value === 'hand' || value === 'session' ? value : undefined;
}
/** The search a table route accepts: `analysis=live|hand|session`. */
export function tableSearch(search: Record<string, unknown>): { analysis?: AnalysisTab } {
  const analysis = analysisTabParam(search.analysis);
  return analysis ? { analysis } : {};
}

const app = 'Poker Trainer';
export type Page =
  | { readonly page: 'list'; readonly mode: TableMode }
  | { readonly page: 'table'; readonly seatCount: number; readonly smallBlind: number; readonly bigBlind: number }
  | { readonly page: 'missing-table' }
  | { readonly page: 'not-found' };

/** Each page's browser-tab title: a table goes by its format and stakes, so several open tables can be told apart. */
export function pageTitle(page: Page): string {
  switch (page.page) {
    case 'list': return `${modeLabel(page.mode)} · ${app}`;
    case 'table': return `${tableFormat(page.seatCount)} Hold’em ${chips(page.smallBlind)}/${chips(page.bigBlind)} · ${app}`;
    case 'missing-table': return `Table not found · ${app}`;
    case 'not-found': return `Page not found · ${app}`;
  }
}
