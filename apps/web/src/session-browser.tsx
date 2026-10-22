import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@poker/client';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, defaultConfiguration } from '@poker/contracts';
import { Icon } from './icons.js';
import { useSession, type Command } from './session.js';

export function SessionBrowser({ command, ready, close }: { command: Command; ready: boolean; close?: () => void }) {
  const [configuration, setConfiguration] = useState({ ...defaultConfiguration, minimumBuyIn: 400, defaultBuyIn: 2000, maximumBuyIn: 4000 });
  const [players, setPlayers] = useState(6);
  const [selector, setSelector] = useState('seeded-sampling');
  const [reopen, setReopen] = useState('');
  const select = useSession(s => s.select);
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: ready });
  function open(id: string) { select(id); close?.(); }
  return <main className="session-browser">
    <div className="session-intro"><Icon name="spade" size={34} /><h1>Take a seat.</h1><p>Your table. Your decisions.<br />Play a hand, then explore the numbers.</p></div>
    <div className="session-columns"><section className="create-session"><div className="section-heading"><h2>Set up your table</h2>{close && <button className="icon-button" aria-label="Back to table" onClick={close}><Icon name="close" /></button>}</div>
      <form onSubmit={e => { e.preventDefault(); command.submit({ kind: 'create', body: { requestId: crypto.randomUUID(), configuration: { ...configuration, seatCount: players }, bots: Array.from({ length: players - 1 }, (_, i) => ({ name: `Bot ${i + 1}`, playingStrategy: selector === 'highest-probability' ? highestProbabilityPlayingStrategy : baselinePlayingStrategy })) } }); }}>
        <fieldset disabled={command.busy || !ready}><label>Players at the table<select value={players} onChange={e => setPlayers(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option value={i + 2} key={i}>{i + 2} players · you + {i + 1} {i ? 'bots' : 'bot'}</option>)}</select></label>
          <div className="form-pair"><label>Small blind<input type="number" required min="1" step="1" value={configuration.smallBlind} onChange={e => setConfiguration({ ...configuration, smallBlind: Number(e.target.value) })} /></label><label>Big blind<input type="number" required min={configuration.smallBlind} step="1" value={configuration.bigBlind} onChange={e => setConfiguration({ ...configuration, bigBlind: Number(e.target.value) })} /></label></div>
          <label>Buy-in · chips<input type="number" min={configuration.minimumBuyIn} max={configuration.maximumBuyIn} step="1" required value={configuration.defaultBuyIn} onChange={e => setConfiguration({ ...configuration, defaultBuyIn: Number(e.target.value) })} /></label>
          <details className="advanced"><summary>Table rules & bot strategies</summary><div className="details-content"><div className="form-pair"><label>Minimum buy-in<input type="number" min="1" max={configuration.defaultBuyIn} required value={configuration.minimumBuyIn} onChange={e => setConfiguration({ ...configuration, minimumBuyIn: Number(e.target.value) })} /></label><label>Maximum buy-in<input type="number" min={configuration.defaultBuyIn} required value={configuration.maximumBuyIn} onChange={e => setConfiguration({ ...configuration, maximumBuyIn: Number(e.target.value) })} /></label></div><label>Ante<input type="number" min="0" required value={configuration.ante} onChange={e => setConfiguration({ ...configuration, ante: Number(e.target.value) })} /></label><label>Bot Playing Strategy<select value={selector} onChange={e => setSelector(e.target.value)}><option value="seeded-sampling">Uniform Choice · Probability Selector</option><option value="highest-probability">Uniform Choice · Highest Probability</option></select></label><label className="check-label"><input type="checkbox" checked={configuration.allowSeatChanges} onChange={e => setConfiguration({ ...configuration, allowSeatChanges: e.target.checked })} />Allow seat changes between hands</label><p className="muted">Uniform Choice is a testing baseline. It makes no claim of poker expertise.</p></div></details>
          <button className="primary create-button" type="submit">Create table <Icon name="arrow" /></button>
        </fieldset>
      </form><p className="form-note">No-limit Texas Hold’em · Chip amounts are integer units.</p>
    </section>
    <section className="saved-sessions"><h2>Return to a table</h2><p className="muted">Seats and stacks stay with your Table Session.</p>{sessions.isLoading && <div className="skeleton" role="status">Loading your tables…</div>}{sessions.isError && <div className="notice-error"><p>Couldn’t load your tables.</p><button onClick={() => void sessions.refetch()}>Retry</button></div>}
      {sessions.data?.tableSessionIds.length === 0 && <div className="empty-sessions"><Icon name="tables" size={30} /><strong>Your first table starts here.</strong><p>Create a table and come back to it anytime in this browser.</p></div>}
      <ul className="session-list">{sessions.data?.tableSessionIds.map((id, i) => <li key={id}><button onClick={() => open(id)}><span><strong>Table Session {i + 1}</strong><small>{id.slice(-12)}</small></span><Icon name="arrow" size={18} /></button></li>)}</ul>
      <form className="reopen-form" onSubmit={e => { e.preventDefault(); if (reopen.trim()) open(reopen.trim()); }}><label>Reopen with a Table Session ID<input placeholder="Paste your session ID" value={reopen} onChange={e => setReopen(e.target.value)} /></label><button type="submit" disabled={!ready || !reopen.trim()}>Open table</button></form>
    </section></div>
  </main>;
}
