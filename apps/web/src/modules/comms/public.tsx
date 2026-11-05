import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import '../home/insights.css';

const Outbox = lazy(() => import('./Outbox'));
const WebhookLog = lazy(() => import('./WebhookLog'));

export const publicRoutes: RouteObject[] = [
  { path: '/dev/outbox', element: <Outbox /> },
  { path: '/dev/webhooks', element: <WebhookLog /> },
];
