import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Skeleton } from './components/ui';
import Dashboard from './pages/Dashboard';
import Board from './pages/Board';

const Pipeline = lazy(() => import('./pages/Pipeline'));
const Clocks = lazy(() => import('./pages/Clocks'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const Workload = lazy(() => import('./pages/Workload'));
const QACentre = lazy(() => import('./pages/QACentre'));
const Releases = lazy(() => import('./pages/Releases'));
const Clients = lazy(() => import('./pages/Clients'));
const Partners = lazy(() => import('./pages/Partners'));
const Intelligence = lazy(() => import('./pages/Intelligence'));
const Docs = lazy(() => import('./pages/Docs'));

function Loading() {
  return (
    <div className="grid gap-3 p-5">
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export default function App() {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/board" element={<Board />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/clocks" element={<Clocks />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/workload" element={<Workload />} />
          <Route path="/qa" element={<QACentre />} />
          <Route path="/releases" element={<Releases />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/partners" element={<Partners />} />
          <Route path="/intel" element={<Intelligence />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
