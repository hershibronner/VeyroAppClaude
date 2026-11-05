import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const General = lazy(() => import('./General'));
const Team = lazy(() => import('./Team'));
const Roles = lazy(() => import('./Roles'));
const Billing = lazy(() => import('./Billing'));
const Integrations = lazy(() => import('./Integrations'));
const Portals = lazy(() => import('./Policies').then(m => ({ default: m.PortalsPage })));
const AI = lazy(() => import('./Policies').then(m => ({ default: m.AiPage })));
const Monitoring = lazy(() => import('./Policies').then(m => ({ default: m.MonitoringPage })));
const Payroll = lazy(() => import('./Policies').then(m => ({ default: m.PayrollPage })));
const Invoices = lazy(() => import('./Policies').then(m => ({ default: m.InvoicePage })));
const Onboarding = lazy(() => import('./Onboarding'));
const Equipment = lazy(() => import('./Equipment'));
const CustomFields = lazy(() => import('./CustomFieldsPage'));
const Notifications = lazy(() => import('./Notifications'));
const Import = lazy(() => import('./Import'));
const Api = lazy(() => import('./Api'));
const ApiDocs = lazy(() => import('./ApiDocs'));
const Audit = lazy(() => import('./Audit'));

export const routes: RouteObject[] = [
  { path: '/settings', element: <General /> },
  { path: '/settings/team', element: <Team /> },
  { path: '/settings/roles', element: <Roles /> },
  { path: '/settings/billing', element: <Billing /> },
  { path: '/settings/integrations', element: <Integrations /> },
  { path: '/settings/portals', element: <Portals /> },
  { path: '/settings/ai', element: <AI /> },
  { path: '/settings/onboarding', element: <Onboarding /> },
  { path: '/settings/equipment', element: <Equipment /> },
  { path: '/settings/monitoring', element: <Monitoring /> },
  { path: '/settings/payroll', element: <Payroll /> },
  { path: '/settings/invoices', element: <Invoices /> },
  { path: '/settings/custom-fields', element: <CustomFields /> },
  { path: '/settings/notifications', element: <Notifications /> },
  { path: '/settings/import', element: <Import /> },
  { path: '/settings/api', element: <Api /> },
  { path: '/settings/api/docs', element: <ApiDocs /> },
  { path: '/settings/audit', element: <Audit /> },
];
