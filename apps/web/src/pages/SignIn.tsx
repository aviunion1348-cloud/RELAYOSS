/**
 * Sign-in.
 *
 * Three modes, in order of precedence — the server decides which is in force and
 * reports it as `authMode`, so this screen never shows a button that cannot work:
 *
 *   password  The shared internal login: one username, one password. This is the
 *             requested access model for this deployment. There is no registration
 *             link and no guest path, because neither exists on the server.
 *   dev       Pick a seeded identity and start a real server-side session. Only
 *             reachable while no shared credential is provisioned, and refused
 *             outright in production — the banner says so rather than implying the
 *             session is proof of identity.
 *   oidc      Redirect to the organisation's identity provider. Retained for
 *             multi-user use; not required for this deployment.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { auth, type SessionInfo, AUTH_EXPIRED_EVENT } from '../lib/api';
import { Button, Card } from '../components/ui';
import { Icons } from '../components/icons';
import { ApiFailure } from '../components/ApiFailure';
import { cls } from '../lib/cls';

interface DevUser {
  id: string;
  name: string;
  role: string;
  title: string;
  initials: string;
  color: string;
}

export function SignIn({
  info,
  probeError,
  onSignedIn,
}: {
  info: SessionInfo | null;
  /**
   * Why the session probe failed, when it failed for a reason other than 401.
   * Rendered above the form: if the deployment is not provisioned, no sign-in
   * can succeed, so saying so before the user types a password is the honest
   * order. `null` for an anonymous visitor, which is not a failure.
   */
  probeError?: unknown;
  onSignedIn: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const users = useQuery({
    queryKey: ['dev-identities'],
    queryFn: () => auth.users(),
    enabled: !info || info.authMode === 'dev',
    retry: false,
  });

  const signIn = useMutation({
    mutationFn: (userId: string) => auth.devLogin(userId),
    onSuccess: () => onSignedIn(),
  });

  const passwordSignIn = useMutation({
    mutationFn: () => auth.login(username, password),
    onSuccess: () => onSignedIn(),
  });

  const isPassword = info?.authMode === 'password';
  const isDev = !isPassword && (!info || info.authMode === 'dev');

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-950 px-4 py-10">
      <div className="aurora pointer-events-none absolute inset-x-0 -top-40 h-[520px] opacity-70" />
      <div className="relative w-full max-w-md">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-ink-600/80 bg-ink-900/80">
            <Icons.Sparkles size={20} className="text-iris-300" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-mist-100">Sign in to Relay</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-mist-500">
            Delivery governance for the studio — pipeline, turnover gates, QA and partner console.
          </p>
        </div>

        <Card className="p-5">
          {probeError ? (
            <div className="mb-4">
              <ApiFailure error={probeError} what="The session could not be checked." />
            </div>
          ) : null}

          {isPassword ? (
            <form
              className="space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (username.trim() && password) passwordSignIn.mutate();
              }}
            >
              <div>
                <label htmlFor="relay-username" className="mb-1.5 block text-[11.5px] font-medium text-mist-400">
                  Username
                </label>
                <input
                  id="relay-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-lg border border-ink-700/80 bg-ink-900/60 px-3 py-2 text-[13px] text-mist-100 placeholder:text-mist-600 focus:border-iris-500/60 focus:outline-none focus:ring-1 focus:ring-iris-500/40"
                  placeholder="Your Relay username"
                />
              </div>
              <div>
                <label htmlFor="relay-password" className="mb-1.5 block text-[11.5px] font-medium text-mist-400">
                  Password
                </label>
                <input
                  id="relay-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-ink-700/80 bg-ink-900/60 px-3 py-2 text-[13px] text-mist-100 placeholder:text-mist-600 focus:border-iris-500/60 focus:outline-none focus:ring-1 focus:ring-iris-500/40"
                  placeholder="Password"
                />
              </div>

              <Button
                type="submit"
                className="w-full justify-center"
                disabled={passwordSignIn.isPending || !username.trim() || !password}
              >
                {passwordSignIn.isPending ? 'Signing in…' : 'Sign in'}
              </Button>

              {passwordSignIn.isError && (
                <div role="alert">
                  <ApiFailure
                    error={passwordSignIn.error}
                    what="The sign-in attempt was not accepted."
                  />
                </div>
              )}

              <p className="pt-1 text-center text-[10.5px] leading-relaxed text-mist-600">
                One shared workspace login. Accounts are provisioned by the delivery lead — there is no
                self-registration.
              </p>
            </form>
          ) : isDev ? (
            <>
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
                <Icons.AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
                <p className="text-[11.5px] leading-relaxed text-amber-200/90">
                  <span className="font-medium">Local development authentication.</span> Sessions are real
                  server-side sessions, but identity is chosen rather than proven. This mode is refused when
                  <code className="mx-1 rounded bg-ink-800 px-1 py-0.5 text-[10.5px]">NODE_ENV=production</code>.
                </p>
              </div>

              {users.isLoading ? (
                <div className="flex items-center justify-center py-8 text-mist-500">
                  <Icons.Loader2 size={16} className="animate-spin" />
                </div>
              ) : users.isError ? (
                <div className="py-4">
                  <ApiFailure error={users.error} what="The demo identities could not be loaded." />
                </div>
              ) : (
                <div className="space-y-1.5">
                  {(users.data ?? []).map((u: DevUser) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => setSelected(u.id)}
                      className={cls(
                        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        selected === u.id
                          ? 'border-iris-500/60 bg-iris-500/10'
                          : 'border-ink-700/70 hover:border-ink-600 hover:bg-ink-800/40',
                      )}
                    >
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold text-ink-950"
                        style={{ background: u.color }}
                      >
                        {u.initials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-mist-200">{u.name}</span>
                        <span className="block truncate text-[11px] text-mist-500">
                          {u.title} · {u.role}
                        </span>
                      </span>
                      {selected === u.id && <Icons.Check size={13} className="text-iris-300" />}
                    </button>
                  ))}
                </div>
              )}

              <Button
                className="mt-4 w-full justify-center"
                disabled={!selected || signIn.isPending}
                onClick={() => selected && signIn.mutate(selected)}
              >
                {signIn.isPending ? 'Starting session…' : 'Continue'}
              </Button>
              {signIn.isError && (
                <p className="mt-2 text-center text-[11.5px] text-rose-300">
                  {(signIn.error as Error).message}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="mb-4 text-[12px] leading-relaxed text-mist-400">
                Single sign-on is enforced. You will be redirected to your organisation&apos;s identity
                provider and returned here with a verified session.
              </p>
              <Button
                className="w-full justify-center"
                disabled
                title="Requires OIDC_CLIENT_ID and a reachable identity provider"
              >
                Continue with SSO
              </Button>
              <p className="mt-2 text-center text-[11px] text-mist-500">
                Configured by your administrator. Contact the delivery lead if this is unexpected.
              </p>
            </>
          )}
        </Card>

        <p className="mt-5 text-center text-[10.5px] leading-relaxed text-mist-600">
          Session cookies are HttpOnly and SameSite=Lax. Mutations require a CSRF token bound to the session.
        </p>
      </div>
    </div>
  );
}

export { AUTH_EXPIRED_EVENT };
