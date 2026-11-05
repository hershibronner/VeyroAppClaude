import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

const Live = lazy(() => import('./Live'));
const Timesheets = lazy(() => import('./Timesheets'));
const TimesheetDetail = lazy(() => import('./TimesheetDetail'));
const Attendance = lazy(() => import('./Attendance'));
const Screenshots = lazy(() => import('./Screenshots'));
const TimeOff = lazy(() => import('./TimeOff'));
const Manual = lazy(() => import('./Manual'));
const Activity = lazy(() => import('./Activity'));
const Clock = lazy(() => import('./Clock'));

export const routes: RouteObject[] = [
  { path: '/time', element: <Navigate to="/time/live" replace /> },
  { path: '/time/live', element: <Live /> },
  { path: '/time/timesheets', element: <Timesheets /> },
  { path: '/time/timesheets/:id', element: <TimesheetDetail /> },
  { path: '/time/attendance', element: <Attendance /> },
  { path: '/time/screenshots', element: <Screenshots /> },
  { path: '/time/time-off', element: <TimeOff /> },
  { path: '/time/manual', element: <Manual /> },
  { path: '/time/activity', element: <Activity /> },
  { path: '/time/clock', element: <Clock /> },
];
