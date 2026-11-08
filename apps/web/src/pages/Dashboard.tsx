/** Command Deck — the single screen a delivery principal opens at 9am. */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { clockLabel, inr, relTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure, StaleNotice } from '../components/QueryFailure';
import { hasFailed, useQueryState } from '../lib/query-state';
import {
  Avatar, Badge, Button, Card, Dot, Empty, HEALTH_TONE, PRIORITY_TONE, Progress, Ring, RISK_TONE, SectionHeader, Skeleton, STATUS_LABEL, STATUS_TONE,
} from '../components/ui';

const CHART = {
  grid: '#221d17',
  axis: '#8a8378',
};

export default function Dashboard() {
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 60_000 });
  const insightsQuery = useQuery({ queryKey: ['insights'], queryFn: api.insights });
  const activityQuery = useQuery({ queryKey: ['activity'], queryFn: () => api.activity(14) });

  const q = useQueryState(dashboard);
  const insights = insightsQuery.data;
  const activity = activityQuery.data;

  /*
   * All three queries feed this screen, so its failure state watches all three.
   * Previously only the dashboard query gated the skeleton — `insights` and
   * `activity` were read with a `?? []` fallback, which meant a broken panel
   * silently rendered as "nothing happened today" instead of as a fault.
   */
  const failed = [dashboard, insightsQuery, activityQuery].find((x) => hasFailed(x));

  if (failed) {
    return (
      <>
        <PageHeader eyebrow={<><Icons.LayoutDashboard size={11} /> Command deck</>} title="Command Deck" />
        <QueryFailure error={failed.error} what="the command deck" retry={() => { void dashboard.refetch(); }} />
      </>
    );
  }

  if (q.state !== 'ready') {
    return (
      <div className="grid gap-3 p-5">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[88px]" />)}</div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const data = q.data;
  const k = data.kpis;
  const maxStatus = Math.max(...Object.values(data.byStatus), 1);
  const topInsights = (insights?.insights ?? []).slice(0, 3);

  return (
    <div className="pb-10">
      {(dashboard.isError || insightsQuery.isError || activityQuery.isError) && (
        <div className="px-5 pt-3">
          <StaleNotice error={dashboard.error ?? insightsQuery.error ?? activityQuery.error} retry={q.refetch} />
        </div>
      )}
      {/* ------------------------------------------------------------ hero */}
      <div className="relative overflow-hidden border-b border-ink-700/70">
        <div className="pointer-events-none absolute inset-0 aurora opacity-90" />
        <div className="pointer-events-none absolute inset-0 grid-fade opacity-60" />
        <div className="relative px-5 pb-5 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-iris-500/30 bg-iris-500/10 px-2.5 py-1 text-[10.5px] font-medium text-iris-300">
                <span className="size-1.5 rounded-full bg-iris-400 pulse-dot" />
                Studio · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
              </div>
              <h1 className="text-balance text-[26px] font-semibold leading-tight tracking-[-0.02em] text-white">
                Good morning, {data.focus.length ? 'the deck is live.' : 'nothing urgent.'}
              </h1>
              <p className="mt-1.5 max-w-[86ch] text-[12.5px] leading-relaxed text-mist-400">
                {k.openTasks} open units of work across {data.projects.length} client projects ·{' '}
                <span className={k.slaBreaches > 0 ? 'text-rose-400' : 'text-mint-400'}>{k.slaBreaches} SLA breaches</span> ·{' '}
                <span className={k.blocked > 0 ? 'text-amber-400' : 'text-mist-400'}>{k.blocked} blocked</span> ·{' '}
                {inr(k.pipelineValueCents, { compact: true })} in the pipe, {inr(k.weightedCents, { compact: true })} weighted.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/board"><Button variant="secondary" size="md" icon="Columns3">Open board</Button></Link>
              <Link to="/workload"><Button variant="primary" size="md" icon="Sparkles">Run planner</Button></Link>
            </div>
          </div>

          {/* KPI rail */}
          <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4 2xl:grid-cols-6">
            <KpiTile label="In flight" value={k.inFlight} tone="iris" icon="Activity" sub={`${k.openTasks} open`} foot={<Progress value={Math.round((k.inFlight / Math.max(1, k.openTasks)) * 100)} tone="iris" />} />
            <KpiTile label="At risk" value={k.atRisk} tone="amber" icon="AlertTriangle" sub={`${k.turnoverBlocked} stuck at gates`} foot={<Progress value={Math.round((k.atRisk / Math.max(1, k.openTasks)) * 100)} tone="amber" />} />
            <KpiTile label="SLA breaches" value={k.slaBreaches} tone={k.slaBreaches > 0 ? 'rose' : 'mint'} icon="AlarmClock" sub="across open work" foot={<Progress value={Math.min(100, k.slaBreaches * 4)} tone="rose" />} />
            <KpiTile label="Shipped · 7d" value={k.shippedThisWeek} tone="mint" icon="PackageCheck" sub={`${k.billableHoursWeek}h billed this week`} foot={<Progress value={Math.min(100, k.shippedThisWeek * 5)} tone="mint" />} />
            <KpiTile label="Pipeline" value={inr(k.pipelineValueCents, { compact: true })} tone="sky" icon="TrendingUp" sub={`${k.openDeals} open · ${inr(k.weightedCents, { compact: true })} weighted`} foot={<Progress value={62} tone="sky" />} />
            <KpiTile label="Client health" value={`${k.clientHealth.healthy}/${k.clientHealth.healthy + k.clientHealth.watch + k.clientHealth.atRisk + k.clientHealth.churn}`} tone="mint" icon="HeartPulse" sub={`${k.clientHealth.atRisk + k.clientHealth.churn} need attention`} foot={<Progress value={Math.round((k.clientHealth.healthy / Math.max(1, k.clientHealth.healthy + k.clientHealth.watch + k.clientHealth.atRisk + k.clientHealth.churn)) * 100)} tone="mint" />} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 px-5 pt-4 xl:grid-cols-[1.55fr_1fr]">
        {/* -------------------------------------------------- main column */}
        <div className="grid min-w-0 gap-3">
          {/* Flow chart */}
          <Card className="p-4">
            <SectionHeader
              title="Delivery flow"
              subtitle="Created vs shipped, trailing 14 days — the shape of the funnel, not a vanity chart."
              right={
                <div className="flex items-center gap-3 text-[10.5px] text-mist-500">
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-iris-500" /> created</span>
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-mint-500" /> shipped</span>
                </div>
              }
            />
            <div className="mt-3 h-[168px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.throughput} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gCreate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#d4a44c" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#d4a44c" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gShip" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22c98a" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#22c98a" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: CHART.axis, fontSize: 9.5 }} tickFormatter={(d) => String(d).slice(8)} axisLine={false} tickLine={false} interval={1} />
                  <YAxis tick={{ fill: CHART.axis, fontSize: 9.5 }} axisLine={false} tickLine={false} width={34} />
                  <RTooltip
                    contentStyle={{ background: '#0e0c0a', border: '1px solid #3a3128', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#ded9d0' }}
                  />
                  <Area type="monotone" dataKey="created" stroke="#d4a44c" strokeWidth={1.6} fill="url(#gCreate)" />
                  <Area type="monotone" dataKey="completed" stroke="#22c98a" strokeWidth={1.6} fill="url(#gShip)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Escalations */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-3.5">
              <SectionHeader title="Needs a decision today" subtitle="Ranked by the risk model: priority, deadline pressure, blockers and client visibility." />
              <Link to="/board"><Button variant="ghost" size="xs" icon="ArrowUpRight">Board</Button></Link>
            </div>
            <div className="mt-2 divide-y divide-ink-700/60">
              {data.escalations.length === 0 && <Empty icon="PartyPopper" title="Nothing critical" hint="No task scored high or critical risk. Spend the time on the pipeline instead." />}
              {data.escalations.slice(0, 6).map((t) => (
                <Link key={t.id} to={`/board?task=${t.id}`} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-800/60">
                  <span className={cls('h-8 w-[2px] shrink-0 rounded-full', t.risk?.band === 'critical' ? 'bg-rose-500' : 'bg-amber-500')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-mist-500">{t.key}</span>
                      <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>
                      {t.clientVisible && <Badge tone="sky">client</Badge>}
                      <span className="truncate text-[12.5px] font-medium text-mist-200 group-hover:text-white">{t.title}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2.5 text-[10.5px] text-mist-500">
                      {t.risk?.factors.slice(0, 3).map((f) => (
                        <span key={f.key} className="flex items-center gap-1">
                          <span className="size-1 rounded-full bg-mist-500" />
                          {f.label.toLowerCase()} <span className="text-mist-500/60">+{Math.round(f.weight)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={cls('text-[12px] font-semibold tabular', (t.risk?.score ?? 0) >= 70 ? 'text-rose-400' : 'text-amber-400')}>{t.risk?.score}</div>
                    <div className="text-[9.5px] uppercase tracking-wider text-mist-500">risk</div>
                  </div>
                  {t.assignee && <Avatar {...t.assignee} name={t.assignee.name} size={24} />}
                </Link>
              ))}
            </div>
          </Card>

          {/* Status distribution + workload */}
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="p-4">
              <SectionHeader title="Work in progress" subtitle="Board state by column" />
              <div className="mt-3 space-y-2">
                {(['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'] as const).map((s) => (
                  <div key={s} className="flex items-center gap-2.5">
                    <span className="w-[74px] shrink-0 text-[11px] text-mist-400">{STATUS_LABEL[s]}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className={cls('h-full rounded-full', s === 'blocked' ? 'bg-rose-500' : s === 'done' ? 'bg-mint-500' : s === 'review' ? 'bg-amber-500' : s === 'in_progress' ? 'bg-iris-500' : 'bg-mist-500')}
                        style={{ width: `${(data.byStatus[s] / maxStatus) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-right text-[11px] font-medium tabular text-mist-300">{data.byStatus[s]}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <SectionHeader
                title="Capacity this week"
                subtitle="Open effort against contracted hours"
                right={<Link to="/workload"><Button variant="ghost" size="xs" icon="ArrowUpRight">Plan</Button></Link>}
              />
              <div className="mt-3 space-y-2.5">
                {data.workload.slice(0, 5).map((w) => (
                  <div key={w.id} className="flex items-center gap-2.5">
                    <Avatar name={w.name} initials={w.initials} color={w.color} size={20} />
                    <span className="w-[68px] shrink-0 truncate text-[11px] text-mist-300">{w.name.split(' ')[0]}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className={cls('h-full rounded-full', w.utilisation > 100 ? 'bg-rose-500' : w.utilisation > 85 ? 'bg-amber-500' : 'bg-mint-500')}
                        style={{ width: `${Math.min(100, w.utilisation)}%` }}
                      />
                    </div>
                    <span className={cls('w-8 shrink-0 text-right text-[10.5px] font-medium tabular', w.utilisation > 100 ? 'text-rose-400' : 'text-mist-400')}>
                      {w.utilisation}%
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>

        {/* ------------------------------------------------- right column */}
        <div className="grid min-w-0 gap-3">
          {/* Insider / insights */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-ink-700/70 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-md border border-iris-500/30 bg-iris-500/12 text-iris-300">
                  <Icons.Sparkles size={12} />
                </span>
                <div>
                  <p className="text-[12px] font-semibold text-white">Relay Intelligence</p>
                  <p className="text-[10px] text-mist-500">Deterministic, explainable analysis of live data</p>
                </div>
              </div>
              <Link to="/intel"><Button variant="ghost" size="xs" icon="ArrowRight">All</Button></Link>
            </div>
            <div className="divide-y divide-ink-700/50">
              {topInsights.length === 0 && <Empty icon="CheckCheck" title="No anomalies" hint="Every signal is inside tolerance." />}
              {topInsights.map((ins, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <Dot tone={ins.severity === 'critical' || ins.severity === 'high' ? 'rose' : ins.severity === 'medium' ? 'amber' : 'mint'} />
                    <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">{ins.kind.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] font-medium leading-snug text-mist-200">{ins.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-mist-500">{ins.body}</p>
                </div>
              ))}
            </div>
          </Card>

          {/* Clocks */}
          <Card className="p-4">
            <SectionHeader
              title="Operational clocks"
              subtitle="Turnover commitments from the delivery board"
              right={<Link to="/clocks"><Button variant="ghost" size="xs" icon="ArrowUpRight">All</Button></Link>}
            />
            <div className="mt-3 space-y-2">
              {data.clocks.slice(0, 5).map((c) => (
                <div key={c.key} className="flex items-center gap-2.5">
                  <Ring
                    value={c.compliancePct}
                    size={30}
                    stroke={2.5}
                    tone={c.compliancePct >= 90 ? '#22c98a' : c.compliancePct >= 70 ? '#f5a524' : '#f4486b'}
                    label={<span className="text-[8.5px]">{c.compliancePct}%</span>}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-medium text-mist-300">{c.name}</p>
                    <p className="text-[10px] text-mist-500">
                      target {c.targetHours >= 24 ? `${Math.round(c.targetHours / 24)}d` : `${c.targetHours}h`} · {c.running} running · {c.missed} missed
                    </p>
                  </div>
                  {c.atRisk > 0 && <Badge tone="amber">{c.atRisk} near</Badge>}
                </div>
              ))}
            </div>
          </Card>

          {/* Pipeline by phase */}
          <Card className="p-4">
            <SectionHeader title="Pipeline by phase" subtitle="Open value, where it sits" right={<Link to="/pipeline"><Button variant="ghost" size="xs" icon="ArrowUpRight">Open</Button></Link>} />
            <div className="mt-3 h-[130px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.pipelineByPhase} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="phase" tick={{ fill: CHART.axis, fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: CHART.axis, fontSize: 9 }} axisLine={false} tickLine={false} width={34} tickFormatter={(v) => `${Math.round(Number(v) / 1e7)}Cr`} />
                  <RTooltip
                    formatter={(v) => inr(Number(v ?? 0), { compact: true })}
                    contentStyle={{ background: '#0e0c0a', border: '1px solid #3a3128', borderRadius: 8, fontSize: 11 }}
                  />
                  <Bar dataKey="valueCents" radius={[3, 3, 0, 0]} maxBarSize={30}>
                    {data.pipelineByPhase.map((_, i) => (
                      <Cell key={i} fill={['#8a8378', '#d4a44c', '#22a8f5', '#22c98a', '#f5a524'][i]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Activity */}
          <Card className="overflow-hidden">
            <div className="border-b border-ink-700/70 px-4 py-3">
              <p className="text-[12px] font-semibold text-white">Studio activity</p>
            </div>
            <div className="max-h-[260px] divide-y divide-ink-700/50 overflow-y-auto">
              {(activity ?? []).map((a) => (
                <div key={a.id} className="flex gap-2.5 px-4 py-2">
                  {a.actor
                    ? <Avatar name={a.actor.name} initials={a.actor.initials} color={a.actor.color} size={18} />
                    : <span className="grid size-[18px] place-items-center rounded-full bg-ink-700 text-[8px] text-mist-400"><Icons.Bot size={10} /></span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] leading-snug text-mist-300">
                      <span className="font-medium text-mist-200">{a.actor?.name.split(' ')[0] ?? 'System'}</span> {a.summary}
                    </p>
                    <p className="text-[9.5px] text-mist-500/80">{relTime(a.createdAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Projects strip */}
      <div className="px-5 pt-3">
        <Card className="p-4">
          <SectionHeader
            title="Live projects"
            subtitle="Every engagement, phase and turnover state at a glance"
            right={<Link to="/projects"><Button variant="ghost" size="xs" icon="ArrowUpRight">All projects</Button></Link>}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {data.projects.map((p) => (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                className="surface surface-hover group rounded-lg p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-sm" style={{ background: p.color }} />
                      <span className="font-mono text-[9.5px] uppercase tracking-wider text-mist-500">{p.key}</span>
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] font-medium text-mist-200 group-hover:text-white">{p.name}</p>
                    <p className="truncate text-[10.5px] text-mist-500">{p.clientName}</p>
                  </div>
                  <Badge tone={HEALTH_TONE[p.health] ?? 'neutral'} dot>{p.health.replace('_', ' ')}</Badge>
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <Progress value={p.progress} tone={p.health === 'at_risk' || p.health === 'critical' ? 'rose' : 'iris'} height={3} />
                  <span className="shrink-0 text-[10px] tabular text-mist-500">{p.progress}%</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-mist-500">
                  <span>{p.done}/{p.total} shipped</span>
                  <span className="flex items-center gap-1"><Icons.Clock size={9} /> {STATUS_LABEL[p.status] ?? p.status}</span>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function KpiTile({
  label, value, sub, tone, icon, foot,
}: { label: string; value: React.ReactNode; sub: string; tone: string; icon: keyof typeof Icons; foot?: React.ReactNode }) {
  const Icon = Icons[icon] as React.ComponentType<{ size?: number; className?: string }>;
  const toneMap: Record<string, string> = {
    iris: 'text-iris-300 border-iris-500/25 bg-iris-500/8',
    amber: 'text-amber-400 border-amber-500/25 bg-amber-500/8',
    rose: 'text-rose-400 border-rose-500/25 bg-rose-500/8',
    mint: 'text-mint-400 border-mint-500/25 bg-mint-500/8',
    sky: 'text-sky-400 border-sky-500/25 bg-sky-500/8',
  };
  return (
    <div className="surface rounded-xl p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">{label}</p>
        <span className={cls('grid size-5 place-items-center rounded-md border', toneMap[tone])}>
          <Icon size={11} />
        </span>
      </div>
      <p className="mt-1.5 text-[21px] font-semibold leading-none tracking-tight tabular text-white">{value}</p>
      <p className="mt-1 truncate text-[10.5px] text-mist-500">{sub}</p>
      <div className="mt-2">{foot}</div>
    </div>
  );
}
