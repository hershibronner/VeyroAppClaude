import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

// Portals overview + aliases for the design handoff's navigation paths (old deep links keep working).
const Portals = lazy(() => import('./Portals'));
const Compliance = lazy(() => import('../documents/Compliance'));
const TimeOff = lazy(() => import('../time/TimeOff'));
const Profile = lazy(() => import('../../pages/Profile'));

export const routes: RouteObject[] = [
  { path: '/portals', element: <Portals /> },
  { path: '/workforce/compliance', element: <Compliance /> },
  { path: '/workforce/time-off', element: <TimeOff /> },
  { path: '/settings/profile', element: <Profile /> },
  { path: '/home', element: <Navigate to="/" replace /> },
];
