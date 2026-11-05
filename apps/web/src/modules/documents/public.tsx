import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const SignPage = lazy(() => import('./SignPage'));

export const publicRoutes: RouteObject[] = [{ path: '/sign/:token', element: <SignPage /> }];
