import { useState } from 'react';
import { actionTimeLimits, type ActionTimeLimitSeconds, type CreateTableSessionRequest, type SavedTable, type TableMode } from '@poker/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '@poker/client';
import { defaultPlayingStrategy, defaultConfiguration } from '@poker/contracts';
import { StrategySelect } from './strategy-select.js';
import { Icon } from './icons.js';
import { chips, modeLabel } from './table-model.js';
import { defaultOnlineSetup, onlineCreationRequest, onlineSetupProblem } from './online-setup.js';
import { useSession, type Command } from './session.js';
import { DisplayNameForm, DisplayNamePrompt, useDisplayName } from './display-name.js';
import { SavedTablesSkeleton } from './loading-skeleton.js';

export function SessionBrowser({ command, ready, connecting = false, close }: { command: Command; ready: boolean; connecting?: boolean; close?: () => void }) {
  const [players, setPlayers] = useState(6), [depth, setDepth] = useState(100);
  const [smallBlind, setSmallBlind] = useState(10), [bigBlind, setBigBlind] = useState(20), [ante, setAnte] = useState(0);
  const [minimumBB, setMinimumBB] = useState(20), [maximumBB, setMaximumBB] = useState(200);
  const [strategy, setStrategy] = useState(defaultPlayingStrategy), [seatChanges, setSeatChanges] = useState(true), [mode, setMode] = useState<TableMode>('practice');
  // Practice is untimed unless the player asks for an Action Time Limit.
  const [timeLimit, setTimeLimit] = useState<ActionTimeLimitSeconds | null>(null);
  const { displayName } = useDisplayName(), [awaitingName, setAwaitingName] = useState<CreateTableSessionRequest | null>(null);
  const select = useSession(s => s.select), selected = useSession(s => s.selectedId);
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: ready });
  function open(id: string) { select(id); close?.(); }
  const valid = [smallBlind, bigBlind, ante, depth, minimumBB, maximumBB].every(Number.isSafeInteger) && smallBlind > 0 && bigBlind >= smallBlind && ante >= 0 && depth >= minimumBB && minimumBB > 0 && depth <= maximumBB && Number.isSafeInteger(bigBlind * maximumBB);
  return <main id="main-table" className="practice-home">
    <div className="practice-heading"><div><h1>Tables</h1><p>Practice alone against bots, or set up an online table for your friends.</p></div>{close && <button className="quiet-button" onClick={close}>Back to your hand <Icon name="arrow" size={17} /></button>}</div>
    <div className="practice-layout"><section className="practice-config" aria-labelledby="new-practice-title">
      <h2 id="new-practice-title">New table</h2>
      <fieldset className="format-picker mode-picker"><legend>Table type</legend><div className="format-options mode-options">{([['practice', 'Practice', 'You against bots. You deal each hand.'], ['online', 'Online', 'Friends join by a link. Hands are dealt automatically.']] as const).map(([value, title, text]) => <label key={value} className={mode === value ? 'format-selected' : ''}><input type="radio" name="mode" checked={mode === value} onChange={() => setMode(value)} /><strong>{title}</strong><span>{text}</span></label>)}</div></fieldset>
      {mode === 'practice' ? <form onSubmit={e => { e.preventDefault(); if (!valid) return; const request: CreateTableSessionRequest = { requestId: crypto.randomUUID(), configuration: { ...defaultConfiguration, seatCount: players, smallBlind, bigBlind, ante, minimumBuyIn: bigBlind * minimumBB, defaultBuyIn: bigBlind * depth, maximumBuyIn: bigBlind * maximumBB, allowSeatChanges: seatChanges }, bots: Array.from({ length: players - 1 }, (_, i) => ({ name: `Bot ${i + 1}`, playingStrategy: strategy })), ...(timeLimit ? { options: { actionTimeLimitSeconds: timeLimit } } : {}) }; if (displayName) command.launch(request); else setAwaitingName(request); }}>
        <fieldset disabled={command.busy || !ready}>
          <fieldset className="format-picker"><legend>Table size</legend><div className="format-options">{[{ n: 2, title: 'Heads-up', text: 'You + 1 bot' }, { n: 6, title: '6-max', text: 'You + 5 bots' }, { n: 9, title: 'Full ring', text: 'You + 8 bots' }].map(f => <label key={f.n} className={players === f.n ? 'format-selected' : ''}><input type="radio" name="format" checked={players === f.n} onChange={() => setPlayers(f.n)} /><strong>{f.title}</strong><span>{f.text}</span></label>)}</div></fieldset>
          <fieldset className="depth-picker"><legend>Starting stack</legend><div className="depth-options">{[50, 100, 200].map(n => <button type="button" key={n} aria-pressed={depth === n} onClick={() => setDepth(n)}>{n} BB</button>)}</div></fieldset>
          <details className="practice-custom"><summary>Customize table & bots</summary><div className="details-content"><div className="form-pair"><label>Players<select value={players} onChange={e => setPlayers(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 2}>{i + 2} players</option>)}</select></label><label>Starting stack · BB<input required type="number" min={minimumBB} max={maximumBB} step="1" value={depth} onChange={e => setDepth(Number(e.target.value))} /></label></div><div className="form-pair"><label>Small blind<input required type="number" min="1" step="1" value={smallBlind} onChange={e => setSmallBlind(Number(e.target.value))} /></label><label>Big blind<input required type="number" min={smallBlind} step="1" value={bigBlind} onChange={e => setBigBlind(Number(e.target.value))} /></label></div><div className="form-pair"><label>Minimum buy-in · BB<input required type="number" min="1" max={depth} step="1" value={minimumBB} onChange={e => setMinimumBB(Number(e.target.value))} /></label><label>Maximum buy-in · BB<input required type="number" min={depth} step="1" value={maximumBB} onChange={e => setMaximumBB(Number(e.target.value))} /></label></div><label>Ante<input required type="number" min="0" step="1" value={ante} onChange={e => setAnte(Number(e.target.value))} /></label><label>Bot Playing Strategy<StrategySelect value={strategy} onChange={setStrategy} /></label><label>Time to act<select value={timeLimit ?? ''} onChange={e => setTimeLimit(e.target.value ? Number(e.target.value) as ActionTimeLimitSeconds : null)}><option value="">No time limit</option>{actionTimeLimits.map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select><small className="muted">When time runs out, you check, or fold if you can’t check.</small></label><label className="check-label"><input type="checkbox" checked={seatChanges} onChange={e => setSeatChanges(e.target.checked)} />Allow seat changes between hands</label></div></details>
          <div className="practice-preview"><span>No-limit Hold’em · {players} players{timeLimit ? ` · ${timeLimit} seconds to act` : ''}</span><strong>{chips(bigBlind * depth)} chips each <span>· {chips(smallBlind)} / {chips(bigBlind)} blinds</span></strong></div>
          <button className="primary start-practice" type="submit" disabled={!valid}>{command.busy ? 'Preparing your table…' : 'Start practice'}<Icon name="arrow" size={19} /></button>
        </fieldset>
      </form> : <OnlineForm command={command} ready={ready} launch={request => displayName ? command.launch(request) : setAwaitingName(request)} />}
      <details className="practice-custom"><summary>Your name{displayName ? ` · ${displayName}` : ''}</summary><div className="details-content"><p className="muted">Used at tables you create from now on. Existing tables keep the name they started with.</p><DisplayNameForm current={displayName} /></div></details>
      <p className="baseline-note"><Icon name="info" size={16} /><span>Simple Heuristic uses basic hand strength and modest bets. Scores compare your play with a reference; they don’t measure poker skill.</span></p>
    </section>
    <section className="practice-return" aria-labelledby="return-title"><h2 id="return-title">Pick up where you left off</h2><p className="muted">Your tables are saved automatically.</p>
      {!sessions.data && (connecting || ready && sessions.isPending) && <SavedTablesSkeleton />}
      {sessions.isError && <div className="notice-error"><p>Couldn’t load your tables.</p><button onClick={() => void sessions.refetch()}>Retry</button></div>}
      {sessions.data?.tables.length === 0 && <div className="practice-empty"><Icon name="cards" size={30} /><h3>No saved tables yet.</h3><p>Start practice to play your first hand.</p></div>}
      <ul className="return-list">{sessions.data?.tables.map(saved => !readable(saved)
        ? <li key={saved.tableSessionId} className="saved-table"><p className="muted">This saved table couldn’t be read.</p><button className="text-button" onClick={() => void sessions.refetch()}>Retry</button></li>
        : saved.left
          ? <LeftTable key={saved.tableSessionId} saved={saved} busy={command.busy} returnToTable={() => command.submit({ kind: 'rejoin', tableId: saved.tableSessionId, body: { requestId: crypto.randomUUID() } })} />
          : <SavedTableRow key={saved.tableSessionId} saved={saved} selected={saved.tableSessionId === selected} open={() => open(saved.tableSessionId)} />)}</ul>
    </section></div>
    {awaitingName && <DisplayNamePrompt close={() => setAwaitingName(null)} onSaved={() => { const request = awaitingName; setAwaitingName(null); command.launch(request); }} />}
  </main>;
}

