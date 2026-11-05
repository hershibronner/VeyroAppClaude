import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import '../home/insights.css';

const Workflows = lazy(() => import('./Workflows'));
const Runs = lazy(() => import('./Runs'));

export const routes: RouteObject[] = [
  { path: '/automation', element: <Workflows /> },
  { path: '/automation/runs', element: <Runs /> },
];
