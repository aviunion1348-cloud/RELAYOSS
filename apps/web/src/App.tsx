import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { auth, type SessionInfo } from './lib/api';
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

/**
 * The deployment description, fetched once.
 *
 * This is **not** a guard. Nothing is withheld while it loads, nothing redirects
 * when it fails, and there is no branch in which the application refuses to show
 * itself. It answers one question — who is this workspace operating as — so the
 * shell can greet them and show a role. If the request fails, the shell falls back
 * to the values `/api/meta` already returns, and the dashboard still renders.
 *
 * The previous `SessionGate` was the opposite: it rendered nothing until
 * `GET /api/auth/session` succeeded, and on failure it rendered a sign-in screen.
 * That is why an API that could not boot produced a login page instead of the
 * product.
 */
function useSession() {
  const { data } = useQuery({
    queryKey: ['session'],
    queryFn: () => auth.me(),
    retry: false,
    staleTime: Infinity,
  });
  return data;
}

/**
 * The application.
 *
 * `/` is the dashboard. Every route is reachable directly, with no gate, no
 * sign-in screen, and no loading state that can become a dead end.
 */
export default function App() {
  const session = useSession();
  return (
    <Shell session={session}>
      <AppRoutes />
    </Shell>
  );
}

function AppRoutes() {
  return (
    <>
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

          {/*
            Retired URLs, redirected rather than 404'd.

            `/login` and `/signin` were real addresses in earlier deployments, so
            bookmarks and pasted links to them exist. The catch-all below would
            already send them to the dashboard, but naming them explicitly means
            the intent is readable here and survives a future narrowing of the
            catch-all.
          */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/signin" element={<Navigate to="/" replace />} />
          <Route path="/sign-in" element={<Navigate to="/" replace />} />

          {/* Any other URL shows the dashboard instead of a dead end. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
