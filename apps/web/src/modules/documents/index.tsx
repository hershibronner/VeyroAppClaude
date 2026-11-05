import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import '../home/insights.css';

const Library = lazy(() => import('./Library'));
const DocumentDetail = lazy(() => import('./DocumentDetail'));
const DocTemplates = lazy(() => import('./DocTemplates'));
const Signatures = lazy(() => import('./Signatures'));
const Compliance = lazy(() => import('./Compliance'));

export const routes: RouteObject[] = [
  { path: '/documents', element: <Library /> },
  { path: '/documents/templates', element: <DocTemplates /> },
  { path: '/documents/signatures', element: <Signatures /> },
  { path: '/documents/compliance', element: <Compliance /> },
  { path: '/documents/:id', element: <DocumentDetail /> },
];
