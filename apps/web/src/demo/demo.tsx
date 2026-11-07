import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Trainer } from '../trainer.js';
import { useSession } from '../session.js';
import { installDemoBackend, type DemoBehavior, type DemoScenario } from './backend.js';
import './demo.css';

interface Entry { readonly id: string; readonly group: string; readonly label: string; readonly description: string }
type Fixture = Omit<DemoScenario, 'behavior'> & Entry;

const modules = import.meta.glob<{ default: unknown }>('./fixtures/*.json');
const load = async <T,>(name: string): Promise<T> => {
  const loader = modules[`./fixtures/${name}.json`];
  if (!loader) throw new Error(`No demo fixture named ${name}.`);
  return (await loader()).default as T;
};

/** States the server cannot be recorded in, built from a recorded table by changing how the fake server answers. */
const synthetic: readonly (Entry & { readonly from: string; readonly behavior?: DemoBehavior; readonly empty?: boolean })[] = [
  { id: 'home-empty', group: 'Home', label: 'Tables home, nothing saved', description: 'First visit: the Tables screen with no saved tables.', from: 'home-saved-tables', empty: true },
  { id: 'loading-table', group: 'Problems', label: 'Table loading', description: 'The table request never finishes: skeletons for the table and the analysis panel.', from: 'practice-preflop-your-turn', behavior: 'loading' },
  { id: 'error-table', group: 'Problems', label: 'Table failed to open', description: 'The server answers with an error when the table is read.', from: 'practice-preflop-your-turn', behavior: 'error' },
  { id: 'server-offline', group: 'Problems', label: 'Server unreachable', description: 'Nothing answers: the connection notice over a saved table.', from: 'practice-preflop-your-turn', behavior: 'offline' },
  { id: 'live-connecting', group: 'Problems', label: 'Live updates connecting', description: 'The table is readable but the live connection has not come up.', from: 'practice-preflop-your-turn', behavior: 'connecting' },
];

async function entries(): Promise<readonly Entry[]> {
  const recorded = await load<Entry[]>('index');
  return [...recorded, ...synthetic.map(({ id, group, label, description }) => ({ id, group, label, description }))];
}
async function scenario(id: string): Promise<DemoScenario | null> {
  const made = synthetic.find(s => s.id === id);
  if (made) {
    const base = await load<Fixture>(made.from);
    return { ...base, id, savedTables: made.empty ? [] : base.savedTables, home: made.empty ? true : base.home, ...(made.behavior ? { behavior: made.behavior } : {}) };
  }
  return (await entries()).some(e => e.id === id) ? load<Fixture>(id) : null;
}

function useEntries() {
  const [list, setList] = useState<readonly Entry[] | null>(null);
  useEffect(() => { void entries().then(setList); }, []);
  return list;
}

export function DemoIndex() {
  const list = useEntries();
  const groups = useMemo(() => [...new Set(list?.map(e => e.group))].map(group => ({ group, items: list!.filter(e => e.group === group) })), [list]);
  return <main className="demo-index">
    <h1>Demo tables</h1>
    <p>Recorded table states, served without a game server, for comparing the interface. Open the same state in each version to compare them. Actions are switched off.</p>
    {groups.map(({ group, items }) => <section key={group}><h2>{group}</h2><ul>{items.map(e => <li key={e.id}><Link to="/demo/$state" params={{ state: e.id }}><strong>{e.label}</strong><span>{e.description}</span></Link></li>)}</ul></section>)}
  </main>;
}

export function DemoState({ stateId }: { stateId: string }) {
  const list = useEntries();
  const [data, setData] = useState<{ id: string; scenario: DemoScenario | null } | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => { let live = true; void scenario(stateId).then(s => { if (live) setData({ id: stateId, scenario: s }); }); return () => { live = false; }; }, [stateId]);
  const current = data?.id === stateId ? data.scenario : undefined;
  return <>
    <DemoBar stateId={stateId} list={list} restart={() => setRun(n => n + 1)} />
    {current === null && <main className="demo-index"><h1>No such demo table</h1><p><Link to="/demo">See all demo tables</Link></p></main>}
    {current && <MountedScenario key={`${stateId}:${run}`} scenario={current} />}
  </>;
}

function MountedScenario({ scenario: s }: { scenario: DemoScenario }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // The Demo Table borrows the saved-table selection and gives the real one back when it goes.
    const { selectedId, pending, setup, analysisOpen } = useSession.getState();
    const restore = installDemoBackend(s);
    useSession.setState({ selectedId: s.home ? null : s.session.tableSessionId, pending: null, setup: null, analysisOpen: true });
    setReady(true);
    return () => { restore(); useSession.setState({ selectedId, pending, setup, analysisOpen }); setReady(false); };
  }, [s]);
  return ready ? <QueryClientProvider client={client}><Trainer /></QueryClientProvider> : null;
}

function DemoBar({ stateId, list, restart }: { stateId: string; list: readonly Entry[] | null; restart: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const index = list?.findIndex(e => e.id === stateId) ?? -1;
  const go = (id: string) => void navigate({ to: '/demo/$state', params: { state: id } });
  const step = (by: number) => { if (list && index >= 0) go(list[(index + by + list.length) % list.length]!.id); };
  const label = list?.[index]?.label ?? stateId;
  return <aside className="demo-bar" data-open={open ? '' : undefined} aria-label="Demo table controls">
    <button className="demo-bar-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}><span className="demo-bar-badge">Demo</span><span className="demo-bar-label">{label}</span></button>
    {open && <div className="demo-bar-panel">
      <label>State<select value={stateId} onChange={e => go(e.target.value)}>
        {[...new Set(list?.map(e => e.group))].map(group => <optgroup key={group} label={group}>{list!.filter(e => e.group === group).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</optgroup>)}
      </select></label>
      <p>{list?.[index]?.description}</p>
      <div className="demo-bar-actions"><button onClick={() => step(-1)}>Previous</button><button onClick={() => step(1)}>Next</button><button onClick={restart}>Restart</button><Link to="/demo">All states</Link></div>
    </div>}
  </aside>;
}
