import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Overview = lazy(() => import('./Overview'));
const Positions = lazy(() => import('./Positions'));
const PositionDetail = lazy(() => import('./PositionDetail'));
const Candidates = lazy(() => import('./Candidates'));
const CandidateDetail = lazy(() => import('./CandidateDetail'));
const MySourced = lazy(() => import('./MySourced'));
const Applications = lazy(() => import('./Lists').then(m => ({ default: m.Applications })));
const Submissions = lazy(() => import('./Lists').then(m => ({ default: m.Submissions })));
const Interviews = lazy(() => import('./Lists').then(m => ({ default: m.Interviews })));
const Assessments = lazy(() => import('./Lists').then(m => ({ default: m.Assessments })));
const Offers = lazy(() => import('./Lists').then(m => ({ default: m.Offers })));
const TalentPool = lazy(() => import('./Candidates').then(m => ({ default: m.TalentPool })));

export const routes: RouteObject[] = [
  { path: '/recruiting', element: <Overview /> },
  { path: '/recruiting/positions', element: <Positions /> },
  { path: '/recruiting/positions/:id', element: <PositionDetail /> },
  { path: '/recruiting/candidates', element: <Candidates /> },
  { path: '/recruiting/candidates/:id', element: <CandidateDetail /> },
  { path: '/recruiting/my-sourced', element: <MySourced /> },
  { path: '/recruiting/applications', element: <Applications /> },
  { path: '/recruiting/submissions', element: <Submissions /> },
  { path: '/recruiting/interviews', element: <Interviews /> },
  { path: '/recruiting/assessments', element: <Assessments /> },
  { path: '/recruiting/talent-pool', element: <TalentPool /> },
  { path: '/recruiting/offers', element: <Offers /> },
];
