import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

const Leads = lazy(() => import('./Leads'));
const LeadDetail = lazy(() => import('./LeadDetail'));
const Clients = lazy(() => import('./Clients'));
const ClientDetail = lazy(() => import('./ClientDetail'));
const CompanyRedirect = lazy(() => import('./CompanyRedirect'));
const Contacts = lazy(() => import('./Contacts'));
const ContactDetail = lazy(() => import('./ContactDetail'));
const Opportunities = lazy(() => import('./Opportunities'));
const OpportunityDetail = lazy(() => import('./OpportunityDetail'));
const Tasks = lazy(() => import('./Tasks'));
const Activities = lazy(() => import('./Activities'));

export const routes: RouteObject[] = [
  { path: '/crm', element: <Navigate to="/crm/leads" replace /> },
  { path: '/crm/leads', element: <Leads /> },
  { path: '/crm/leads/:id', element: <LeadDetail /> },
  { path: '/crm/clients', element: <Clients /> },
  { path: '/crm/clients/:id', element: <ClientDetail /> },
  { path: '/crm/companies/:id', element: <CompanyRedirect /> },
  { path: '/crm/contacts', element: <Contacts /> },
  { path: '/crm/contacts/:id', element: <ContactDetail /> },
  { path: '/crm/opportunities', element: <Opportunities /> },
  { path: '/crm/opportunities/:id', element: <OpportunityDetail /> },
  { path: '/crm/tasks', element: <Tasks /> },
  { path: '/crm/activities', element: <Activities /> },
];
