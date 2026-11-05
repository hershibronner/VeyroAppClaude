import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Workers = lazy(() => import('./Workers'));
const Worker360 = lazy(() => import('./Worker360'));
const Placements = lazy(() => import('./Placements'));
const PlacementNew = lazy(() => import('./PlacementNew'));
const PlacementDetail = lazy(() => import('./PlacementDetail'));
const Onboarding = lazy(() => import('./Onboarding'));
const Issues = lazy(() => import('./Issues'));

export const routes: RouteObject[] = [
  { path: '/workforce', element: <Workers tab="all" /> },
  { path: '/workforce/workers', element: <Workers tab="all" /> },
  { path: '/workforce/workers/:id', element: <Worker360 /> },
  { path: '/workforce/active', element: <Workers key="active" tab="active" /> },
  { path: '/workforce/pending', element: <Workers key="pending" tab="pending" /> },
  { path: '/workforce/available', element: <Workers key="available" tab="available" /> },
  { path: '/workforce/on-leave', element: <Workers key="on_leave" tab="on_leave" /> },
  { path: '/workforce/inactive', element: <Workers key="inactive" tab="inactive" /> },
  { path: '/workforce/placements', element: <Placements /> },
  { path: '/workforce/placements/new', element: <PlacementNew /> },
  { path: '/workforce/placements/:id', element: <PlacementDetail /> },
  { path: '/workforce/onboarding', element: <Onboarding /> },
  { path: '/workforce/issues', element: <Issues /> },
];
