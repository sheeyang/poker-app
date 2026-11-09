import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link, Outlet, useParams, useRouter, useRouterState } from '@tanstack/react-router';
import { api, useTableSynchronization, type LiveConsumers } from '@poker/client';
import type { ObservableTableSession, TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { CommandFeedback } from './controls.js';
import { useCommand, type Command } from './session.js';
import { listPath, pageTitle, tablePath, type Page } from './table-address.js';

type TableConsumers = Pick<LiveConsumers, 'onReady' | 'onAnalysisUpdate'>;
interface Shell {
  readonly identity: UseQueryResult<Awaited<ReturnType<typeof api.establishIdentity>>>;
  readonly command: Command;
  readonly live: ReturnType<typeof useTableSynchronization>;
  /** The open table's analysis consumers: the table page registers them, the shell's one live connection feeds them. */
  readonly consumeLive: (consumers: TableConsumers | null) => void;
}
const ShellContext = createContext<Shell | null>(null);
export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell needs the app shell.');
  return shell;
}

/** The section an address belongs to: each mode's list and tables, an Online Table's Join Link included. */
function sectionOf(pathname: string): TableMode | undefined {
  const first = pathname.split('/')[1];
  return first === 'practice' ? 'practice' : first === 'online' ? 'online' : undefined;
}

/** Sets the browser-tab title while a page is shown. */
export function usePageTitle(page: Page | undefined) {
  const title = page && pageTitle(page);
  useEffect(() => { if (title) document.title = title; }, [title]);
}

/**
 * The layout every page renders inside: the header and its tabs, the command state and the live connection.
 * Navigating between pages never remounts it, so in-flight requests and the live connection survive.
 */
export function AppShell() {
  const queryClient = useQueryClient(), router = useRouter();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const tableSessionId = useParams({ strict: false }).tableSessionId ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity });
  const command = useCommand();
  const consumers = useRef<TableConsumers | null>(null);
  const [consumeLive] = useState(() => (next: TableConsumers | null) => { consumers.current = next; });
  const live = useTableSynchronization(tableSessionId, identity.isSuccess, {
    // Left after the Hand, or removed: the server says so when it happens, and a Guest looking at that table returns to its list.
    onMembershipEnded: ended => {
      const mode = queryClient.getQueryData<ObservableTableSession>(['table-session', ended.tableSessionId])?.mode ?? 'online';
      if (router.state.location.pathname === tablePath(mode, ended.tableSessionId)) void router.navigate({ href: listPath(mode), replace: true });
      queryClient.removeQueries({ queryKey: ['table-session', ended.tableSessionId] });
      void queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
      setNotice(ended.reason === 'left' ? 'You left the table.' : 'The Table Owner removed you from that table.');
    },
    onReady: lifecycle => consumers.current?.onReady?.(lifecycle),
    onAnalysisUpdate: (update, lifecycle) => consumers.current?.onAnalysisUpdate?.(update, lifecycle),
  });
  const shell: Shell = { identity, command, live, consumeLive };
  const atTable = tableSessionId !== null;
  // A notice about leaving belongs to the list it returned to, not to the next table.
  useEffect(() => { if (atTable) setNotice(null); }, [atTable]);
  const section = sectionOf(pathname);
  return <ShellContext.Provider value={shell}>
    <div className={`app-shell${atTable ? ' table-active' : ''}`}>
      <a className="skip-link" href="#main-table">{atTable ? 'Skip to table' : 'Skip to content'}</a>
      <header className="app-header">
        <Link className="brand" to="/practice" aria-label="Poker Trainer · Practice tables"><span className="brand-mark"><Icon name="spade" size={23} /></span><strong>Poker<span className="brand-divider" /> <span>Trainer</span></strong></Link>
        <nav aria-label="Sections">
          <Link to="/practice" className={section === 'practice' ? 'nav-active' : undefined} aria-current={pathname === '/practice' ? 'page' : section === 'practice' ? 'location' : undefined}><Icon name="cards" size={18} /><span>Practice</span></Link>
          <Link to="/online" className={section === 'online' ? 'nav-active' : undefined} aria-current={pathname === '/online' ? 'page' : section === 'online' ? 'location' : undefined}><Icon name="tables" size={18} /><span>Online</span></Link>
        </nav>
        <span className="identity-status">{identity.isError ? 'Connection unavailable' : identity.isSuccess ? 'Progress saved automatically' : 'Connecting…'}</span>
      </header>
      {!atTable && <>
        <CommandFeedback command={command} />
        {identity.isError && <div className="global-notice notice-error" role="alert"><div><strong>Couldn’t connect to the poker server.</strong><p>Your tables are saved. Try again in a moment.</p></div><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
        {notice && <div className="global-notice" role="status"><div><strong>{notice}</strong></div><button onClick={() => setNotice(null)}>Dismiss</button></div>}
      </>}
      <Outlet />
    </div>
  </ShellContext.Provider>;
}

/** Any address the Trainer doesn't have. */
export function NotFound() {
  usePageTitle({ page: 'not-found' });
  return <main id="main-table" className="address-missing">
    <Icon name="cards" size={34} />
    <h1>There’s nothing at this address.</h1>
    <p>The link may be mistyped, or the page may have moved.</p>
    <Link className="primary address-missing-link" to="/practice">Go to Practice tables <Icon name="arrow" size={18} /></Link>
  </main>;
}
