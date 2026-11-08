import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

// Public client sign-up pages (Leads → Generate link).
const IntakeFlow = lazy(() => import('./IntakeFlow'));
export const publicRoutes: RouteObject[] = [
  { path: '/hire/:slug', element: <IntakeFlow /> },
  { path: '/hire/:slug/l/:token', element: <IntakeFlow /> },
];
