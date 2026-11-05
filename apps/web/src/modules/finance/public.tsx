import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const PayPage = lazy(() => import('./PayPage'));

export const publicRoutes: RouteObject[] = [{ path: '/pay/:token', element: <PayPage /> }];
