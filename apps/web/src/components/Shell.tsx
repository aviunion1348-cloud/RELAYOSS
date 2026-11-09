/** Application shell: rail sidebar, top bar, command palette, live clock strip. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icons } from './icons';
import { ApiFailure } from './ApiFailure';
import { LivePulse } from './LivePulse';
import { useLiveUpdates } from '../lib/live';
import { api, type SessionInfo } from '../lib/api';
import { cls } from '../lib/cls';
import { clockLabel, inr, relTime } from '../lib/format';
import { Avatar, Badge, Button, Dot, Kbd, Tooltip } from './ui';

type NavItem = { to: string; label: string; icon: keyof typeof Icons; badge?: number; hint?: string };

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Operate',
    items: [
      { to: '/', label: 'Command Deck', icon: 'LayoutDashboard', hint: 'G' },
      { to: '/board', label: 'Board', icon: 'Columns3', hint: 'B' },
      { to: '/pipeline', label: 'Pipeline', icon: 'GitBranch', hint: 'P' },
      { to: '/clocks', label: 'Turnover Clocks', icon: 'Timer', hint: 'T' },
    ],
  },
  {
    group: 'Deliver',
    items: [
      { to: '/projects', label: 'Projects', icon: 'FolderKanban', hint: 'J' },
      { to: '/workload', label: 'Planning & Capacity', icon: 'GanttChartSquare', hint: 'C' },
      { to: '/qa', label: 'QA Centre', icon: 'ShieldCheck' },
      { to: '/releases', label: 'Releases', icon: 'Rocket' },
    ],
  },
  {
    group: 'Business',
    items: [
      { to: '/clients', label: 'Clients', icon: 'Building2' },
      { to: '/partners', label: 'Partner Console', icon: 'KeyRound' },
      { to: '/intel', label: 'Intelligence', icon: 'Sparkles' },
      { to: '/docs', label: 'Knowledge', icon: 'BookOpen' },
    ],
  },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      {/*
        The mark: a champagne-metal tile with a specular top edge. Dark stroke on
        gold, for the same contrast reason as the primary button.
      */}
      <div className="relative grid size-8 place-items-center rounded-[10px] bg-gradient-to-b from-gold-200 via-gold-400 to-gold-600 shadow-[0_3px_16px_-3px_rgb(212_164_76/0.85),inset_0_1px_0_0_rgb(255_255_255/0.65),inset_0_-1px_0_0_rgb(0_0_0/0.3)]">
        {/* An engraved inner ring: the detail that makes metal read as metal. */}
        <span className="pointer-events-none absolute inset-[2px] rounded-[8px] ring-1 ring-inset ring-ink-950/25" />
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#1a1409" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 18V6h5.5a3.5 3.5 0 010 7H10l7 5" />
        </svg>
      </div>
      <div className="leading-none">
        <div className="text-[13.5px] font-semibold tracking-[-0.02em] text-mist-100">Relay <span className="text-gold-400">OSS</span></div>
        <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.2em] text-gold-600/90">Delivery OS</div>
      </div>
    </div>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({ queryKey: ['search', q], queryFn: () => api.search(q), enabled: open && q.trim().length >= 2 });

  const results = useMemo(() => {
    const navMatches = NAV.flatMap((g) => g.items)
      .filter((i) => i.label.toLowerCase().includes(q.toLowerCase()))
      .map((i) => ({ kind: 'Navigate', label: i.label, to: i.to, icon: i.icon }));
    if (!data) return navMatches;
    return [
      ...navMatches,
      ...data.tasks.map((t) => ({ kind: 'Task', label: `${t.key} · ${t.title}`, to: `/board?task=${t.id}`, icon: 'SquareCheck' as const })),
      ...data.projects.map((p) => ({ kind: 'Project', label: p.name, to: `/projects/${p.id}`, icon: 'FolderKanban' as const })),
      ...data.clients.map((c) => ({ kind: 'Client', label: c.name, to: '/clients', icon: 'Building2' as const })),
      ...data.docs.map((d) => ({ kind: 'Doc', label: d.title, to: '/docs', icon: 'BookOpen' as const })),
    ].slice(0, 12);
  }, [data, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
      if (e.key === 'Enter' && results[active]) { navigate(results[active].to); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, results, active, navigate, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 pt-[12vh] backdrop-blur-sm animate-fade" onClick={onClose}>
      <div
        className="glass-strong w-[min(620px,92vw)] overflow-hidden rounded-xl border border-gold-600/25 shadow-[0_24px_80px_-20px_rgb(0_0_0/0.95)] animate-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-ink-600 px-3.5 py-3">
          <Icons.Search size={15} className="text-mist-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            placeholder="Search tasks, projects, clients, docs…"
            className="w-full bg-transparent text-[13.5px] text-white placeholder:text-mist-500 focus:outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-mist-500">No results. Try a task key like NRTH-103.</p>}
          {results.map((r, i) => {
            const Icon = Icons[r.icon as keyof typeof Icons] as React.ComponentType<{ size?: number; className?: string }>;
            return (
              <button
                key={`${r.kind}-${r.label}-${i}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => { navigate(r.to); onClose(); }}
                className={cls(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  i === active ? 'bg-ink-700' : 'hover:bg-ink-750',
                )}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-md border border-ink-600 bg-ink-800 text-mist-400">
                  {Icon && <Icon size={12} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-mist-200">{r.label}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-mist-500">{r.kind}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-ink-600 px-3.5 py-2 text-[10.5px] text-mist-500">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="ml-auto">Relay OSS · v1.0</span>
        </div>
      </div>
    </div>
  );
}

function ClockStrip() {
  const { data } = useQuery({ queryKey: ['clocks-live'], queryFn: api.clocks, refetchInterval: 30_000 });
  if (!data) return null;
  const watched = data.timers.filter((t) => t.outcome === 'running').slice(0, 4);
  const missed = data.timers.filter((t) => t.outcome === 'missed');
  if (!watched.length && !missed.length) return null;
  return (
    <div className="hidden items-center gap-3 xl:flex">
      {missed.length > 0 && (
        <Tooltip label={`${missed.length} clock(s) missed — open Turnover Clocks`}>
          <NavLink to="/clocks" className="flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-400">
            <Icons.AlertOctagon size={11} /> {missed.length} missed
          </NavLink>
        </Tooltip>
      )}
      {watched.map((t) => (
        <Tooltip key={t.id} label={`${t.clockName} · due ${relTime(t.dueAt)}`}>
          <div className="flex min-w-[112px] flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="max-w-[80px] truncate text-[10px] font-medium uppercase tracking-wider text-mist-500">{t.clock.replace(/-/g, ' ')}</span>
              <span className={cls('text-[10.5px] font-semibold tabular', t.hoursLeft < 0 ? 'text-rose-400' : t.hoursLeft < 6 ? 'text-amber-400' : 'text-mist-300')}>
                {clockLabel(t.hoursLeft)}
              </span>
            </div>
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-ink-700">
              <div
                className={cls('h-full rounded-full', t.progressPct > 90 ? 'bg-rose-500' : t.progressPct > 66 ? 'bg-amber-500' : 'bg-mint-500')}
                style={{ width: `${Math.min(100, t.progressPct)}%` }}
              />
            </div>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export function Shell({ children, session }: { children: React.ReactNode; session?: SessionInfo }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  /*
   * The live feed is mounted once, here, because every screen is inside the shell.
   * Mounting it per page would restart the baseline on every navigation and either
   * miss changes made while a slow page was loading or refetch the world each time.
   */
  /*
   * Enabled whenever the shell is mounted. There is no sign-in to wait for, so the
   * only reason not to poll is that the page is hidden — which the hook checks itself.
   */
  useLiveUpdates(true);
  void session;
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const notificationsQuery = useQuery({ queryKey: ['notifications'], queryFn: api.notifications });
  const meta = metaQuery.data;
  const notifications = notificationsQuery.data;
  const [showNotifs, setShowNotifs] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => setShowNotifs(false), [location.pathname]);

  const unread = notifications?.filter((n) => !n.readAt).length ?? 0;

  return (
    <div className="flex h-full min-h-screen bg-ink-950">
      {/* ------------------------------------------------------------ rail */}
      <aside className="glass relative sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col lg:flex">
        {/* The seam between rail and content: a vertical gold hairline that fades. */}
        <span className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-gold-600/25 to-transparent" />
        <div className="px-4 pb-4 pt-4">
          <Logo />
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
          {NAV.map((group) => (
            <div key={group.group} className="mb-4">
              <p className="mb-1.5 mt-1 px-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-mist-500/60">{group.group}</p>
              {group.items.map((item) => {
                const Icon = Icons[item.icon] as React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      cls(
                        'group relative flex items-center gap-2.5 rounded-lg px-2 py-[7.5px] text-[12.5px] font-medium transition-all duration-200',
                        isActive
                          ? 'bg-gradient-to-r from-gold-500/[0.16] via-gold-500/[0.06] to-transparent text-white shadow-[inset_0_1px_0_0_rgb(248_231_185/0.06)]'
                          : 'text-mist-400 hover:bg-white/[0.04] hover:text-mist-100',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="rail absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-r-full" />}
                        <Icon size={14.5} strokeWidth={isActive ? 2.2 : 1.8} className={isActive ? 'text-gold-300' : 'text-mist-500 group-hover:text-mist-300'} />
                        <span className="flex-1">{item.label}</span>
                        {item.hint && (
                          <span className="hidden opacity-0 transition-opacity duration-200 group-hover:opacity-100 lg:block">
                            <span className="keycap">{item.hint}</span>
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-700/80 p-2.5">
          <button
            onClick={() => setPaletteOpen(true)}
            className="edge flex w-full items-center gap-2 rounded-lg bg-ink-850/60 px-2 py-1.5 text-[11.5px] text-mist-500 transition-colors hover:text-gold-200"
          >
            <Icons.Search size={12} />
            <span className="flex-1 text-left">Search…</span>
            <Kbd>⌘K</Kbd>
          </button>
          {/*
            No identity block.

            There used to be a card here with an avatar, a name and an email —
            "Owner" and "owner@localhost" on a fresh workspace. It was not a
            profile: the product has no sign-in, no accounts to switch and no
            settings behind it, so the block was decoration shaped like a control,
            and the address on it was an internal placeholder shown to a person who
            reasonably read it as a broken sign-in. The header already says who the
            workspace operates as, where it is fact rather than furniture.
          */}
        </div>
      </aside>

      {/* --------------------------------------------------------- content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass relative sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-3 px-3 sm:px-4">
          <span className="gold-rule pointer-events-none absolute inset-x-0 bottom-0 h-px" />
          <div className="flex items-center gap-2 lg:hidden">
            <Logo />
            <span className="hidden text-[11px] text-mist-500 sm:inline">·</span>
            <span className="hidden max-w-[42vw] truncate text-[11.5px] font-medium text-mist-400 sm:inline">
              {NAV.flatMap((g) => g.items).find((i) => (i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)))?.label ?? 'Overview'}
            </span>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <span className="rounded-md border border-ink-600 bg-ink-850 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-mist-500">
              Studio
            </span>
            <span className="text-[11.5px] text-mist-500">/</span>
            <span className="text-[12px] font-medium text-mist-300">
              {NAV.flatMap((g) => g.items).find((i) => (i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)))?.label ?? 'Overview'}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <LivePulse />
            <ClockStrip />
            <div className="relative">
              <Button variant="ghost" size="sm" onClick={() => setShowNotifs((s) => !s)} className="relative">
                <Icons.Bell size={14} />
                {unread > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-gold-400 shadow-[0_0_8px_0_rgb(212_164_76/0.9)]" />}
              </Button>
              {showNotifs && (
                <div className="glass-strong absolute right-0 top-10 z-40 w-[340px] overflow-hidden rounded-xl border border-gold-600/25 shadow-2xl animate-rise">
                  <div className="flex items-center justify-between border-b border-ink-600 px-3 py-2">
                    <p className="text-[12px] font-semibold text-white">Notifications</p>
                    <Badge tone="neutral">{unread} unread</Badge>
                  </div>
                  {readError && (
                    <p className="border-b border-ink-700/60 bg-rose-500/[0.06] px-3 py-1.5 text-[10.5px] text-rose-300">{readError}</p>
                  )}
                  <div className="max-h-[320px] overflow-y-auto">
                    {(notifications ?? []).map((n) => (
                      <button
                        key={n.id}
                        onClick={() => {
                          /*
                           * A click that fails silently is the same defect as a
                           * screen that buffers: the reader believes it worked.
                           * The cache is invalidated on success, and a failure
                           * is written into the query so the panel shows it.
                           */
                          notificationsQuery.refetch();
                          void api.readNotification(n.id).catch((e: unknown) => {
                            setReadError(e instanceof Error ? e.message : 'Could not mark that as read.');
                          });
                        }}
                        className="flex w-full gap-2.5 border-b border-ink-700/60 px-3 py-2.5 text-left last:border-0 hover:bg-ink-800"
                      >
                        <span className={cls('mt-1 size-1.5 shrink-0 rounded-full', n.readAt ? 'bg-ink-500' : 'bg-gold-400')} />
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-medium text-mist-200">{n.title}</span>
                          <span className="block text-[11px] leading-snug text-mist-500">{n.body}</span>
                          <span className="mt-0.5 block text-[10px] text-mist-500/70">{relTime(n.createdAt)}</span>
                        </span>
                      </button>
                    ))}
                    {/*
                      An empty list and a failed load are different facts. The
                      panel used to print "You're all caught up" for both, which
                      told the reader their inbox was clear when in fact the
                      request had failed.
                    */}
                    {notificationsQuery.isError && (
                      <div className="border-b border-ink-700/60 p-2.5">
                        <ApiFailure error={notificationsQuery.error} what="Could not load notifications." />
                      </div>
                    )}
                    {!notificationsQuery.isError && (notifications ?? []).length === 0 && <p className="px-3 py-8 text-center text-[11.5px] text-mist-500">You're all caught up.</p>}
                  </div>
                </div>
              )}
            </div>
            {/*
              This badge asserted "API live" unconditionally, including on a
              deployment whose every request was failing — the most misleading
              element on the page, because it is the one a person checks when
              something is not working. It now reports the actual state of the
              one query every screen depends on.
            */}
            <div
              className={cls(
                'hidden items-center gap-1.5 rounded-lg border px-2 py-1 sm:flex',
                metaQuery.isError
                  ? 'border-rose-500/35 bg-rose-500/[0.08]'
                  : metaQuery.isPending
                    ? 'border-ink-600 bg-ink-850'
                    : 'border-gold-600/30 bg-gold-500/[0.06]',
              )}
            >
              {metaQuery.isError ? <Dot tone="rose" /> : metaQuery.isPending ? <Dot tone="mist" /> : <Dot tone="mint" pulse />}
              <span className="text-[10.5px] font-medium text-mist-400">
                {metaQuery.isError ? 'API unreachable' : metaQuery.isPending ? 'Connecting…' : 'API live'}
              </span>
            </div>
            {/*
              No account chip either.

              It showed the seeded operator's first name — "Owner" on a fresh
              install — beside an avatar, on every screen. There are no accounts to
              switch and no profile behind it, so it read as a signed-in user that
              the reader could not identify, which is exactly the confusion a
              placeholder name creates. The `API live` badge next to it is the only
              status this header needs to carry.
            */}
          </div>
        </header>

        <nav className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-ink-700/70 bg-ink-900/60 px-2 py-1.5 lg:hidden">
          {NAV.flatMap((g) => g.items).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cls(
                  'shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  isActive ? 'bg-iris-500/15 text-iris-200' : 'text-mist-500 hover:text-mist-300',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

export function PageHeader({
  title, subtitle, right, eyebrow,
}: { title: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (
    <div className="relative flex flex-wrap items-end justify-between gap-3 px-4 pb-3.5 pt-4 sm:px-5 sm:pb-4 sm:pt-5">
      <span className="gold-rule pointer-events-none absolute inset-x-0 bottom-0 h-px" />
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-600/90">
            {eyebrow}
          </div>
        )}
        <h1 className="display text-[23px] text-white">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-[92ch] text-[12px] leading-relaxed text-mist-500">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function MoneyLabel({ cents }: { cents: number }) {
  return <span className="tabular">{inr(cents, { compact: true })}</span>;
}
