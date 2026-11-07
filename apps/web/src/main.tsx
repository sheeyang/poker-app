import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { Trainer } from './trainer.js';
import { JoinTable } from './join-table.js';
import './styles.css';

const root = createRootRoute({ component: () => <Outlet /> });
const route = createRoute({ getParentRoute: () => root, path: '/', component: Trainer });
const joinRoute = createRoute({ getParentRoute: () => root, path: '/join/$token', component: function JoinRoute() { return <JoinTable token={joinRoute.useParams().token} />; } });
// Demo Tables serve recorded states for reviewing the interface; they exist only under `vite dev`.
const DemoIndex = import.meta.env.DEV ? React.lazy(() => import('./demo/demo.js').then(m => ({ default: m.DemoIndex }))) : null;
const DemoState = import.meta.env.DEV ? React.lazy(() => import('./demo/demo.js').then(m => ({ default: m.DemoState }))) : null;
const demoIndexRoute = DemoIndex && createRoute({ getParentRoute: () => root, path: '/demo', component: () => <React.Suspense fallback={null}><DemoIndex /></React.Suspense> });
const demoStateRoute = DemoState && createRoute({ getParentRoute: () => root, path: '/demo/$state', component: function DemoRoute() { return <React.Suspense fallback={null}><DemoState stateId={demoStateRoute!.useParams().state} /></React.Suspense>; } });
const demoRoutes = demoIndexRoute && demoStateRoute ? [demoIndexRoute, demoStateRoute] : [];
const router = createRouter({ routeTree: root.addChildren([route, joinRoute, ...demoRoutes]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
