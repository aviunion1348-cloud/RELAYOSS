/**
 * Sign-in.
 *
 * Production: an authorization-code redirect to the configured OIDC issuer (the
 * button is disabled and labelled when the IdP is not configured — it never
 * pretends to work).
 *
 * Development: pick a seeded identity and start a real server-side session. The
 * banner is explicit about what mode you are in, because mistaking a dev session
 * for production authentication is exactly how demo auth reaches production.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { auth, type SessionInfo, AUTH_EXPIRED_EVENT } from '../lib/api';
import { Button, Card } from '../components/ui';
import { Icons } from '../components/icons';
import { cls } from '../lib/cls';

interface DevUser {
  id: string;
  name: string;
  role: string;
  title: string;
  initials: string;
  color: string;
}

export function SignIn({ info, onSignedIn }: { info: SessionInfo | null; onSignedIn: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);

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

  const isDev = !info || info.authMode === 'dev';

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
          {isDev ? (
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
                <p className="py-6 text-center text-[12px] text-rose-300">
                  Could not load identities. Is the API running on :4000?
                </p>
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
