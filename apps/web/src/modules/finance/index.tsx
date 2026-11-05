import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Overview = lazy(() => import('./Overview'));
const Rates = lazy(() => import('./Rates'));
const Invoices = lazy(() => import('./Invoices'));
const InvoiceNew = lazy(() => import('./InvoiceNew'));
const InvoiceDetail = lazy(() => import('./InvoiceDetail'));
const AR = lazy(() => import('./AR'));
const Payroll = lazy(() => import('./Payroll'));
const PayrollRun = lazy(() => import('./PayrollRun'));
const Payouts = lazy(() => import('./Payouts'));
const PayoutDetail = lazy(() => import('./PayoutDetail'));
const Commissions = lazy(() => import('./Commissions'));
const Margin = lazy(() => import('./Margin'));
const Expenses = lazy(() => import('./Expenses'));

export const routes: RouteObject[] = [
  { path: '/finance', element: <Overview /> },
  { path: '/finance/rates', element: <Rates /> },
  { path: '/finance/invoices', element: <Invoices /> },
  { path: '/finance/invoices/new', element: <InvoiceNew /> },
  { path: '/finance/invoices/:id', element: <InvoiceDetail /> },
  { path: '/finance/ar', element: <AR /> },
  { path: '/finance/payroll', element: <Payroll /> },
  { path: '/finance/payroll/:id', element: <PayrollRun /> },
  { path: '/finance/payouts', element: <Payouts /> },
  { path: '/finance/payouts/:id', element: <PayoutDetail /> },
  { path: '/finance/commissions', element: <Commissions /> },
  { path: '/finance/margin', element: <Margin /> },
  { path: '/finance/expenses', element: <Expenses /> },
];
