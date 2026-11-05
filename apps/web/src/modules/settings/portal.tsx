import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const ClientRequest = lazy(() => import('./portal/ClientRequest'));
const ClientUsers = lazy(() => import('./portal/ClientUsers'));
const ClientSettings = lazy(() => import('./portal/ClientSettings'));
const WorkerProfile = lazy(() => import('./portal/WorkerProfile'));
const WorkerTraining = lazy(() => import('./portal/WorkerTraining'));

export const portalRoutes: { client: RouteObject[]; worker: RouteObject[] } = {
  client: [{ path: 'request', element: <ClientRequest /> }, { path: 'users', element: <ClientUsers /> }, { path: 'settings', element: <ClientSettings /> }],
  worker: [{ path: 'profile', element: <WorkerProfile /> }, { path: 'training', element: <WorkerTraining /> }],
};
