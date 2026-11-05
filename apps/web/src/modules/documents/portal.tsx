import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { PortalKind } from '../../portals/PortalShell';

const PortalDocuments = lazy(() => import('./PortalDocuments'));

export const portalRoutes: Partial<Record<PortalKind, RouteObject[]>> = {
  client: [{ path: 'documents', element: <PortalDocuments kind="client" /> }],
  worker: [{ path: 'documents', element: <PortalDocuments kind="worker" /> }],
};
