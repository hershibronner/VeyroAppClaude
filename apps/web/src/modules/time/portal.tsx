import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const W = (k: string) => lazy(() => import('./WorkerPages').then(m => ({ default: (m as any)[k] })));
const C = (k: string) => lazy(() => import('./ClientPages').then(m => ({ default: (m as any)[k] })));
const Tracker = lazy(() => import('./Tracker'));
const WToday = W('Today'), WSchedule = W('Schedule'), WTimesheets = W('Timesheets'), WTimeOff = W('TimeOff'), WOnboarding = W('Onboarding'), WPerformance = W('Performance');
const CHome = C('Home'), CTeam = C('Team'), CWorker = C('WorkerDetail'), CTimesheets = C('Timesheets');

export const portalRoutes: { worker: RouteObject[]; client: RouteObject[] } = {
  worker: [
    { index: true, element: <WToday /> },
    { path: 'tracker', element: <Tracker /> },
    { path: 'schedule', element: <WSchedule /> },
    { path: 'timesheets', element: <WTimesheets /> },
    { path: 'time-off', element: <WTimeOff /> },
    { path: 'onboarding', element: <WOnboarding /> },
    { path: 'performance', element: <WPerformance /> },
  ],
  client: [
    { index: true, element: <CHome /> },
    { path: 'team', element: <CTeam /> },
    { path: 'team/:workerId', element: <CWorker /> },
    { path: 'timesheets', element: <CTimesheets /> },
  ],
};
