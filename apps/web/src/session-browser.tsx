import { useState, type ReactNode } from 'react';
import { actionTimeLimits, defaultConfiguration, defaultPlayingStrategy, type ActionTimeLimitSeconds, type CreateTableSessionRequest, type SavedTable, type TableMode } from '@poker/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '@poker/client';
import { StrategySelect } from './strategy-select.js';
import { Icon } from './icons.js';
import { chips, tableFormat } from './table-model.js';
import { defaultOnlineSetup, onlineCreationRequest, onlineSetupProblem, tablePasswordProblem } from './online-setup.js';
import { PasswordField } from './password-input.js';
import type { Command } from './session.js';
import { DisplayNameForm, DisplayNamePrompt, useDisplayName } from './display-name.js';
import { Skeleton } from './loading-skeleton.js';
import { FeltPreview, SeatGlyph, type SeatMark } from './felt.js';
import { usePageTitle, useShell } from './app-shell.js';

const copy = {
  practice: { title: 'Practice tables', lead: 'Your practice history. Every table waits exactly where you left it.', create: 'New practice table', empty: 'No practice tables yet.', emptyHint: 'Start practice to play your first hand against Bots.' },
  online: { title: 'Online tables', lead: 'Tables you created or joined to play with friends.', create: 'New online table', empty: 'No online tables yet.', emptyHint: 'Create one for your friends, or open the Join Link a friend sent you.' },
} as const;

/** The Practice screen or the Online screen: that mode's creation form, opened inline, above that mode's saved tables. */
export function TablesScreen({ mode }: { mode: TableMode }) {
  const { command, identity } = useShell();
  const ready = identity.isSuccess;
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: ready });
  const tables = sessions.data?.tables.filter(saved => saved.mode === mode);
  const { displayName } = useDisplayName(), [awaitingName, setAwaitingName] = useState<CreateTableSessionRequest | null>(null);
  // Until the Guest decides, the form is open exactly when there is nothing to pick up instead.
  const [composing, setComposing] = useState<boolean>();
  const open = composing ?? tables?.length === 0;
  const launch = (request: CreateTableSessionRequest) => displayName ? command.launch(request) : setAwaitingName(request);
  usePageTitle({ page: 'list', mode });
  const text = copy[mode], formId = `new-${mode}-table`;
  return <main id="main-table" className="tables-page">
    <div className="tables-heading">
      <div><h1>{text.title}</h1><p>{text.lead}</p></div>
      <button className={open ? 'quiet-button' : 'primary'} aria-expanded={open} aria-controls={open ? formId : undefined} onClick={() => setComposing(!open)}>{open ? <><Icon name="close" size={17} />Close</> : <><Icon name="plus" size={17} />{text.create}</>}</button>
    </div>
    {open && (mode === 'practice'
      ? <PracticeComposer id={formId} command={command} ready={ready} launch={launch} />
      : <OnlineComposer id={formId} command={command} ready={ready} displayName={displayName} launch={launch} />)}
    <section className="saved-tables" aria-labelledby={`${mode}-saved-title`}>
      <h2 id={`${mode}-saved-title`} className="visually-hidden">Saved {mode} tables</h2>
      {!sessions.data && (identity.isPending || ready && sessions.isPending) && <LedgerSkeleton />}
      {sessions.isError && <div className="notice-error ledger-problem" role="alert"><p>Couldn’t load your tables.</p><button onClick={() => void sessions.refetch()}>Retry</button></div>}
      {tables?.length === 0 && <div className="ledger-empty"><SeatGlyph seats={mode === 'practice' ? 6 : 9} /><div><h3>{text.empty}</h3><p>{text.emptyHint}</p></div></div>}
      {!!tables?.length && <table className="ledger">
        <thead><tr><th scope="col">Table</th><th scope="col">Blinds</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Action</span></th></tr></thead>
        <tbody>{tables.map(saved => <LedgerRow key={saved.tableSessionId} saved={saved} retry={() => void sessions.refetch()} />)}</tbody>
      </table>}
    </section>
    <details className="tables-name"><summary><span>Your name</span><strong>{displayName ?? 'Not set yet'}</strong><Icon name="chevron" size={15} /></summary><div className="tables-name-form"><p className="muted">Used at tables you create or join from now on. Existing tables keep the name you had there.</p><DisplayNameForm key={displayName} current={displayName} /></div></details>
    {awaitingName && <DisplayNamePrompt close={() => setAwaitingName(null)} onSaved={() => { const request = awaitingName; setAwaitingName(null); command.launch(request); }} />}
  </main>;
}

