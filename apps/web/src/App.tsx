import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { auth, type SessionInfo } from './lib/api';
import { Shell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
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
  /*
   * `grain` and `vignette` are ambient layers rendered behind everything: a 3% noise
   * field so a large black display reads as a surface rather than a switched-off
   * screen, and a soft vignette that pulls the eye to the content. Both are
   * `pointer-events: none` and fixed, so they never move under scroll and never
   * intercept a click.
   */
  return (
    <div className="grain vignette">
      <Shell session={session}>
        <AppRoutes />
      </Shell>
    </div>
  );
}

/**
 * Every routed screen runs inside its own boundary.
 *
 * Written as a function rather than repeated JSX so a future route cannot be
 * added without one: `<Screen>` is the only shape used below.
 */
function Screen({ name, children }: { name: string; children: ReactNode }) {
  return <ErrorBoundary what={name}>{children}</ErrorBoundary>;
}

function AppRoutes() {
  return (
    <>
      {/*
        Two boundaries, both scoped to content.

        The inner one wraps the routed screen: a render crash in one page leaves
        the shell intact, so the reader can navigate away instead of staring at a
        blank tab. The outer one wraps the lazy chunks — a failed dynamic import
        (a stale deployment, an asset 404 after a redeploy) rejects during the
        Suspense boundary's render, and without a boundary above it that rejection
        unmounts the application.

        `resetKeys`-style behaviour is not needed because the boundary remounts:
        the key is the pathname, so navigating to another route clears the error.
      */}
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Screen name="Dashboard"><Dashboard /></Screen>} />
          <Route path="/board" element={<Screen name="Board"><Board /></Screen>} />
          <Route path="/pipeline" element={<Screen name="Pipeline"><Pipeline /></Screen>} />
          <Route path="/clocks" element={<Screen name="Clocks"><Clocks /></Screen>} />
          <Route path="/projects" element={<Screen name="Projects"><Projects /></Screen>} />
          <Route path="/projects/:id" element={<Screen name="ProjectDetail"><ProjectDetail /></Screen>} />
          <Route path="/workload" element={<Screen name="Workload"><Workload /></Screen>} />
          <Route path="/qa" element={<Screen name="QACentre"><QACentre /></Screen>} />
          <Route path="/releases" element={<Screen name="Releases"><Releases /></Screen>} />
          <Route path="/clients" element={<Screen name="Clients"><Clients /></Screen>} />
          <Route path="/partners" element={<Screen name="Partners"><Partners /></Screen>} />
          <Route path="/intel" element={<Screen name="Intelligence"><Intelligence /></Screen>} />
          <Route path="/docs" element={<Screen name="Docs"><Docs /></Screen>} />

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
