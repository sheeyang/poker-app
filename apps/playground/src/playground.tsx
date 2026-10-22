import { HandSummaryControls, useHandSummary, TableSessionSummaryControls, useTableSessionSummary } from './summaries.js';
import { DecisionAnalysisControls, useDecisionAnalysis } from './analysis.js';
import { AttemptRecovery } from './recovery.js';
import { BotControls, baselineOptions } from './bots.js';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultConfiguration, baselinePlayingStrategy, highestProbabilityPlayingStrategy, type ObservableGameConfiguration } from '@poker/contracts';
import { api, RequestFailure } from './api.js';
import { usePlayground } from './store.js';
import { Seating } from './seating.js';
import { Hand } from './hand.js';
import { retainNewestTable, useTableSynchronization } from './live.js';
import { Management } from './management.js';
import { Inspection } from './inspection.js';
import { TrainerConfigurationControls } from './trainer-configuration.js';

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
  const [botSelectors, setBotSelectors] = useState<Record<number, string>>({});
  const [reopenId, setReopenId] = useState('');
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity, staleTime: Infinity });
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: identity.isSuccess });
  const table = useQuery({ queryKey: ['table-session', selectedId], queryFn: ({ signal }) => api.readSession(selectedId!, signal), enabled: identity.isSuccess && !!selectedId, structuralSharing: retainNewestTable });
  const analysis = useDecisionAnalysis(table.data);
  const summary = useHandSummary(table.data);
  const sessionSummary = useTableSessionSummary(table.data);
  const live = useTableSynchronization(selectedId, identity.isSuccess, {
    onReady: lifecycle => { analysis.consumers.onReady?.(lifecycle); summary.consumers.onReady?.(lifecycle); sessionSummary.consumers.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { analysis.consumers.onAnalysisUpdate?.(update, lifecycle); summary.consumers.onAnalysisUpdate?.(update, lifecycle); sessionSummary.consumers.onAnalysisUpdate?.(update, lifecycle); },
  });
  useEffect(() => { const generation = live.userChannel?.generation ?? null; analysis.connectionChanged(generation); summary.connectionChanged(generation); sessionSummary.connectionChanged(generation); }, [live.userChannel?.generation, analysis.connectionChanged, summary.connectionChanged, sessionSummary.connectionChanged]);
  const runtimeStatus = live.runtimeStatus ?? table.data?.runtimeStatus;
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
      bots: Array.from({ length: botCount }, (_, index) => ({ name: 'Bot ' + (index + 1), playingStrategy: botSelectors[index] === 'highest-probability' ? highestProbabilityPlayingStrategy : baselinePlayingStrategy })),
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
              {Array.from({ length: botCount }, (_, index) => <label key={index}>Bot {index + 1} Playing Strategy
                <select name={'botStrategy' + index} value={botSelectors[index] ?? 'seeded-sampling'} onChange={event => setBotSelectors({ ...botSelectors, [index]: event.target.value })}>{baselineOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              </label>)}
              <p className="help">Uniform Choice is a testing baseline with no claim of poker expertise.</p>
              <p className="help">Participants are allocated now. Choose their seats after creating the table.</p>
              <button type="submit" className="primary">Create Table Session</button>
            </fieldset>
          </form>
          {creation.isPending && <p role="status">Committing Table Session…</p>}
          <ErrorMessage error={creation.error} />
          {pending && !creation.isPending && <AttemptRecovery error={creation.error} check={() => creation.mutate(pending)} dismiss={() => { setPending(null); creation.reset(); }} />}
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
          <div className="table-heading"><h2>Table Session</h2><button onClick={() => select(null)}>Close Table Session</button><button onClick={() => void table.refetch()}>Refresh view</button></div>
          <p className="session-id">{table.data.tableSessionId}</p>
          <div className="live-connection">
            <p role="status">{live.connection === 'connected' ? 'Live updates connected' : live.connection === 'disconnected' ? 'Live updates disconnected. Refresh the view or reconnect.' : live.connection === 'reconnecting' ? 'Reconnecting live updates… The table will refresh automatically.' : 'Connecting live updates…'}</p>
            <button onClick={live.connection === 'disconnected' ? live.reconnect : live.disconnect}>{live.connection === 'disconnected' ? 'Reconnect live updates' : 'Disconnect live updates'}</button>
            {runtimeStatus?.phase === 'recovering' && <p role="status">{runtimeStatus.message ?? 'This session is paused pending durable recovery.'}</p>}
          </div>
          <dl className="table-facts">
            <div><dt>Blinds</dt><dd>{table.data.view.configuration.smallBlind} / {table.data.view.configuration.bigBlind}</dd></div>
            <div><dt>Ante</dt><dd>{table.data.view.configuration.ante}</dd></div>
            <div><dt>Button</dt><dd>Seat {table.data.view.state.buttonSeat}</dd></div>
            <div><dt>Committed revisions</dt><dd>Poker {table.data.pokerRevision} · Session {table.data.sessionRevision}</dd></div>
          </dl>
          {table.data.view.state.participants.length === 0 && <div className="empty-table"><h3>Empty table</h3><p>No Participants are seated. Choose a Participant, seat, and buy-in below.</p></div>}
          <ol className="seats">{Array.from({ length: table.data.view.configuration.seatCount }, (_, index) => {
            const participant = table.data.view.state.participants.find(p => p.seat === index + 1);
            const binding = table.data.bindings.find(b => b.participantId === participant?.participantId);
            return <li key={index}><span>Seat {index + 1}</span><strong>{binding?.name ?? 'Empty'}</strong>{participant && <>
              {table.data.view.state.buttonSeat === index + 1 && <span>Button</span>}
              {participant.handSeat === index + 1 && participant.participantId === table.data.view.state.smallBlindParticipantId && <span>Small blind</span>}
              {participant.handSeat === index + 1 && participant.participantId === table.data.view.state.bigBlindParticipantId && <span>Big blind</span>}
              <span>{participant.stack} chips{participant.sittingOut ? ' · Sitting out' : ''}{participant.allIn ? ' · All-in' : participant.folded ? ' · Folded' : ''}</span>
              {table.data.view.state.status !== 'active-hand' && participant.stack === 0 && <span>Rebuy to play the next Hand</span>}
              {participant.contribution !== undefined && <span>Committed {participant.contribution} chips</span>}
              {participant.anteContribution !== undefined && <span>Ante {participant.anteContribution} chips</span>}
              {participant.wager !== undefined && <span>Street wager {participant.wager} chips</span>}
              {participant.holeCards ? <span className="cards" aria-label="Hole cards">{participant.holeCards.join(' ')}</span> : participant.cardCount ? <span>{participant.cardCount} hidden cards</span> : null}
            </>}</li>;
          })}</ol>
          <Hand key={'hand-' + table.data.tableSessionId} table={table.data} />
          <TrainerConfigurationControls key={'trainer-configuration-' + table.data.tableSessionId} table={table.data} />
          <DecisionAnalysisControls analysis={analysis} />
          <HandSummaryControls summary={summary} />
          <TableSessionSummaryControls summary={sessionSummary} />
          <BotControls table={table.data} status={runtimeStatus} />
          {live.inspectionCapabilities?.adminMode && <Inspection key={'inspection-' + table.data.tableSessionId + '-' + live.inspectionGeneration} table={table.data} capabilities={live.inspectionCapabilities} />}
          <Seating key={table.data.tableSessionId} table={table.data} />
          <Management key={'management-' + table.data.tableSessionId} table={table.data} />
          <details className="presentation-events"><summary>Presentation events received: {live.eventCount}</summary><ul>{live.recentEvents.map((event, index) => <li key={index}>{event.type}</li>)}</ul></details>
          <h3>Participants</h3>
          <ul className="bindings">{table.data.bindings.map(binding => {
            const participant = table.data.view.state.participants.find(p => p.participantId === binding.participantId);
            return <li key={binding.participantId}><strong>{binding.name}</strong><span>{binding.controller.kind === 'human' ? 'Human' : `Bot · Uniform Choice + ${binding.controller.playingStrategy.selector.id === 'highest-probability' ? 'Highest Probability Selector' : 'Probability Selector'}`} · {participant?.seat ? `Seat ${participant.seat} · ${participant.stack} chips${participant.sittingOut ? ' · Sitting out' : ''}` : 'Unseated'}</span><code>{binding.participantId}</code></li>;
          })}</ul>
        </> : !table.isFetching && <div className="initial-state"><h2>Your table starts here</h2><p>Create a Table Session with the settings on the left, or reopen one you already own.</p></div>}
      </section>
    </main>
  </div>;
}
