import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { PortalKind } from '../../portals/PortalShell';

const ClientInvoices = lazy(() => import('./ClientInvoices'));
const ClientInvoiceDetail = lazy(() => import('./ClientInvoiceDetail'));
const WorkerPay = lazy(() => import('./WorkerPay'));
const WorkerExpenses = lazy(() => import('./WorkerExpenses'));

export const portalRoutes: Partial<Record<PortalKind, RouteObject[]>> = {
  client: [{ path: 'invoices', element: <ClientInvoices /> }, { path: 'invoices/:id', element: <ClientInvoiceDetail /> }],
  worker: [{ path: 'pay', element: <WorkerPay /> }, { path: 'expenses', element: <WorkerExpenses /> }],
};