/** A saved table that could be read: its format, mode and stakes, then how play stands, all public facts from the list. */
type ReadableSavedTable = SavedTable & Required<Pick<SavedTable, 'seatCount' | 'stakes' | 'playState'>>;
const readable = (saved: SavedTable): saved is ReadableSavedTable => saved.seatCount !== undefined && !!saved.stakes && !!saved.playState;

/**
 * One saved table. The whole row opens it: a real link to its address, so it can open in a new browser tab. An
 * Online Table the Guest left opens at its address too, which is its Join Link: its join form returns them.
 */
function LedgerRow({ saved, retry }: { saved: SavedTable; retry: () => void }) {
  if (!readable(saved)) return <tr className="ledger-row is-unreadable"><th scope="row" colSpan={3}><span className="muted">This saved table couldn’t be read.</span></th><td className="ledger-action"><button className="text-button" onClick={retry}>Retry</button></td></tr>;
  const { seatCount, stakes, playState } = saved;
  const name = `${tableFormat(seatCount)} Hold’em`, blinds = `${chips(stakes.smallBlind)} / ${chips(stakes.bigBlind)}`;
  const kind = saved.left ? 'away' : saved.mode === 'practice' ? 'practice' : 'seated';
  const action = kind === 'away' ? 'Return to table' : kind === 'seated' ? 'Back to game' : 'Continue';
  const label = `${action}: ${name}, ${blinds} blinds`;
  const status = kind === 'practice' ? <span className="muted">Practice</span>
    : kind === 'away' ? <span className="muted">Not at this table</span>
    : <span className="ledger-live"><b>At this table</b> · {playState.status === 'active-hand' ? 'Hand in progress' : 'Between hands'} · {playState.viewerStack !== undefined ? <span className="numeric">{chips(playState.viewerStack)} chips</span> : 'Watching'}</span>;
  const opener = saved.mode === 'online'
      ? <Link className="ledger-open" aria-label={label} to="/online/$tableSessionId" params={{ tableSessionId: saved.tableSessionId }}>{name}</Link>
      : <Link className="ledger-open" aria-label={label} to="/practice/$tableSessionId" params={{ tableSessionId: saved.tableSessionId }}>{name}</Link>;
  return <tr className={`ledger-row is-${kind}`}>
    <th scope="row"><span className="ledger-name"><SeatGlyph seats={seatCount} you={kind === 'seated' && playState.viewerStack !== undefined} dim={kind === 'away'} />{opener}</span></th>
    <td className="numeric">{blinds}{stakes.ante ? <span className="ledger-ante"> · ante {chips(stakes.ante)}</span> : null}</td>
    <td>{status}</td>
    <td className="ledger-action" aria-hidden="true"><span>{action}</span><Icon name="arrow" size={15} /></td>
  </tr>;
}

function LedgerSkeleton() {
  return <div className="ledger-skeleton" role="status" aria-label="Loading saved tables"><div aria-hidden="true">{[0, 1, 2].map(row => <div key={row}><Skeleton className="skeleton-glyph" /><Skeleton className="skeleton-table-title" /><Skeleton className="skeleton-table-detail" /><Skeleton className="skeleton-resume" /></div>)}</div></div>;
}

const sizes = [{ value: 2, label: 'Heads-up' }, { value: 6, label: '6-max' }, { value: 9, label: 'Full ring' }];
const blindPresets = [[1, 2], [5, 10], [10, 20], [25, 50], [50, 100], [100, 200]] as const;

/** A short row of mutually exclusive presets. None is checked when the value was customised to something else. */
function Segmented({ legend, name, options, value, onChange }: { legend: string; name: string; options: readonly { value: number; label: string }[]; value: number; onChange: (value: number) => void }) {
  return <fieldset className="composer-field"><legend>{legend}</legend><div className="segmented">{options.map(option => <label key={option.value}><input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} /><span>{option.label}</span></label>)}</div></fieldset>;
}

