import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import '../home/insights.css';

const Executive = lazy(() => import('./Executive'));
const Recruiting = lazy(() => import('./Recruiting'));
const Sales = lazy(() => import('./Sales'));
const Finance = lazy(() => import('./Finance'));
const Workforce = lazy(() => import('./Workforce'));
const Reports = lazy(() => import('./Reports'));

export const routes: RouteObject[] = [
  { path: '/analytics', element: <Executive /> },
  { path: '/analytics/recruiting', element: <Recruiting /> },
  { path: '/analytics/sales', element: <Sales /> },
  { path: '/analytics/finance', element: <Finance /> },
  { path: '/analytics/workforce', element: <Workforce /> },
  { path: '/analytics/reports', element: <Reports /> },
];
