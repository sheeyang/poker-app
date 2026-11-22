import { useEffect, useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api, RequestFailure, retainNewestTable } from '@poker/client';
import type { TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { Card } from './cards.js';
import { SeatGlyph } from './felt.js';
import { Skeleton } from './loading-skeleton.js';
import { usePageTitle, useShell } from './app-shell.js';
import { usePresentation } from './use-presentation.js';
import { handRows, returnBar, type HandRow } from './table-history.js';
import { historyPath, historySearch, listPath } from './table-address.js';
import { blindsLabel, modeLabel, tableFormat } from './table-model.js';

/** A link back to a table's own page. */
function TableLink({ mode, tableSessionId, className, children }: { mode: TableMode; tableSessionId: string; className?: string; children: React.ReactNode }) {
  return mode === 'online'
    ? <Link className={className} to="/online/$tableSessionId" params={{ tableSessionId }}>{children}</Link>
    : <Link className={className} to="/practice/$tableSessionId" params={{ tableSessionId }}>{children}</Link>;
}

/** A link into a table's Table History, at one Hand when given. */
export function HistoryLink({ mode, tableSessionId, handId, className, children }: { mode: TableMode; tableSessionId: string; handId?: string; className?: string; children: React.ReactNode }) {
  const search = handId ? { hand: handId } : {};
  return mode === 'online'
    ? <Link className={className} to="/online/$tableSessionId/history" params={{ tableSessionId }} search={search}>{children}</Link>
    : <Link className={className} to="/practice/$tableSessionId/history" params={{ tableSessionId }} search={search}>{children}</Link>;
}

function HandEntry({ row, selected }: { row: HandRow; selected: boolean }) {
  return <li id={row.key} className="history-hand" data-selected={selected ? '' : undefined} aria-current={selected ? 'true' : undefined}>
    <div className="history-hand-head">
      <h2>{row.label}</h2>
      {row.completed && <span className="history-time numeric">{row.completed}</span>}
      <span className={`history-tag${row.dealtIn ? ' is-dealt-in' : ''}`}>{row.dealtIn ? 'You were dealt in' : 'You watched'}</span>
    </div>
    <div className="history-board" role="group" aria-label={row.board.length ? 'Final board' : 'No board was dealt'}>
      {row.board.length ? row.board.map(card => <Card key={card} card={card} small />) : <span className="history-muted">No board</span>}
    </div>
    <ul className="history-players" aria-label="Dealt in">{row.players.map(player => <li key={player.participantId}>
      <span className="history-player-name">{player.name}</span>
      {player.cards && <span className="history-player-cards" role="group" aria-label={`${player.name === 'You' ? 'Your' : `${player.name}’s`} cards`}>{player.cards.map(card => <Card key={card} card={card} small />)}</span>}
    </li>)}</ul>
    <p className="history-result"><strong>{row.result}</strong><span>{row.ending}</span></p>
  </li>;
}

function HistorySkeleton() {
  return <div className="history-list" role="status" aria-label="Loading Table History"><div aria-hidden="true">{[0, 1, 2].map(i => <div className="history-hand history-hand-skeleton" key={i}><Skeleton className="skeleton-hand-status" /><Skeleton className="skeleton-action" /><Skeleton className="skeleton-action" /></div>)}</div></div>;
}

/**
 * A table's Table History, `/practice/<id>/history` or `/online/<id>/history`: every completed Hand of the Table
 * Session, newest first, as the viewer may see it. It is its own screen, so opening it from a live table leaves play:
 * while the viewer is seated, a "Your turn" bar follows them here whenever their Action Window opens, with their Action
 * Deadline running beside it. A later reading of one Hand (Replay) opens from a row and keeps its address.
 */
export function TableHistoryScreen({ mode, tableSessionId }: { mode: TableMode; tableSessionId: string }) {
  const { identity } = useShell();
  const navigate = useNavigate();
  const selectedHand = historySearch(useSearch({ strict: false })).hand;
  // The shell's live connection keeps this table current; its view tells the viewer's turn and names the table.
  const read = useQuery({ queryKey: ['table-session', tableSessionId], queryFn: ({ signal }) => api.readSession(tableSessionId, signal), enabled: identity.isSuccess, structuralSharing: retainNewestTable });
  const table = read.data;
  const answered = read.isSuccess || read.isError;
  const completedHands = table?.view.history.filter(hand => hand.result).length;
  // A Hand that completes while the screen is open is read in: the key changes with the count.
  const list = useQuery({ queryKey: ['table-history', tableSessionId, completedHands], queryFn: ({ signal }) => api.readTableHistory(tableSessionId, signal), enabled: identity.isSuccess && answered, placeholderData: keepPreviousData });
  const presentation = usePresentation(table, table?.viewerParticipantId);
  const bar = table && presentation ? returnBar(table, presentation.serverNow) : undefined;
  const missing = (read.error instanceof RequestFailure && read.error.code === 'not-found') || (list.error instanceof RequestFailure && list.error.code === 'not-found');
  const rows = useMemo(() => list.data ? handRows(list.data.hands, list.data.viewerParticipantId) : undefined, [list.data]);
  const correctedTo = table && table.mode !== mode ? historyPath(table.mode, tableSessionId, selectedHand) : undefined;
  useEffect(() => { if (correctedTo) void navigate({ href: correctedTo, replace: true }); }, [correctedTo, navigate]);
  useEffect(() => { if (rows && selectedHand) document.getElementById(selectedHand)?.scrollIntoView({ block: 'center' }); }, [rows, selectedHand]);
  usePageTitle(table ? { page: 'history', ...table.view.configuration } : missing ? { page: 'missing-table' } : undefined);
  if (missing) return <main id="main-table" className="address-missing">
    <Icon name="cards" size={34} />
    <h1>This table doesn’t exist.</h1>
    <p>Check the address you were given. A table’s history opens only for the people who have played at it.</p>
    <Link className="primary address-missing-link" to={listPath(mode)}>Go to {modeLabel(mode)} tables <Icon name="arrow" size={18} /></Link>
  </main>;
  const configuration = table?.view.configuration;
  return <>
    {bar && <aside className="live-strip is-turn history-return" aria-label="Your turn">
      <span className="live-strip-dot" aria-hidden="true" />
      <p className="live-strip-facts"><strong aria-live="polite">Your turn — return</strong>
        {bar.countdown !== undefined && <span className={`history-deadline numeric${bar.countdown <= 5 ? ' deadline-near' : ''}`} role="timer"><strong>{bar.countdown > 0 ? `${bar.countdown}s` : 'Time’s up'}</strong>{bar.countdown > 0 ? ' to act' : ''}</span>}
      </p>
      <div className="live-strip-actions"><TableLink className="live-strip-back" mode={mode} tableSessionId={tableSessionId}>Return to table<Icon name="arrow" size={16} /></TableLink></div>
    </aside>}
    <main id="main-table" className="history-page">
      <header className="history-heading">
        <TableLink className="history-back" mode={mode} tableSessionId={tableSessionId}><span className="history-back-arrow"><Icon name="arrow" size={16} /></span>Back to table</TableLink>
        <h1>Table History</h1>
        {configuration && table && <p>{tableFormat(configuration.seatCount)} Hold’em · {blindsLabel(configuration.smallBlind, configuration.bigBlind)} · {modeLabel(table.mode)}{rows ? ` · ${rows.length} ${rows.length === 1 ? 'hand' : 'hands'}` : ''}</p>}
      </header>
      {(read.isError || list.isError) && !table && <div className="notice-error" role="alert"><p>{(list.error ?? read.error)?.message}</p><button onClick={() => { void read.refetch(); void list.refetch(); }}>Retry</button></div>}
      {list.isError && table && <div className="notice-error" role="alert"><p>{list.error.message}</p><button onClick={() => void list.refetch()}>Retry</button></div>}
      {!rows && !list.isError && !(read.isError && !table) && <HistorySkeleton />}
      {rows?.length === 0 && <div className="ledger-empty"><SeatGlyph seats={configuration?.seatCount ?? 6} /><div><h3>No completed hands yet</h3><p>A Hand appears here as soon as it is complete.</p></div></div>}
      {rows && rows.length > 0 && <ol className="history-list" aria-label="Completed hands, newest first">{rows.map(row => <HandEntry key={row.key} row={row} selected={row.key === selectedHand} />)}</ol>}
    </main>
  </>;
}
