import { Suspense, lazy, useEffect, useState, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, auth, AUTH_EXPIRED_EVENT, type SessionInfo } from './lib/api';
import { SignIn } from './pages/SignIn';
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
 * Session gate. The shell never renders before we know who the user is, so no
 * screen can flash data that the API would refuse — and permission-gated controls
 * are decided from server-verified claims, not optimistic client state.
 */
function SessionGate({ children }: { children: (session: SessionInfo) => ReactElement }) {
  const [expired, setExpired] = useState(false);

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => auth.me(),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-950">
        <Loading />
      </div>
    );
  }

  if (session.isError || expired) {
    /**
     * Pass the failure through.
     *
     * It used to be dropped on the floor (`info={null}`), which left the sign-in
     * screen unable to distinguish "nobody is signed in" from "this deployment is
     * broken" — and the screen then guessed, wrongly, that the API was not running.
     * A session probe that failed for a reason other than 401 means the app itself
     * cannot work, and that belongs on screen before a password is ever typed.
     *
     * A 401 is the normal, expected answer for an anonymous visitor, so it is not
     * surfaced: `expired` already covers the transition, and the refetch path
     * covers recovery.
     */
    const probeError = session.isError ? session.error : null;
    const isAnonymous = probeError instanceof ApiError && probeError.status === 401;

    return (
      <SignIn
        info={null}
        probeError={isAnonymous ? null : probeError}
        onSignedIn={() => {
          setExpired(false);
          void session.refetch();
        }}
      />
    );
  }

  return children(session.data!);
}

export default function App() {
  return (
    <SessionGate>
      {(session) => (
        <Shell session={session}>
          <AppRoutes />
        </Shell>
      )}
    </SessionGate>
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
