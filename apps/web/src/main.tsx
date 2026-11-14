import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from '@tanstack/react-router';
import { AppShell, NotFound } from './app-shell.js';
import { TablesScreen } from './session-browser.js';
import { TableScreen } from './trainer.js';
import { tableSearch } from './table-address.js';
import './styles.css';

// The shell is the root layout: every page renders inside it, so moving between pages never remounts it.
const root = createRootRoute({ component: AppShell, notFoundComponent: NotFound });
const index = createRoute({ getParentRoute: () => root, path: '/', beforeLoad: () => { throw redirect({ to: '/practice', replace: true }); } });
const practice = createRoute({ getParentRoute: () => root, path: '/practice', component: () => <TablesScreen key="practice" mode="practice" /> });
const practiceTable = createRoute({ getParentRoute: () => root, path: '/practice/$tableSessionId', validateSearch: tableSearch, component: function PracticeTable() { const { tableSessionId } = practiceTable.useParams(); return <TableScreen key={tableSessionId} mode="practice" tableSessionId={tableSessionId} />; } });
const online = createRoute({ getParentRoute: () => root, path: '/online', component: () => <TablesScreen key="online" mode="online" /> });
const onlineTable = createRoute({ getParentRoute: () => root, path: '/online/$tableSessionId', validateSearch: tableSearch, component: function OnlineTable() { const { tableSessionId } = onlineTable.useParams(); return <TableScreen key={tableSessionId} mode="online" tableSessionId={tableSessionId} />; } });
const router = createRouter({ routeTree: root.addChildren([index, practice, practiceTable, online, onlineTable]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
const app = <React.StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>;
const mount = createRoot(document.getElementById('root')!);
// The motion lab (ADR-0040) is development only: `import.meta.env.DEV` is false in a production build, so this branch, the
// page and its styles are not part of it. It needs no server, so it takes the page whole instead of the app shell.
if (import.meta.env.DEV && location.pathname.replace(/\/$/, '') === '/motion-lab') void import('./motion-lab.js').then(({ MotionLabPage }) => mount.render(<React.StrictMode><MotionLabPage /></React.StrictMode>));
else mount.render(app);