/** The common stakes, and the custom ones from the table options when they are something else. */
function BlindsField({ smallBlind, bigBlind, onChange }: { smallBlind: number; bigBlind: number; onChange: (smallBlind: number, bigBlind: number) => void }) {
  const value = `${smallBlind}/${bigBlind}`;
  const preset = blindPresets.some(([small, big]) => small === smallBlind && big === bigBlind);
  return <label className="composer-field">Blinds<select value={value} onChange={e => { const [small, big] = e.target.value.split('/').map(Number); onChange(small!, big!); }}>
    {!preset && <option value={value}>{Number.isSafeInteger(smallBlind) && Number.isSafeInteger(bigBlind) ? `${chips(smallBlind)} / ${chips(bigBlind)} · custom` : 'Custom'}</option>}
    {blindPresets.map(([small, big]) => <option key={big} value={`${small}/${big}`}>{chips(small)} / {chips(big)}</option>)}
  </select></label>;
}

/** The creation form: the felt it will make on the left, and one column that reads strictly top to bottom. */
function Composer({ id, label, seats, felt, summary, children }: { id: string; label: string; seats: readonly SeatMark[]; felt: string; summary: ReactNode; children: ReactNode }) {
  return <section id={id} className="composer" aria-label={label}>
    <FeltPreview seats={seats} label={felt}>{summary}</FeltPreview>
    <div className="composer-column">{children}</div>
  </section>;
}

function feltCentre(smallBlind: number, bigBlind: number, stack: number) {
  const whole = [smallBlind, bigBlind, stack].every(Number.isSafeInteger);
  return whole ? <><strong className="numeric">{chips(smallBlind)} / {chips(bigBlind)}</strong><span>{chips(stack)} chips each</span></> : undefined;
}

