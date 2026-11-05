import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Help = lazy(() => import('./Help'));
const Tickets = lazy(() => import('./Tickets'));

export const routes: RouteObject[] = [
  { path: '/help', element: <Help /> },
  { path: '/help/tickets', element: <Tickets /> },
];
