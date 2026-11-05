import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { PortalKind } from '../../portals/PortalShell';

const WorkerTasks = lazy(() => import('./WorkerTasks'));

export const portalRoutes: Partial<Record<PortalKind, RouteObject[]>> = {
  worker: [{ path: 'tasks', element: <WorkerTasks /> }],
};
