import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import '../home/insights.css';

const Inbox = lazy(() => import('./Inbox'));
const Templates = lazy(() => import('./Templates'));
const Notifications = lazy(() => import('./Notifications'));

export const routes: RouteObject[] = [
  { path: '/comms/inbox', element: <Inbox /> },
  { path: '/comms/templates', element: <Templates /> },
  { path: '/comms/notifications', element: <Notifications /> },
];