function PracticeComposer({ id, command, ready, launch }: { id: string; command: Command; ready: boolean; launch: (request: CreateTableSessionRequest) => void }) {
  const [players, setPlayers] = useState(6), [depth, setDepth] = useState(100);
  const [smallBlind, setSmallBlind] = useState(10), [bigBlind, setBigBlind] = useState(20), [ante, setAnte] = useState(0);
  const [minimumBB, setMinimumBB] = useState(20), [maximumBB, setMaximumBB] = useState(200);
  const [strategy, setStrategy] = useState(defaultPlayingStrategy), [seatChanges, setSeatChanges] = useState(true);
  // Practice is untimed unless the player asks for an Action Time Limit.
  const [timeLimit, setTimeLimit] = useState<ActionTimeLimitSeconds | null>(null);
  const valid = [smallBlind, bigBlind, ante, depth, minimumBB, maximumBB].every(Number.isSafeInteger) && smallBlind > 0 && bigBlind >= smallBlind && ante >= 0 && depth >= minimumBB && minimumBB > 0 && depth <= maximumBB && Number.isSafeInteger(bigBlind * maximumBB);
  const bots = players - 1, others = `You and ${bots} ${bots === 1 ? 'Bot' : 'Bots'}`;
  const seats = Array.from({ length: players }, (_, i): SeatMark => i === 0 ? 'you' : 'taken');
  return <Composer id={id} label="New practice table" seats={seats} felt={`${tableFormat(players)} table: ${others.toLowerCase()}`} summary={feltCentre(smallBlind, bigBlind, bigBlind * depth)}>
    <form onSubmit={e => { e.preventDefault(); if (!valid) return; launch({ requestId: crypto.randomUUID(), configuration: { ...defaultConfiguration, seatCount: players, smallBlind, bigBlind, ante, minimumBuyIn: bigBlind * minimumBB, defaultBuyIn: bigBlind * depth, maximumBuyIn: bigBlind * maximumBB, allowSeatChanges: seatChanges }, bots: Array.from({ length: bots }, (_, i) => ({ name: `Bot ${i + 1}`, playingStrategy: strategy })), ...(timeLimit ? { options: { actionTimeLimitSeconds: timeLimit } } : {}) }); }}>
      <fieldset disabled={command.busy || !ready}>
        <p className="composer-summary"><strong>{tableFormat(players)} Hold’em</strong><span>{others}{timeLimit ? ` · ${timeLimit}s to act` : ''}</span></p>
        <Segmented legend="Size" name="practice-size" options={sizes} value={players} onChange={setPlayers} />
        <Segmented legend="Starting stack" name="practice-stack" options={[50, 100, 200].map(n => ({ value: n, label: `${n} BB` }))} value={depth} onChange={setDepth} />
        <BlindsField smallBlind={smallBlind} bigBlind={bigBlind} onChange={(small, big) => { setSmallBlind(small); setBigBlind(big); }} />
        <details className="composer-more"><summary>Customize table & bots<Icon name="chevron" size={15} /></summary><div className="details-content">
          <div className="form-pair"><label>Players<select value={players} onChange={e => setPlayers(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 2}>{i + 2} players</option>)}</select></label><label>Starting stack · BB<input required type="number" min={minimumBB} max={maximumBB} step="1" value={depth} onChange={e => setDepth(Number(e.target.value))} /></label></div>
          <div className="form-pair"><label>Small blind<input required type="number" min="1" step="1" value={smallBlind} onChange={e => setSmallBlind(Number(e.target.value))} /></label><label>Big blind<input required type="number" min={smallBlind} step="1" value={bigBlind} onChange={e => setBigBlind(Number(e.target.value))} /></label></div>
          <div className="form-pair"><label>Minimum buy-in · BB<input required type="number" min="1" max={depth} step="1" value={minimumBB} onChange={e => setMinimumBB(Number(e.target.value))} /></label><label>Maximum buy-in · BB<input required type="number" min={depth} step="1" value={maximumBB} onChange={e => setMaximumBB(Number(e.target.value))} /></label></div>
          <label>Ante<input required type="number" min="0" step="1" value={ante} onChange={e => setAnte(Number(e.target.value))} /></label>
          <label>Bot Playing Strategy<StrategySelect value={strategy} onChange={setStrategy} /></label>
          <label>Time to act<select value={timeLimit ?? ''} onChange={e => setTimeLimit(e.target.value ? Number(e.target.value) as ActionTimeLimitSeconds : null)}><option value="">No time limit</option>{actionTimeLimits.map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select><small className="muted">When time runs out, you check, or fold if you can’t check.</small></label>
          <label className="check-label"><input type="checkbox" checked={seatChanges} onChange={e => setSeatChanges(e.target.checked)} />Allow seat changes between hands</label>
        </div></details>
        <button className="primary start-practice" type="submit" disabled={!valid}>{command.busy ? 'Preparing your table…' : 'Start practice'}<Icon name="arrow" size={19} /></button>
        <p className="composer-note"><Icon name="info" size={15} /><span>Simple Heuristic uses basic hand strength and modest bets. Scores compare your play with a reference; they don’t measure poker skill.</span></p>
      </fieldset>
    </form>
  </Composer>;
}

