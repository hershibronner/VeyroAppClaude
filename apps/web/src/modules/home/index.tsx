import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Home = lazy(() => import('./Home'));
const MyTasks = lazy(() => import('./MyTasks'));
const Attention = lazy(() => import('./Attention'));

export const routes: RouteObject[] = [
  { index: true, element: <Home /> },
  { path: '/my-tasks', element: <MyTasks /> },
  { path: '/attention', element: <Attention /> },
];
