import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { Trainer } from './trainer.js';
import './styles.css';

const root = createRootRoute({ component: () => <Outlet /> });
const route = createRoute({ getParentRoute: () => root, path: '/', component: Trainer });
const router = createRouter({ routeTree: root.addChildren([route]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
