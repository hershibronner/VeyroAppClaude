import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { PortalKind } from '../../portals/PortalShell';

const C = (name: string) => lazy(() => import('./CandidatePortal').then(m => ({ default: (m as any)[name] })));
const K = (name: string) => lazy(() => import('./ClientPortal').then(m => ({ default: (m as any)[name] })));
const CProfile = C('Profile'), CMedia = C('Media'), CApps = C('Applications'), CAssess = C('Assessments'), CInt = C('Interviews'), COffers = C('Offers'), CDocs = C('Documents'), CAvail = C('Availability'), CMsg = C('Messages');
const KCands = K('ClientCandidates'), KCand = K('ClientCandidate'), KInt = K('ClientInterviews');

export const portalRoutes: Partial<Record<PortalKind, RouteObject[]>> = {
  candidate: [
    { index: true, element: <CProfile /> }, { path: 'media', element: <CMedia /> }, { path: 'applications', element: <CApps /> }, { path: 'assessments', element: <CAssess /> },
    { path: 'interviews', element: <CInt /> }, { path: 'offers', element: <COffers /> }, { path: 'documents', element: <CDocs /> }, { path: 'availability', element: <CAvail /> }, { path: 'messages', element: <CMsg /> },
  ],
  client: [{ path: 'candidates', element: <KCands /> }, { path: 'candidates/:id', element: <KCand /> }, { path: 'interviews', element: <KInt /> }],
};
