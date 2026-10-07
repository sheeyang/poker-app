import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultConfiguration, baselinePlayingStrategy, type ObservableGameConfiguration } from '@poker/contracts';
import { api, RequestFailure } from './api.js';
import { usePlayground } from './store.js';

const chipFields = [
  ['smallBlind', 'Small blind'], ['bigBlind', 'Big blind'], ['ante', 'Ante'],
  ['minimumBuyIn', 'Minimum buy-in'], ['defaultBuyIn', 'Default buy-in'], ['maximumBuyIn', 'Maximum buy-in'],
] as const;
function ErrorMessage({ error }: { error: Error | null }) {
  return error ? <p role="alert" className="error">{error.message}</p> : null;
}
export function Playground() {
  const queryClient = useQueryClient();
  const selectedId = usePlayground(state => state.selectedTableSessionId);
  const select = usePlayground(state => state.select);
  const pending = usePlayground(state => state.pendingCreation);
  const setPending = usePlayground(state => state.setPendingCreation);
  const [configuration, setConfiguration] = useState<ObservableGameConfiguration>({ ...defaultConfiguration });
  const [botCount, setBotCount] = useState(2);
  const [reopenId, setReopenId] = useState('');
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity, staleTime: Infinity });
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: identity.isSuccess });
  const table = useQuery({ queryKey: ['table-session', selectedId], queryFn: () => api.readSession(selectedId!), enabled: identity.isSuccess && !!selectedId });
  const creation = useMutation({
    mutationFn: api.createSession,
    onSuccess: async result => {
      setPending(null);
      select(result.tableSessionId);
      await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
    },
    onError: error => { if (error instanceof RequestFailure && error.definitive) setPending(null); },
  });
  function create(event: FormEvent) {
    event.preventDefault();
    const request = {
      requestId: crypto.randomUUID(), configuration,
      bots: Array.from({ length: botCount }, (_, index) => ({ name: 'Bot ' + (index + 1), playingStrategy: baselinePlayingStrategy })),
    };
    setPending(request);
    creation.mutate(request);
  }
  function reopen(event: FormEvent) {
    event.preventDefault();
    if (reopenId.trim()) select(reopenId.trim());
  }
  return <div className="app-shell">
    <header className="page-header">
      <h1>Poker Playground</h1>
      <p>Create and reopen continuing Table Sessions.</p>
      <span className="connection-status" role="status">{identity.isSuccess ? 'Local identity ready' : identity.isError ? 'Server unavailable' : 'Connecting to server…'}</span>
    </header>
    <ErrorMessage error={identity.error} />
    <main className="workspace">
      <aside className="controls">
        <section>
          <h2>Create Table Session</h2>
          <p className="help">Settings remain fixed for this Table Session. Chip amounts use integer units.</p>
          <form onSubmit={create}>
            <fieldset disabled={creation.isPending || !!pending || !identity.isSuccess}>
              <label>Seats
                <input name="seatCount" type="number" min="2" max="9" step="1" required value={configuration.seatCount}
                  onChange={event => { const seatCount = Number(event.target.value); setConfiguration({ ...configuration, seatCount }); setBotCount(Math.min(botCount, Math.max(0, seatCount - 1))); }} />
              </label>
              <div className="field-pairs">{chipFields.map(([field, label]) => <label key={field}>{label}
                <input name={field} type="number" min={field === 'smallBlind' ? '1' : '0'} step="1" required value={configuration[field]}
                  onChange={event => setConfiguration({ ...configuration, [field]: Number(event.target.value) })} />
              </label>)}</div>
              <label className="checkbox"><input name="allowSeatChanges" type="checkbox" checked={configuration.allowSeatChanges}
                onChange={event => setConfiguration({ ...configuration, allowSeatChanges: event.target.checked })} />Allow seat changes between Hands</label>
              <label>Configured Bots
                <input name="botCount" type="number" min="0" max={Math.max(0, configuration.seatCount - 1)} step="1" required value={botCount} onChange={event => setBotCount(Number(event.target.value))} />
              </label>
              <p className="help">Participants are allocated now. Seating and play follow after table setup.</p>
              <button type="submit" className="primary">Create Table Session</button>
            </fieldset>
          </form>
          {creation.isPending && <p role="status">Committing Table Session…</p>}
          <ErrorMessage error={creation.error} />
          {pending && !creation.isPending && <div className="pending-attempt">
            <p>Creation has not been confirmed. Refresh owned sessions or retry the same creation attempt.</p>
            <button onClick={() => creation.mutate(pending)}>Retry creation</button>
            <button onClick={() => { setPending(null); creation.reset(); }}>Start a new creation attempt</button>
          </div>}
        </section>
        <section className="reopen">
          <h2>Reopen Table Session</h2>
          <form onSubmit={reopen}>
            <label>Table Session ID<input name="tableSessionId" type="text" value={reopenId} onChange={event => setReopenId(event.target.value)} placeholder="Paste a Table Session ID" /></label>
            <button type="submit" disabled={!reopenId.trim() || !identity.isSuccess}>Reopen session</button>
          </form>
          <div className="list-heading"><h3>Owned sessions</h3><button onClick={() => void sessions.refetch()} disabled={!identity.isSuccess}>Refresh</button></div>
          <ErrorMessage error={sessions.error} />
          {sessions.isLoading && <p role="status">Loading owned sessions…</p>}
          {sessions.data?.tableSessionIds.length === 0 && <p className="help">Your created Table Sessions will appear here.</p>}
          <ul className="session-list">{sessions.data?.tableSessionIds.map(id => <li key={id}><button className={id === selectedId ? 'selected' : ''} onClick={() => select(id)} aria-current={id === selectedId ? 'true' : undefined}>{id}</button></li>)}</ul>
        </section>
      </aside>
      <section className="table-view" aria-label="Current Table Session">
        {table.isFetching && <p role="status">Loading Table Session…</p>}
        <ErrorMessage error={table.error} />
        {table.data ? <>
          <div className="table-heading"><h2>Table Session</h2><button onClick={() => void table.refetch()}>Refresh view</button></div>
          <p className="session-id">{table.data.tableSessionId}</p>
          <dl className="table-facts">
            <div><dt>Blinds</dt><dd>{table.data.view.configuration.smallBlind} / {table.data.view.configuration.bigBlind}</dd></div>
            <div><dt>Ante</dt><dd>{table.data.view.configuration.ante}</dd></div>
            <div><dt>Button</dt><dd>Seat {table.data.view.state.buttonSeat}</dd></div>
            <div><dt>Committed revisions</dt><dd>Poker {table.data.pokerRevision} · Session {table.data.sessionRevision}</dd></div>
          </dl>
          <div className="empty-table"><h3>Empty table</h3><p>No participants are seated. The Table Session is saved and ready for table setup.</p></div>
          <ol className="seats">{Array.from({ length: table.data.view.configuration.seatCount }, (_, index) => <li key={index}><span>Seat {index + 1}</span><strong>Empty</strong></li>)}</ol>
          <h3>Participants</h3>
          <ul className="bindings">{table.data.bindings.map(binding => <li key={binding.participantId}><strong>{binding.name}</strong><span>{binding.controller.kind === 'human' ? 'Human' : 'Bot · Uniform Choice'} · Unseated</span><code>{binding.participantId}</code></li>)}</ul>
        </> : !table.isFetching && <div className="initial-state"><h2>Your table starts here</h2><p>Create a Table Session with the settings on the left, or reopen one you already own.</p></div>}
      </section>
    </main>
  </div>;
}