/** Online creation: the table size and stakes up front, as at a Practice Table, and everything else under progressive disclosure. */
function OnlineComposer({ id, command, ready, displayName, launch }: { id: string; command: Command; ready: boolean; displayName?: string; launch: (request: CreateTableSessionRequest) => void }) {
  const [setup, setSetup] = useState(defaultOnlineSetup);
  const problem = onlineSetupProblem(setup);
  // The password's own problem shows under it; the form's summary notice covers everything else.
  const passwordProblem = tablePasswordProblem(setup.tablePassword);
  const number = (key: keyof typeof setup) => (e: { target: { value: string } }) => setSetup({ ...setup, [key]: Number(e.target.value) });
  const resize = (seatCount: number) => setSetup({ ...setup, seatCount, bots: Math.min(setup.bots, seatCount - 1) });
  const seats = Array.from({ length: setup.seatCount }, (_, i): SeatMark => i === 0 ? 'you' : i <= setup.bots ? 'taken' : 'open');
  const botCount = setup.bots ? ` · ${setup.bots} ${setup.bots === 1 ? 'Bot' : 'Bots'}` : '';
  return <Composer id={id} label="New online table" seats={seats} felt={`${tableFormat(setup.seatCount)} table with ${setup.seatCount} seats${botCount}`} summary={feltCentre(setup.smallBlind, setup.bigBlind, setup.bigBlind * setup.startingStackBB)}>
    <form onSubmit={e => { e.preventDefault(); const request = onlineCreationRequest(setup, crypto.randomUUID()); if (request) launch(request); }}>
      <fieldset disabled={command.busy || !ready}>
        <p className="composer-summary"><strong>{tableFormat(setup.seatCount)} Hold’em</strong><span>{setup.seatCount} seats{botCount} · {setup.actionTimeLimitSeconds}s to act</span></p>
        <Segmented legend="Size" name="online-size" options={sizes} value={setup.seatCount} onChange={resize} />
        {/* Not an error while it is still being typed: the hint says what it takes, and Create waits for it. */}
        <PasswordField className="composer-field" id={`${id}-password`} label={<>Table password <span className="field-optional">optional</span></>} name="tablePassword" value={setup.tablePassword} placeholder="None: anyone with the address joins" autoComplete="new-password" aria-describedby={setup.tablePassword ? `${id}-password-hint` : undefined} onChange={e => setSetup({ ...setup, tablePassword: e.target.value })}
          note={setup.tablePassword && <small id={`${id}-password-hint`} className={passwordProblem ? 'field-hint is-short' : 'field-hint'}>{passwordProblem ? '4 to 64 characters. Capitals count.' : 'Capitals count. Tell it to the people you invite.'}</small>} />
        <BlindsField smallBlind={setup.smallBlind} bigBlind={setup.bigBlind} onChange={(smallBlind, bigBlind) => setSetup({ ...setup, smallBlind, bigBlind })} />
        <details className="composer-more"><summary>More table options<Icon name="chevron" size={15} /></summary><div className="details-content">
          <label>Seats<select value={setup.seatCount} onChange={e => resize(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 2}>{i + 2} seats</option>)}</select></label>
          <div className="form-pair"><label>Small blind<input required type="number" min="1" step="1" value={setup.smallBlind} onChange={number('smallBlind')} /></label><label>Big blind<input required type="number" min={setup.smallBlind} step="1" value={setup.bigBlind} onChange={number('bigBlind')} /></label></div>
          <div className="form-pair"><label>Ante<input required type="number" min="0" step="1" value={setup.ante} onChange={number('ante')} /></label><label>Starting stack · BB<input required type="number" min={setup.minimumBuyInBB} max={setup.maximumBuyInBB} step="1" value={setup.startingStackBB} onChange={number('startingStackBB')} /></label></div>
          <div className="form-pair"><label>Minimum buy-in · BB<input required type="number" min="1" max={setup.startingStackBB} step="1" value={setup.minimumBuyInBB} onChange={number('minimumBuyInBB')} /></label><label>Maximum buy-in · BB<input required type="number" min={setup.startingStackBB} step="1" value={setup.maximumBuyInBB} onChange={number('maximumBuyInBB')} /></label></div>
          <label>Time to act<select value={setup.actionTimeLimitSeconds} onChange={e => setSetup({ ...setup, actionTimeLimitSeconds: Number(e.target.value) as ActionTimeLimitSeconds })}>{actionTimeLimits.map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
          <label className="check-label"><input type="checkbox" checked={setup.allowLiveAnalysis} onChange={e => setSetup({ ...setup, allowLiveAnalysis: e.target.checked })} />Allow Live Analysis at this table</label>
          <label className="check-label"><input type="checkbox" checked={setup.allowSeatChanges} onChange={e => setSetup({ ...setup, allowSeatChanges: e.target.checked })} />Allow seat changes between hands</label>
          <div className="form-pair"><label>Bots<select value={setup.bots} onChange={number('bots')}>{Array.from({ length: setup.seatCount }, (_, i) => <option key={i} value={i}>{i === 0 ? 'No bots' : i === 1 ? '1 bot' : `${i} bots`}</option>)}</select></label>{setup.bots > 0 && <label>Bot Playing Strategy<StrategySelect value={setup.botStrategy} onChange={botStrategy => setSetup({ ...setup, botStrategy })} /></label>}</div>
        </div></details>
        {problem && problem !== passwordProblem && <p className="notice-error" role="alert">{problem}</p>}
        <button className="primary start-practice" type="submit" disabled={!!problem}>{command.busy ? 'Creating your table…' : 'Create online table'}<Icon name="arrow" size={19} /></button>
        <p className="composer-note"><Icon name="info" size={15} /><span>{displayName ? `You join first as ${displayName} and choose your seat.` : 'You join first and choose your seat.'} You’ll get a link to share.</span></p>
      </fieldset>
    </form>
  </Composer>;
}