/** A saved table that could be read: its format, mode and stakes, then how play stands, all public facts from the list. */
type ReadableSavedTable = SavedTable & Required<Pick<SavedTable, 'seatCount' | 'stakes' | 'playState'>>;
const readable = (saved: SavedTable): saved is ReadableSavedTable => saved.seatCount !== undefined && !!saved.stakes && !!saved.playState;
function SavedTableCopy({ saved, tag, state }: { saved: ReadableSavedTable; tag?: string; state: string }) {
  const { seatCount, stakes, playState } = saved;
  return <span className="saved-table-copy"><strong>{seatCount === 2 ? 'Heads-up' : `${seatCount}-player`} Hold’em<small className={`mode-chip mode-${saved.mode}`}>{modeLabel(saved.mode)}</small>{tag && <small>{tag}</small>}</strong><span>{chips(stakes.smallBlind)} / {chips(stakes.bigBlind)} blinds{stakes.ante ? ` · Ante ${chips(stakes.ante)}` : ''} · {playState.completedHands} {playState.completedHands === 1 ? 'hand' : 'hands'} completed</span><span className="saved-table-state">{playState.status === 'active-hand' ? 'Hand in progress' : 'Between hands'}{state}</span></span>;
}

/** An owned table the Guest left: it keeps running without them, and opening it returns them without the Join Link. */
function LeftTable({ saved, busy, returnToTable }: { saved: ReadableSavedTable; busy: boolean; returnToTable: () => void }) {
  return <li className="saved-table"><button onClick={returnToTable} disabled={busy}><SavedTableCopy saved={saved} tag="You left" state={` · ${saved.playState.seatedParticipants} seated · It keeps running while you’re away`} /><span className="resume-label">Return to table <Icon name="arrow" size={17} /></span></button></li>;
}

