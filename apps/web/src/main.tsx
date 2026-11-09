import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from '@tanstack/react-router';
import { AppShell, NotFound } from './app-shell.js';
import { TablesScreen } from './session-browser.js';
import { TableScreen } from './trainer.js';
import { JoinTable } from './join-table.js';
import { tableSearch } from './table-address.js';
import './styles.css';

// The shell is the root layout: every page renders inside it, so moving between pages never remounts it.
const root = createRootRoute({ component: AppShell, notFoundComponent: NotFound });
const index = createRoute({ getParentRoute: () => root, path: '/', beforeLoad: () => { throw redirect({ to: '/practice', replace: true }); } });
const practice = createRoute({ getParentRoute: () => root, path: '/practice', component: () => <TablesScreen key="practice" mode="practice" /> });
const practiceTable = createRoute({ getParentRoute: () => root, path: '/practice/$tableSessionId', validateSearch: tableSearch, component: function PracticeTable() { const { tableSessionId } = practiceTable.useParams(); return <TableScreen key={tableSessionId} mode="practice" tableSessionId={tableSessionId} />; } });
const online = createRoute({ getParentRoute: () => root, path: '/online', component: () => <TablesScreen key="online" mode="online" /> });
const onlineTable = createRoute({ getParentRoute: () => root, path: '/online/$tableSessionId', validateSearch: tableSearch, component: function OnlineTable() { const { tableSessionId } = onlineTable.useParams(); return <TableScreen key={tableSessionId} mode="online" tableSessionId={tableSessionId} />; } });
const joinRoute = createRoute({ getParentRoute: () => root, path: '/join/$token', component: function JoinRoute() { return <JoinTable token={joinRoute.useParams().token} />; } });
const router = createRouter({ routeTree: root.addChildren([index, practice, practiceTable, online, onlineTable, joinRoute]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
