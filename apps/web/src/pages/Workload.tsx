/**
 * Planning & Capacity — the scheduler explained.
 * Shows the machine's plan with per-task rationale, capacity heatmap,
 * overloaded people and unassignable work.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { hours, parseDate, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Badge, Button, Card, Progress, RISK_TONE, SectionHeader, Segmented, Skeleton, Tooltip } from '../components/ui';
import { useSearchParams } from 'react-router-dom';
import { TaskDrawer } from '../components/TaskDrawer';

export default function Workload() {
  const [horizon, setHorizon] = useState(21);
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useQuery({ queryKey: ['planner', horizon], queryFn: () => api.planner(horizon) });

  if (isLoading || !data) {
    return <div className="p-5"><Skeleton className="h-8 w-64" /><div className="mt-4 grid gap-3 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="mt-3 h-64" /></div>;
  }

  const s = data.stats;
  const days = Array.from({ length: Math.min(horizon, data.perPerson[0] ? Object.keys(data.perPerson[0].days).length : 14) });
  const dayKeys = [...new Set(data.perPerson.flatMap((p) => Object.keys(p.days)))].sort().slice(0, 15);

  const openTask = params.get('task');

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.GanttChartSquare size={11} /> Capacity & scheduling</>}
        title="Delivery planner"
        subtitle="Critical-path analysis plus weighted-shortest-processing-time, packed into each person's real calendar. Every placement carries its reasoning — no black box decides what a human does next."
        right={
          <>
            <Segmented
              value={String(horizon)}
              onChange={(v) => setHorizon(Number(v))}
              options={[{ value: '7', label: '1 week' }, { value: '14', label: '2 weeks' }, { value: '21', label: '3 weeks' }, { value: '30', label: '1 month' }]}
            />
            <Badge tone="outline" mono>{data.generatedAt.slice(11, 16)} UTC</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 px-5 pt-4 lg:grid-cols-6">
        <Stat label="Scheduled" value={s.tasksScheduled} sub={`${s.totalHours}h of work`} tone="iris" />
        <Stat label="Utilisation" value={`${s.utilisation}%`} sub={`${s.horizonDays}d horizon`} tone={s.utilisation > 95 ? 'rose' : 'mint'} />
        <Stat label="Late vs due" value={s.lateTasks} sub="will miss the date" tone={s.lateTasks > 0 ? 'rose' : 'mint'} />
        <Stat label="Critical path" value={s.criticalCount} sub="zero slack" tone="amber" />
        <Stat label="Throughput" value={`${s.throughputPerWeek}/wk`} sub="tasks per week" tone="sky" />
        <Stat label="Unassignable" value={s.tasksUnassigned} sub="needs a decision" tone={s.tasksUnassigned > 0 ? 'amber' : 'mint'} />
      </div>

      {s.overloadedPeople.length > 0 && (
        <div className="px-5 pt-3">
          <div className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
            <Icons.AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-medium text-amber-300">Capacity conflict inside the horizon</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-amber-300/70">
                {s.overloadedPeople.map((p) => `${p.name.split(' ')[0]} ${Math.round(p.planned)}h/${Math.round(p.capacity)}h`).join(' · ')} — either rebalance, move the due date with the client, or record the exception.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 px-5 pt-3 xl:grid-cols-[1fr_340px]">
        {/* capacity heatmap */}
        <Card className="overflow-hidden p-4">
          <SectionHeader title="Capacity heatmap" subtitle="Planned hours per person per day — red is over the daily ceiling" />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] border-separate border-spacing-y-1">
              <thead>
                <tr>
                  <th className="w-[120px] text-left text-[9.5px] font-medium uppercase tracking-wider text-mist-500">Person</th>
                  {dayKeys.map((d) => (
                    <th key={d} className="px-0.5 pb-1 text-center text-[9px] font-normal tabular text-mist-500">
                      {d.slice(8)}<br /><span className="text-[8px] text-mist-500/60">{parseDate(d)?.toLocaleDateString('en-IN', { weekday: 'narrow' })}</span>
                    </th>
                  ))}
                  <th className="w-[86px] pl-2 text-right text-[9.5px] font-medium uppercase tracking-wider text-mist-500">Load</th>
                </tr>
              </thead>
              <tbody>
                {data.perPerson.map((p) => (
                  <tr key={p.user_id}>
                    <td className="pr-2">
                      <span className="block truncate text-[11px] text-mist-300">{p.name.split(' ')[0]} {p.name.split(' ')[1]?.[0]}.</span>
                    </td>
                    {dayKeys.map((d) => {
                      const h = p.days[d] ?? 0;
                      const ceiling = Math.max(2, p.capacity / 5);
                      const ratio = h / ceiling;
                      return (
                        <td key={d} className="px-0.5">
                          <Tooltip label={`${p.name.split(' ')[0]} · ${shortDate(d)} · ${hours(h)}`}>
                            <div
                              className={cls('grid h-7 w-full place-items-center rounded text-[8.5px] font-medium tabular transition-transform hover:scale-[1.06]',
                                h === 0 ? 'bg-ink-800/60 text-mist-500/50'
                                  : ratio > 1 ? 'bg-rose-500/30 text-rose-200'
                                  : ratio > 0.8 ? 'bg-amber-500/25 text-amber-200'
                                  : 'bg-iris-500/22 text-iris-200')}
                            >
                              {h ? Math.round(h) : ''}
                            </div>
                          </Tooltip>
                        </td>
                      );
                    })}
                    <td className="pl-2">
                      <div className="flex items-center gap-1.5">
                        <Progress value={Math.min(100, p.utilisation)} tone={p.utilisation > 100 ? 'rose' : p.utilisation > 85 ? 'amber' : 'mint'} height={3} />
                        <span className={cls('shrink-0 text-[9.5px] tabular', p.utilisation > 100 ? 'text-rose-400' : 'text-mist-400')}>{p.utilisation}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* unassignable */}
        <Card className="overflow-hidden">
          <div className="border-b border-ink-700/70 px-4 py-3">
            <SectionHeader title="Needs a decision" subtitle="Cannot be scheduled automatically" />
          </div>
          <div className="max-h-[330px] divide-y divide-ink-700/50 overflow-y-auto">
            {data.unassigned.length === 0 && <p className="px-4 py-8 text-center text-[11px] text-mist-500">Everything has a home.</p>}
            {data.unassigned.map((u) => (
              <button key={u.task_id} onClick={() => setParams(new URLSearchParams({ task: u.task_id }))} className="flex w-full items-start gap-2 px-4 py-2 text-left transition-colors hover:bg-ink-800/60">
                <Icons.AlertCircle size={11} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium text-mist-200"><span className="font-mono text-[9.5px] text-mist-500">{u.key}</span> {u.title}</p>
                  <p className="text-[10px] text-mist-500">{u.reason}</p>
                </div>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* plan table */}
      <div className="px-5 pt-3">
        <Card className="overflow-hidden">
          <div className="border-b border-ink-700/70 px-4 py-3">
            <SectionHeader title="The plan" subtitle="Ordered by the scheduler — each row explains itself" />
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10 bg-ink-850/95 backdrop-blur">
                <tr className="text-[9px] uppercase tracking-[0.1em] text-mist-500">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Task</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Window</th>
                  <th className="px-3 py-2 text-right font-medium">Effort</th>
                  <th className="px-3 py-2 text-right font-medium">Slack</th>
                  <th className="px-3 py-2 text-right font-medium">Risk</th>
                  <th className="px-3 py-2 font-medium">Why here</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/50">
                {data.items.map((it) => (
                  <tr key={it.task_id} onClick={() => setParams(new URLSearchParams({ task: it.task_id }))} className="cursor-pointer transition-colors hover:bg-ink-800/50">
                    <td className="px-3 py-1.5 text-[9.5px] tabular text-mist-500">{it.sequence + 1}</td>
                    <td className="max-w-[280px] px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {it.critical && <Tooltip label="On the critical path"><Icons.Zap size={9} className="shrink-0 text-rose-400" /></Tooltip>}
                        <span className="font-mono text-[9px] text-mist-500">{it.key}</span>
                        <span className="truncate text-[11px] text-mist-200">{it.title}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[10.5px] text-mist-400">{it.assignee_name.split(' ')[0]}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[10.5px] tabular text-mist-400">
                      {shortDate(it.planned_start)}{it.planned_end !== it.planned_start ? ` → ${shortDate(it.planned_end)}` : ''}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[10.5px] tabular text-mist-400">{it.planned_hours}h</td>
                    <td className="px-3 py-1.5 text-right text-[10.5px] tabular text-mist-500">{it.slack_days}d</td>
                    <td className="px-3 py-1.5 text-right">
                      <Badge tone={RISK_TONE[it.risk_band] ?? 'neutral'} mono>{it.risk_score}</Badge>
                    </td>
                    <td className="max-w-[300px] px-3 py-1.5">
                      <p className="truncate text-[10px] text-mist-500" title={it.rationale}>{it.rationale}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="px-5 pt-3">
        <Card className="p-4">
          <SectionHeader title="How the plan is produced" subtitle="Reproducible, auditable, and safe to argue with" />
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            {[
              { n: '01', t: 'Dependency graph', b: 'Task dependencies are topologically sorted to find the critical path and per-task slack. Cycles are detected and broken safely.' },
              { n: '02', t: 'Priority scoring', b: 'WSPT: priority weight × deadline urgency ÷ remaining effort, with blocked work demoted to 15%.' },
              { n: '03', t: 'Calendar packing', b: 'Each task fills the earliest free hours on its owner’s calendar — weekends, time off and existing commitments respected.' },
              { n: '04', t: 'Risk surfacing', b: 'Every placement is scored on priority, overdue pressure, blockers, overload and client visibility.' },
            ].map((c) => (
              <div key={c.n} className="rounded-lg border border-ink-700 bg-ink-850/50 p-2.5">
                <span className="font-mono text-[9.5px] text-iris-300">{c.n}</span>
                <p className="mt-0.5 text-[11px] font-medium text-mist-200">{c.t}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-mist-500">{c.b}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {openTask && <TaskDrawer taskId={openTask} onClose={() => setParams(new URLSearchParams())} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub: string; tone: string }) {
  const tones: Record<string, string> = { iris: 'text-iris-300', mint: 'text-mint-400', rose: 'text-rose-400', amber: 'text-amber-400', sky: 'text-sky-400' };
  return (
    <Card className="p-3">
      <p className="text-[9.5px] font-medium uppercase tracking-[0.1em] text-mist-500">{label}</p>
      <p className={cls('mt-1 text-[19px] font-semibold leading-none tabular', tones[tone])}>{value}</p>
      <p className="mt-1 truncate text-[10px] text-mist-500">{sub}</p>
    </Card>
  );
}
