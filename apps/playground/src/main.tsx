import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { Playground } from './playground.js';
import './styles.css';
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const route = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Playground });
const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
