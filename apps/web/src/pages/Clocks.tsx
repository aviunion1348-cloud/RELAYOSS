/**
 * Turnover Clocks — the operational commitments, made measurable.
 * Every row is a policy from the delivery board with a hard target, an amber
 * warning threshold and an aggressive internal stretch goal.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { clockLabel, dateTime, relTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { MutationFailure, QueryFailure } from '../components/QueryFailure';
import { useMutationFailure, useQueryState } from '../lib/query-state';
import {
  Badge, Button, Card, Dot, Empty, Field, Modal, Progress, Ring, SectionHeader, Skeleton, Textarea, Tooltip,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';

const SCOPE_ICON: Record<string, keyof typeof Icons> = {
  deal: 'GitBranch', project: 'FolderKanban', phase: 'Layers', task: 'SquareCheck', release: 'Rocket', qa: 'ShieldCheck',
};

export default function Clocks() {
  const qc = useQueryClient();
  const clocks = useQuery({ queryKey: ['clocks'], queryFn: api.clocks, refetchInterval: 30_000 });
  const q = useQueryState(clocks);

  const resolveError = useMutationFailure();
  const sweepError = useMutationFailure();

  /*
   * Every clock decision is recorded against the timer, and that record is what the
   * client relationship is defended with months later. The previous code wrote the
   * same sentence into every one — "Resolved from the clocks console" — which is a
   * note that says nothing, attached to the one thing that needs to say something.
   * The outcome now collects the reason before it is recorded.
   */
  const [resolution, setResolution] = useState<{ id: string; outcome: string; clockName: string; label: string } | null>(null);
  const [note, setNote] = useState('');

  const resolve = useMutation({
    onMutate: () => resolveError.clear(),
    mutationFn: (vars: { id: string; outcome: string; note?: string }) => api.resolveTimer(vars.id, vars.outcome, vars.note),
    onSuccess: () => {
      setResolution(null);
      setNote('');
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
  /*
   * Three groups, in the order a person needs them: what has already slipped, what is
   * about to, and what is fine. The old list was one flat run sorted by deadline, which
   * looks tidy and buries the two rows that need a decision among the twenty that do not.
   */
  const overdue = missed;
  const atRisk = running.filter((t) => t.hoursLeft < 12);
  const onTrack = running.filter((t) => t.hoursLeft >= 12);
  const groups = [
    { key: 'overdue', title: 'Missed — needs a decision', hint: 'Write what happened and waive it, or keep it red. It cannot be quietly cleared.', timers: overdue, tone: 'rose' as const },
    { key: 'atRisk', title: 'Due within 12 hours', hint: 'Finish it, or pause it if the wait is on someone else.', timers: atRisk, tone: 'amber' as const },
    { key: 'onTrack', title: 'Running', hint: 'Comfortable. No action needed.', timers: onTrack, tone: 'mint' as const },
  ].filter((g) => g.timers.length > 0);
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
          {/*
            What this page is for, stated once at the top. The controls below only make
            sense with it: a clock is a promise with a deadline, and the only three things
            a person can do here are finish it, pause it because the wait is elsewhere, or
            write down why it slipped.
          */}
          <div className="border-b border-ink-700/60 bg-ink-850/40 px-4 py-2">
            <p className="text-[10.5px] leading-relaxed text-mist-500">
              <span className="text-mist-300">Mark met</span> when the work is done ·{' '}
              <span className="text-mist-300">Pause</span> when you are waiting on someone else ·{' '}
              <span className="text-mist-300">Waive</span> a missed clock with the reason, which is kept on the record
            </p>
          </div>
          <div className="divide-y divide-ink-700/50">
            {data.timers.length === 0 && (
              <Empty
                icon="TimerOff"
                title="No clocks running"
                hint="A clock starts by itself when work enters a governed stage — a deal reaching consultation, a task moving into turnover, a QA report being filed. Nothing to do here until then."
              />
            )}
            {groups.map((group) => (
              <div key={group.key}>
                <div className="flex items-center gap-1.5 border-y border-ink-700/40 bg-ink-850/30 px-4 py-1.5 first:border-t-0">
                  <Dot tone={group.tone} />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-mist-400">{group.title}</p>
                  <span className="rounded bg-ink-750 px-1 text-[9px] tabular text-mist-400">{group.timers.length}</span>
                  <p className="ml-auto hidden text-[9.5px] text-mist-500 sm:block">{group.hint}</p>
                </div>
                {group.timers.map((t) => {
                  const Icon = Icons[SCOPE_ICON[t.scope] ?? 'Timer'] as React.ComponentType<{ size?: number; className?: string }>;
                  const over = t.hoursLeft < 0;
                  const critical = t.progressPct > 90 || over;
                  return (
                    <div key={t.id} className={cls('px-4 py-2.5 transition-colors hover:bg-ink-800/40', over && 'bg-rose-500/[0.04]')}>
                      <div className="flex items-start gap-2.5">
                        <span className={cls('mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border', critical ? 'border-rose-500/30 bg-rose-500/10 text-rose-400' : 'border-ink-600 bg-ink-800 text-mist-500')}>
                          <Icon size={11} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-mist-500">{t.clockName}</span>
                            {over && <Badge tone="rose">missed</Badge>}
                            {t.outcome === 'paused' && <Badge tone="amber">paused</Badge>}
                          </div>
                          <p className="mt-0.5 truncate text-[12px] font-medium text-mist-200">{t.label || t.clockName}</p>
                          <p className="mt-0.5 text-[10px] text-mist-500">
                            started {relTime(t.startedAt)} · due {dateTime(t.dueAt)} · promised within {t.targetHours >= 24 ? `${Math.round(t.targetHours / 24)}d` : `${t.targetHours}h`}
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
                              <Button
                                size="xs"
                                variant="secondary"
                                onClick={() => { resolveError.clear(); setNote(''); setResolution({ id: t.id, outcome: 'met', clockName: t.clockName, label: t.label }); }}
                              >
                                Mark met
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => { resolveError.clear(); setNote(''); setResolution({ id: t.id, outcome: 'paused', clockName: t.clockName, label: t.label }); }}
                              >
                                Pause
                              </Button>
                            </>
                          )}
                          {t.outcome === 'missed' && (
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => { resolveError.clear(); setNote(''); setResolution({ id: t.id, outcome: 'waived', clockName: t.clockName, label: t.label }); }}
                            >
                              Waive…
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
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

      {/* ------------------------------------------------------- resolution note */}
      <Modal
        open={resolution !== null}
        icon={resolution?.outcome === 'waived' ? 'ShieldAlert' : resolution?.outcome === 'paused' ? 'AlarmClock' : 'CheckCircle2'}
        title={
          resolution?.outcome === 'waived' ? 'Waive this missed clock'
            : resolution?.outcome === 'paused' ? 'Pause this clock'
              : 'Mark this clock met'
        }
        subtitle={
          resolution?.outcome === 'waived'
            ? 'A missed clock is an exception, and an exception needs a reason on the record. It stays visible in the compliance figures either way.'
            : resolution?.outcome === 'paused'
              ? 'Say who or what the wait is on. The clock stops accruing against the promise while it is paused.'
              : 'What finished it. One line is enough, and it is what the client sees if the timing is ever questioned.'
        }
        onClose={() => setResolution(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResolution(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={resolve.isPending}
              disabled={note.trim().length < 3}
              onClick={() => resolution && resolve.mutate({ id: resolution.id, outcome: resolution.outcome, note: note.trim() })}
            >
              {resolution?.outcome === 'waived' ? 'Record and waive' : resolution?.outcome === 'paused' ? 'Pause clock' : 'Mark met'}
            </Button>
          </>
        }
      >
        {resolveError.error !== null && (
          <div className="mb-3"><ApiFailure error={resolveError.error} what="The server refused that change." /></div>
        )}
        <Field
          label="Reason"
          hint="Stored on the timer and shown with it — this is the record, not a comment box."
          error={note.trim().length < 3 ? 'At least a few words, or the note is worthless later.' : null}
        >
          {({ id }) => (
            <Textarea
              id={id}
              rows={3}
              autoFocus
              value={note}
              placeholder={
                resolution?.outcome === 'waived'
                  ? 'Client moved the review to next week; confirmed by email on the 14th.'
                  : resolution?.outcome === 'paused'
                    ? 'Waiting on the client to send staging credentials.'
                    : 'Turnover completed and evidenced in the board card.'
              }
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </Modal>
    </div>
  );
}
