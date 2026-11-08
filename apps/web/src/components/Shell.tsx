/** Application shell: rail sidebar, top bar, command palette, live clock strip. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icons } from './icons';
import { api } from '../lib/api';
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
      <div className="relative grid size-7 place-items-center rounded-lg bg-gradient-to-b from-iris-400 to-iris-600 shadow-[0_2px_10px_-2px_rgb(124_92_255/0.9),inset_0_1px_0_0_rgb(255_255_255/0.35)]">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 18V6h5.5a3.5 3.5 0 010 7H10l7 5" />
        </svg>
      </div>
      <div className="leading-none">
        <div className="text-[13px] font-semibold tracking-tight text-white">Relay <span className="text-mist-500">OSS</span></div>
        <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.14em] text-mist-500">Delivery OS</div>
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
        className="w-[min(620px,92vw)] overflow-hidden rounded-xl border border-ink-500 bg-ink-850 shadow-[0_24px_80px_-20px_rgb(0_0_0/0.9)] animate-rise"
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

export function Shell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const { data: meta } = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const { data: notifications } = useQuery({ queryKey: ['notifications'], queryFn: api.notifications });
  const [showNotifs, setShowNotifs] = useState(false);

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
      <aside className="sticky top-0 hidden h-screen w-[228px] shrink-0 flex-col border-r border-ink-700/80 bg-ink-900/80 lg:flex">
        <div className="px-4 pb-4 pt-4">
          <Logo />
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
          {NAV.map((group) => (
            <div key={group.group} className="mb-4">
              <p className="mb-1 px-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-mist-500/70">{group.group}</p>
              {group.items.map((item) => {
                const Icon = Icons[item.icon] as React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      cls(
                        'group relative flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-[12.5px] font-medium transition-colors',
                        isActive
                          ? 'bg-gradient-to-r from-iris-500/16 to-transparent text-white'
                          : 'text-mist-400 hover:bg-ink-800 hover:text-mist-200',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-iris-400" />}
                        <Icon size={14.5} strokeWidth={isActive ? 2.2 : 1.8} className={isActive ? 'text-iris-300' : 'text-mist-500 group-hover:text-mist-400'} />
                        <span className="flex-1">{item.label}</span>
                        {item.hint && <span className="hidden font-mono text-[9.5px] text-mist-500/60 group-hover:inline">{item.hint}</span>}
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
            className="flex w-full items-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-2 py-1.5 text-[11.5px] text-mist-500 transition-colors hover:border-ink-500 hover:text-mist-300"
          >
            <Icons.Search size={12} />
            <span className="flex-1 text-left">Search…</span>
            <Kbd>⌘K</Kbd>
          </button>
          {meta && (
            <div className="mt-2 flex items-center gap-2 rounded-lg px-1.5 py-1.5">
              <Avatar name={meta.currentUser.name} initials={meta.currentUser.initials} color={meta.currentUser.color} size={26} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[11.5px] font-medium text-mist-200">{meta.currentUser.name}</p>
                <p className="truncate text-[10px] text-mist-500">{meta.currentUser.title}</p>
              </div>
              <Badge tone="iris" className="shrink-0">{meta.currentUser.role}</Badge>
            </div>
          )}
        </div>
      </aside>

      {/* --------------------------------------------------------- content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-ink-700/80 bg-ink-900/85 px-3 backdrop-blur-xl sm:px-4">
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
            <ClockStrip />
            <div className="relative">
              <Button variant="ghost" size="sm" onClick={() => setShowNotifs((s) => !s)} className="relative">
                <Icons.Bell size={14} />
                {unread > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-rose-500" />}
              </Button>
              {showNotifs && (
                <div className="absolute right-0 top-10 z-40 w-[340px] overflow-hidden rounded-xl border border-ink-500 bg-ink-850 shadow-2xl animate-rise">
                  <div className="flex items-center justify-between border-b border-ink-600 px-3 py-2">
                    <p className="text-[12px] font-semibold text-white">Notifications</p>
                    <Badge tone="neutral">{unread} unread</Badge>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto">
                    {(notifications ?? []).map((n) => (
                      <button
                        key={n.id}
                        onClick={() => api.readNotification(n.id)}
                        className="flex w-full gap-2.5 border-b border-ink-700/60 px-3 py-2.5 text-left last:border-0 hover:bg-ink-800"
                      >
                        <span className={cls('mt-1 size-1.5 shrink-0 rounded-full', n.readAt ? 'bg-ink-500' : 'bg-iris-400')} />
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-medium text-mist-200">{n.title}</span>
                          <span className="block text-[11px] leading-snug text-mist-500">{n.body}</span>
                          <span className="mt-0.5 block text-[10px] text-mist-500/70">{relTime(n.createdAt)}</span>
                        </span>
                      </button>
                    ))}
                    {(notifications ?? []).length === 0 && <p className="px-3 py-8 text-center text-[11.5px] text-mist-500">You're all caught up.</p>}
                  </div>
                </div>
              )}
            </div>
            <div className="hidden items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850 px-2 py-1 sm:flex">
              <Dot tone="mint" pulse />
              <span className="text-[10.5px] font-medium text-mist-400">API live</span>
            </div>
            {meta && (
              <div className="flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850 py-0.5 pl-0.5 pr-2">
                <Avatar name={meta.currentUser.name} initials={meta.currentUser.initials} color={meta.currentUser.color} size={22} />
                <span className="hidden text-[11px] font-medium text-mist-300 sm:inline">{meta.currentUser.name.split(' ')[0]}</span>
              </div>
            )}
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
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-700/70 px-4 pb-3.5 pt-4 sm:px-5 sm:pb-4 sm:pt-5">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-mist-500">{eyebrow}</div>}
        <h1 className="text-[19px] font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-[92ch] text-[12px] leading-relaxed text-mist-500">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function MoneyLabel({ cents }: { cents: number }) {
  return <span className="tabular">{inr(cents, { compact: true })}</span>;
}
