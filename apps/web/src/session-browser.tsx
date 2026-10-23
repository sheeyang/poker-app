import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@poker/client';
import { defaultPlayingStrategy, defaultConfiguration } from '@poker/contracts';
import { StrategySelect } from './strategy-select.js';
import { Icon } from './icons.js';
import { chips } from './table-model.js';
import { useSession, type Command } from './session.js';

export function SessionBrowser({ command, ready, close }: { command: Command; ready: boolean; close?: () => void }) {
  const [players, setPlayers] = useState(6), [depth, setDepth] = useState(100);
  const [smallBlind, setSmallBlind] = useState(10), [bigBlind, setBigBlind] = useState(20), [ante, setAnte] = useState(0);
  const [minimumBB, setMinimumBB] = useState(20), [maximumBB, setMaximumBB] = useState(200);
  const [strategy, setStrategy] = useState(defaultPlayingStrategy), [seatChanges, setSeatChanges] = useState(true);
  const select = useSession(s => s.select), selected = useSession(s => s.selectedId);
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: ready });
  function open(id: string) { select(id); close?.(); }
  const valid = [smallBlind, bigBlind, ante, depth, minimumBB, maximumBB].every(Number.isSafeInteger) && smallBlind > 0 && bigBlind >= smallBlind && ante >= 0 && depth >= minimumBB && minimumBB > 0 && depth <= maximumBB && Number.isSafeInteger(bigBlind * maximumBB);
  return <main id="main-table" className="practice-home">
    <div className="practice-heading"><div><h1>Practice</h1><p>Start a new table or continue a saved one.</p></div>{close && <button className="quiet-button" onClick={close}>Back to your hand <Icon name="arrow" size={17} /></button>}</div>
    <div className="practice-layout"><section className="practice-config" aria-labelledby="new-practice-title">
      <h2 id="new-practice-title">New table</h2>
      <form onSubmit={e => { e.preventDefault(); if (!valid) return; command.launch({ requestId: crypto.randomUUID(), configuration: { ...defaultConfiguration, seatCount: players, smallBlind, bigBlind, ante, minimumBuyIn: bigBlind * minimumBB, defaultBuyIn: bigBlind * depth, maximumBuyIn: bigBlind * maximumBB, allowSeatChanges: seatChanges }, bots: Array.from({ length: players - 1 }, (_, i) => ({ name: `Bot ${i + 1}`, playingStrategy: strategy })) }); }}>
        <fieldset disabled={command.busy || !ready}>
          <fieldset className="format-picker"><legend>Table size</legend><div className="format-options">{[{ n: 2, title: 'Heads-up', text: 'You + 1 bot' }, { n: 6, title: '6-max', text: 'You + 5 bots' }, { n: 9, title: 'Full ring', text: 'You + 8 bots' }].map(f => <label key={f.n} className={players === f.n ? 'format-selected' : ''}><input type="radio" name="format" checked={players === f.n} onChange={() => setPlayers(f.n)} /><strong>{f.title}</strong><span>{f.text}</span></label>)}</div></fieldset>
          <fieldset className="depth-picker"><legend>Starting stack</legend><div className="depth-options">{[50, 100, 200].map(n => <button type="button" key={n} aria-pressed={depth === n} onClick={() => setDepth(n)}>{n} BB</button>)}</div></fieldset>
          <details className="practice-custom"><summary>Customize table & bots</summary><div className="details-content"><div className="form-pair"><label>Players<select value={players} onChange={e => setPlayers(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 2}>{i + 2} players</option>)}</select></label><label>Starting stack · BB<input required type="number" min={minimumBB} max={maximumBB} step="1" value={depth} onChange={e => setDepth(Number(e.target.value))} /></label></div><div className="form-pair"><label>Small blind<input required type="number" min="1" step="1" value={smallBlind} onChange={e => setSmallBlind(Number(e.target.value))} /></label><label>Big blind<input required type="number" min={smallBlind} step="1" value={bigBlind} onChange={e => setBigBlind(Number(e.target.value))} /></label></div><div className="form-pair"><label>Minimum buy-in · BB<input required type="number" min="1" max={depth} step="1" value={minimumBB} onChange={e => setMinimumBB(Number(e.target.value))} /></label><label>Maximum buy-in · BB<input required type="number" min={depth} step="1" value={maximumBB} onChange={e => setMaximumBB(Number(e.target.value))} /></label></div><label>Ante<input required type="number" min="0" step="1" value={ante} onChange={e => setAnte(Number(e.target.value))} /></label><label>Bot Playing Strategy<StrategySelect value={strategy} onChange={setStrategy} /></label><label className="check-label"><input type="checkbox" checked={seatChanges} onChange={e => setSeatChanges(e.target.checked)} />Allow seat changes between hands</label></div></details>
          <div className="practice-preview"><span>No-limit Hold’em · {players} players</span><strong>{chips(bigBlind * depth)} chips each <span>· {chips(smallBlind)} / {chips(bigBlind)} blinds</span></strong></div>
          <button className="primary start-practice" type="submit" disabled={!valid}>{command.busy ? 'Preparing your table…' : 'Start practice'}<Icon name="arrow" size={19} /></button>
        </fieldset>
      </form>
      <p className="baseline-note"><Icon name="info" size={16} /><span>Simple Heuristic uses basic hand strength and modest bets. Scores compare your play with a reference; they don’t measure poker skill.</span></p>
    </section>
    <section className="practice-return" aria-labelledby="return-title"><h2 id="return-title">Pick up where you left off</h2><p className="muted">Your tables are saved automatically.</p>
      {sessions.isLoading && <p className="muted" role="status">Finding your tables…</p>}
      {sessions.isError && <div className="notice-error"><p>Couldn’t load your tables.</p><button onClick={() => void sessions.refetch()}>Retry</button></div>}
      {sessions.data?.tableSessionIds.length === 0 && <div className="practice-empty"><Icon name="cards" size={30} /><h3>No saved tables yet.</h3><p>Start practice to play your first hand.</p></div>}
      <ul className="return-list">{sessions.data?.tableSessionIds.map(id => <SavedTable key={id} id={id} selected={id === selected} open={() => open(id)} />)}</ul>
    </section></div>
  </main>;
}

function SavedTable({ id, selected, open }: { id: string; selected: boolean; open: () => void }) {
  const table = useQuery({ queryKey: ['table-session', id], queryFn: ({ signal }) => api.readSession(id, signal) });
  const data = table.data;
  if (!data) return <li className="saved-table"><p className="muted">{table.isError ? 'This saved table couldn’t be read.' : 'Reading saved table…'}</p>{table.isError && <button className="text-button" onClick={() => void table.refetch()}>Retry</button>}</li>;
  const human = data.bindings.find(b => b.controller.kind === 'human');
  const participant = data.view.state.participants.find(p => p.participantId === human?.participantId);
  const size = data.view.configuration.seatCount;
  return <li className="saved-table"><button onClick={open}><span className="saved-table-copy"><strong>{size === 2 ? 'Heads-up' : `${size}-player`} Hold’em{selected && <small>Current table</small>}</strong><span>{chips(data.view.configuration.smallBlind)} / {chips(data.view.configuration.bigBlind)} blinds · {data.view.history.filter(h => h.result).length} {data.view.history.filter(h => h.result).length === 1 ? 'hand' : 'hands'} completed</span><span className="saved-table-state">{data.view.state.status === 'active-hand' ? 'Hand in progress' : 'Between hands'}{participant && ` · Your stack ${chips(participant.stack)}`}</span></span><span className="resume-label">Continue <Icon name="arrow" size={17} /></span></button></li>;
}
