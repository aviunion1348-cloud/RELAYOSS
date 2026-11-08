/**
 * Turnover Clocks — the operational commitments, made measurable.
 * Every row is a policy from the delivery board with a hard target, an amber
 * warning threshold and an aggressive internal stretch goal.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { clockLabel, dateTime, relTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { MutationFailure, QueryFailure } from '../components/QueryFailure';
import { useMutationFailure, useQueryState } from '../lib/query-state';
import { Badge, Button, Card, Dot, Empty, Progress, Ring, SectionHeader, Skeleton, Tooltip } from '../components/ui';

const SCOPE_ICON: Record<string, keyof typeof Icons> = {
  deal: 'GitBranch', project: 'FolderKanban', phase: 'Layers', task: 'SquareCheck', release: 'Rocket', qa: 'ShieldCheck',
};

export default function Clocks() {
  const qc = useQueryClient();
  const clocks = useQuery({ queryKey: ['clocks'], queryFn: api.clocks, refetchInterval: 30_000 });
  const q = useQueryState(clocks);

  const resolveError = useMutationFailure();
  const sweepError = useMutationFailure();

  const resolve = useMutation({
    onMutate: () => resolveError.clear(),
    mutationFn: (vars: { id: string; outcome: string }) => api.resolveTimer(vars.id, vars.outcome, 'Resolved from the clocks console'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clocks'] });
      qc.invalidateQueries({ queryKey: ['clocks-live'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e: unknown) => resolveError.set(e),
  });

  const sweep = useMutation({
    mutationFn: () => api.sweepClocks(),
    onMutate: () => sweepError.clear(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clocks'] }),
    onError: (e: unknown) => sweepError.set(e),
  });

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the turnover clocks" retry={q.refetch} />;
  if (q.state !== 'ready') {
    return <div className="p-5"><Skeleton className="h-8 w-56" /><div className="mt-4 grid gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div></div>;
  }
  const data = q.data;

  const running = data.timers.filter((t) => t.outcome === 'running');
  const missed = data.timers.filter((t) => t.outcome === 'missed');
  const overall = Math.round(data.clocks.reduce((a, c) => a + c.compliancePct, 0) / Math.max(1, data.clocks.length));
  const totalMet = data.clocks.reduce((a, c) => a + c.met, 0);
  const totalMissed = data.clocks.reduce((a, c) => a + c.missed, 0);

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.Timer size={11} /> Delivery governance</>}
        title="Turnover Clocks"
        subtitle="The timing commitments we make to clients — consultation to plan in 3 days, plan revisions in 12–32 hours, module turnover in 24, QA reports in 12. A missed clock is an exception that needs a written record, not a quiet slip."
        right={
          <>
            <Badge tone={overall >= 85 ? 'mint' : overall >= 70 ? 'amber' : 'rose'} dot>studio compliance {overall}%</Badge>
            <Button variant="secondary" size="md" icon="RefreshCw" loading={sweep.isPending} onClick={() => sweep.mutate()}>
              Sweep now
            </Button>
          </>
        }
      />

      {sweepError.error !== null && (
        <div className="px-5 pt-3">
          <MutationFailure error={sweepError.error} what="Sweeping the clocks" onDismiss={sweepError.clear} />
        </div>
      )}
      {resolveError.error !== null && (
        <div className="px-5 pt-3">
          <MutationFailure error={resolveError.error} what="Resolving that clock" onDismiss={resolveError.clear} />
        </div>
      )}

      <div className="grid gap-3 px-5 pt-4 xl:grid-cols-[1.2fr_1fr]">
        {/* live timers */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-700/70 px-4 py-3">
            <SectionHeader title="Live clocks" subtitle="Sorted by nearest deadline" />
            <div className="flex items-center gap-2 text-[10.5px]">
              <span className="flex items-center gap-1 text-mist-400"><Dot tone="iris" /> {running.length} running</span>
              <span className="flex items-center gap-1 text-rose-400"><Dot tone="rose" /> {missed.length} missed</span>
            </div>
          </div>
          <div className="divide-y divide-ink-700/50">
            {data.timers.length === 0 && <Empty icon="TimerOff" title="No clocks running" hint="Clocks start automatically when work enters a governed stage." />}
            {data.timers.map((t) => {
              const Icon = Icons[SCOPE_ICON[t.scope] ?? 'Timer'] as React.ComponentType<{ size?: number; className?: string }>;
              const over = t.hoursLeft < 0;
              const critical = t.progressPct > 90 || over;
              return (
                <div key={t.id} className={cls('group px-4 py-2.5 transition-colors hover:bg-ink-800/40', over && 'bg-rose-500/[0.04]')}>
                  <div className="flex items-start gap-2.5">
                    <span className={cls('mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border', critical ? 'border-rose-500/30 bg-rose-500/10 text-rose-400' : 'border-ink-600 bg-ink-800 text-mist-500')}>
                      <Icon size={11} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-mist-500">{t.clockName}</span>
                        <span className="text-mist-500/40">·</span>
                        <span className="font-mono text-[9.5px] text-mist-500">{t.entityType}/{t.entityId.slice(0, 14)}</span>
                        {over && <Badge tone="rose">missed</Badge>}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] font-medium text-mist-200">{t.label || t.clockName}</p>
                      <p className="mt-0.5 text-[10px] text-mist-500">
                        started {relTime(t.startedAt)} · due {dateTime(t.dueAt)} · target {t.targetHours >= 24 ? `${Math.round(t.targetHours / 24)}d` : `${t.targetHours}h`}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <Progress value={t.progressPct} tone={over ? 'rose' : t.progressPct > 90 ? 'amber' : 'mint'} height={3} />
                        <span className={cls('shrink-0 text-[10px] font-medium tabular', over ? 'text-rose-400' : t.progressPct > 66 ? 'text-amber-400' : 'text-mist-400')}>
                          {clockLabel(t.hoursLeft)}
                        </span>
                      </div>
                      {t.exceptionNote && (
                        <p className="mt-1 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-[10px] leading-snug text-mist-400">
                          <Icons.MessageSquare size={9} className="mr-1 inline" />{t.exceptionNote}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {t.outcome === 'running' && (
                        <>
                          <Button size="xs" variant="secondary" onClick={() => resolve.mutate({ id: t.id, outcome: 'met' })}>Met</Button>
                          <Button size="xs" variant="ghost" onClick={() => resolve.mutate({ id: t.id, outcome: 'paused' })}>Pause</Button>
                        </>
                      )}
                      {t.outcome === 'missed' && (
                        <Button size="xs" variant="secondary" onClick={() => resolve.mutate({ id: t.id, outcome: 'waived' })}>Waive</Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* policy table */}
        <div className="space-y-3">
          <Card className="p-4">
            <SectionHeader title="Compliance by policy" subtitle="Met vs missed across the studio" />
            <div className="mt-3 flex items-center gap-4">
              <Ring value={overall} size={68} stroke={5} tone={overall >= 85 ? '#22c98a' : overall >= 70 ? '#f5a524' : '#f4486b'} />
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                <span className="text-mist-500">Met</span><span className="tabular text-mint-400">{totalMet}</span>
                <span className="text-mist-500">Missed</span><span className="tabular text-rose-400">{totalMissed}</span>
                <span className="text-mist-500">Running</span><span className="tabular text-mist-300">{running.length}</span>
                <span className="text-mist-500">Policies</span><span className="tabular text-mist-300">{data.clocks.length}</span>
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-ink-700/70 px-4 py-3">
              <p className="text-[12px] font-semibold text-white">Policy catalogue</p>
              <p className="text-[10.5px] text-mist-500">Editable as data — no deploy needed to change a promise</p>
            </div>
            <div className="max-h-[520px] divide-y divide-ink-700/50 overflow-y-auto">
              {data.clocks.map((c) => (
                <div key={c.key} className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={cls('size-1.5 shrink-0 rounded-full', c.compliancePct >= 90 ? 'bg-mint-500' : c.compliancePct >= 70 ? 'bg-amber-500' : 'bg-rose-500')} />
                    <p className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-mist-200">{c.name}</p>
                    <span className="shrink-0 text-[10px] tabular text-mist-400">{c.compliancePct}%</span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-mist-500">{c.policyNote}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="outline" mono>hard {c.targetHours >= 24 ? `${Math.round(c.targetHours / 24)}d` : `${c.targetHours}h`}</Badge>
                    {c.stretchHours && <Badge tone="iris" mono>stretch {c.stretchHours >= 24 ? `${Math.round(c.stretchHours / 24)}d` : `${c.stretchHours}h`}</Badge>}
                    <Badge tone="neutral">{c.escalation}</Badge>
                    <Tooltip label="Excaliboard reference">
                      <span className="font-mono text-[9px] text-mist-500/70">{c.boardRef}</span>
                    </Tooltip>
                    {c.avgHours !== null && <span className="ml-auto text-[9.5px] tabular text-mist-500">avg {c.avgHours}h</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
