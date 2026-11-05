import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { PortalKind } from '../../portals/PortalShell';

const PortalMessages = lazy(() => import('./PortalMessages'));
const WorkerNotifications = lazy(() => import('./WorkerNotifications'));

export const portalRoutes: Partial<Record<PortalKind, RouteObject[]>> = {
  client: [{ path: 'messages', element: <PortalMessages kind="client" /> }],
  worker: [{ path: 'messages', element: <PortalMessages kind="worker" /> }, { path: 'notifications', element: <WorkerNotifications /> }],
};
