import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const SmartImport = lazy(() => import('./SmartImport'));

export const routes: RouteObject[] = [
  { path: '/onboarding/import', element: <SmartImport /> },
];
