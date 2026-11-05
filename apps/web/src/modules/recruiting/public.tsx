import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Apply = lazy(() => import('./Apply'));

export const publicRoutes: RouteObject[] = [
  { path: '/apply/:slug', element: <Apply /> },
  { path: '/apply/:slug/r/:token', element: <Apply kind="r" /> },
  { path: '/apply/:slug/p/:token', element: <Apply kind="p" /> },
];