function SavedTableRow({ saved, selected, open }: { saved: ReadableSavedTable; selected: boolean; open: () => void }) {
  const stack = saved.playState.viewerStack;
  return <li className="saved-table"><button onClick={open}><SavedTableCopy saved={saved} tag={selected ? 'Current table' : undefined} state={stack !== undefined ? ` · Your stack ${chips(stack)}` : saved.mode === 'online' ? ' · Watching' : ''} /><span className="resume-label">Continue <Icon name="arrow" size={17} /></span></button></li>;
}

/** Online creation: the table size up front, everything else under progressive disclosure. */
function OnlineForm({ command, ready, launch }: { command: Command; ready: boolean; launch: (request: CreateTableSessionRequest) => void }) {
  const [setup, setSetup] = useState(defaultOnlineSetup);
  const problem = onlineSetupProblem(setup);
  const number = (key: keyof typeof setup) => (e: { target: { value: string } }) => setSetup({ ...setup, [key]: Number(e.target.value) });
  return <form onSubmit={e => { e.preventDefault(); const request = onlineCreationRequest(setup, crypto.randomUUID()); if (request) launch(request); }}>
    <fieldset disabled={command.busy || !ready}>
      <label>Seats<select value={setup.seatCount} onChange={e => setSetup({ ...setup, seatCount: Number(e.target.value), bots: Math.min(setup.bots, Number(e.target.value) - 1) })}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 2}>{i + 2} seats</option>)}</select></label>
      <details className="practice-custom"><summary>Table options</summary><div className="details-content">
        <div className="form-pair"><label>Small blind<input required type="number" min="1" step="1" value={setup.smallBlind} onChange={number('smallBlind')} /></label><label>Big blind<input required type="number" min={setup.smallBlind} step="1" value={setup.bigBlind} onChange={number('bigBlind')} /></label></div>
        <div className="form-pair"><label>Ante<input required type="number" min="0" step="1" value={setup.ante} onChange={number('ante')} /></label><label>Starting stack · BB<input required type="number" min={setup.minimumBuyInBB} max={setup.maximumBuyInBB} step="1" value={setup.startingStackBB} onChange={number('startingStackBB')} /></label></div>
        <div className="form-pair"><label>Minimum buy-in · BB<input required type="number" min="1" max={setup.startingStackBB} step="1" value={setup.minimumBuyInBB} onChange={number('minimumBuyInBB')} /></label><label>Maximum buy-in · BB<input required type="number" min={setup.startingStackBB} step="1" value={setup.maximumBuyInBB} onChange={number('maximumBuyInBB')} /></label></div>
        <label>Time to act<select value={setup.actionTimeLimitSeconds} onChange={e => setSetup({ ...setup, actionTimeLimitSeconds: Number(e.target.value) as ActionTimeLimitSeconds })}>{actionTimeLimits.map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
        <label className="check-label"><input type="checkbox" checked={setup.allowLiveAnalysis} onChange={e => setSetup({ ...setup, allowLiveAnalysis: e.target.checked })} />Allow Live Analysis at this table</label>
        <label className="check-label"><input type="checkbox" checked={setup.allowSeatChanges} onChange={e => setSetup({ ...setup, allowSeatChanges: e.target.checked })} />Allow seat changes between hands</label>
        <div className="form-pair"><label>Bots<select value={setup.bots} onChange={number('bots')}>{Array.from({ length: setup.seatCount }, (_, i) => <option key={i} value={i}>{i === 0 ? 'No bots' : i === 1 ? '1 bot' : `${i} bots`}</option>)}</select></label>{setup.bots > 0 && <label>Bot Playing Strategy<StrategySelect value={setup.botStrategy} onChange={botStrategy => setSetup({ ...setup, botStrategy })} /></label>}</div>
      </div></details>
      {problem && <p className="notice-error" role="alert">{problem}</p>}
      <div className="practice-preview"><span>No-limit Hold’em · {setup.seatCount} seats · {setup.actionTimeLimitSeconds} seconds to act</span><strong>{chips(setup.bigBlind * setup.startingStackBB)} chips each <span>· {chips(setup.smallBlind)} / {chips(setup.bigBlind)} blinds</span></strong><p>You join first and choose your seat. You’ll get a link to share.</p></div>
      <button className="primary start-practice" type="submit" disabled={!!problem}>{command.busy ? 'Creating your table…' : 'Create online table'}<Icon name="arrow" size={19} /></button>
    </fieldset>
  </form>;
}
