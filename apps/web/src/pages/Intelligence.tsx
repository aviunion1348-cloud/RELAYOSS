/**
 * Intelligence — the explainable analytics surface.
 *
 * The findings here are computed, and they must stay that way: a number that came
 * from the database and can be typed over is not analysis. What a person genuinely
 * decides is what to *do* about a finding, and there are two honest answers — fix
 * the work, or accept it knowingly.
 *
 * The second one needed somewhere to live. Without it the only options were to see
 * the same warning every day until it became wallpaper, so this screen now records
 * the decision: who acknowledged what, when, and why, with an expiry when it is a
 * "not this sprint". The finding is never deleted — it moves to an acknowledged list
 * where its wording keeps updating, so "we chose to accept this" never becomes
 * indistinguishable from "nobody noticed".
 */
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { relTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import {
  Badge, Button, Card, Dot, Field, Modal, Progress, SectionHeader, Select, Skeleton, Textarea,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';
import { TaskDrawer } from '../components/TaskDrawer';
import type { Issue } from '../types';

/** Snooze options, in hours. 0 means "until someone undoes it". */
const MUTE_OPTIONS = [
  { value: '0', label: 'Indefinitely' },
  { value: '24', label: 'For a day' },
  { value: String(24 * 7), label: 'For a week' },
  { value: String(24 * 30), label: 'For a month' },
] as const;

const SEV_ICON: Record<string, keyof typeof Icons> = {
  critical: 'ShieldAlert', high: 'AlertTriangle', medium: 'AlertCircle', low: 'Info',
};

export default function Intelligence() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const insightsQuery = useQuery({ queryKey: ['insights'], queryFn: api.insights });
  const dashQuery = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });
  const q = useQueryState(insightsQuery);
  const dash = dashQuery.data;
  const openTask = params.get('task');

  const [acknowledging, setAcknowledging] = useState<Issue | null>(null);
  const [reason, setReason] = useState('');
  const [muteHours, setMuteHours] = useState('0');

  /*
   * One invalidation, not an in-place patch. The open and acknowledged lists are
   * derived from the same dismissals server-side, so a finding moved by hand in the
   * cache would be in both lists or neither until the next fetch.
   */
  const acknowledge = useMutation({
    mutationFn: (vars: { key: string; reason: string; muteHours: number }) =>
      api.dismissInsight(vars.key, { reason: vars.reason, muteHours: vars.muteHours }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['insights'] });
      setAcknowledging(null);
    },
  });
  const restore = useMutation({
    mutationFn: (key: string) => api.restoreInsight(key),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['insights'] }),
  });

  const openAcknowledge = (finding: Issue) => {
    acknowledge.reset();
    setReason('');
    setMuteHours('0');
    setAcknowledging(finding);
  };

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the intelligence feed" retry={q.refetch} />;
  if (q.state !== 'ready') return <div className="p-5"><Skeleton className="h-8 w-52" /><div className="mt-4 grid gap-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div></div>;

  const data = q.data;

  const counts = {
    critical: data.insights.filter((i) => i.severity === 'critical').length,
    high: data.insights.filter((i) => i.severity === 'high').length,
    medium: data.insights.filter((i) => i.severity === 'medium').length,
    low: data.insights.filter((i) => i.severity === 'low').length,
  };

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.Sparkles size={11} /> Relay Intelligence</>}
        title="What the data is telling you"
        subtitle="Deterministic analysis over live operational data: bottlenecks, estimate drift, stale WIP, turnover clustering, reviewer concentration and client-facing risk. Every finding is explainable and points at a decision — no opaque scoring."
        right={<Badge tone="outline" mono>computed {relTime(data.generatedAt)}</Badge>}
      />

      <div className="grid grid-cols-2 gap-2.5 px-5 pt-4 lg:grid-cols-4">
        {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
          <Card key={sev} className={cls('p-3.5', sev === 'critical' && counts.critical > 0 && 'border-rose-500/40')}>
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-mist-500">
              <Dot tone={sev === 'critical' || sev === 'high' ? 'rose' : sev === 'medium' ? 'amber' : 'mint'} />
              {sev}
            </p>
            <p className={cls('mt-1 text-[22px] font-semibold tabular',
              sev === 'critical' ? 'text-rose-400' : sev === 'high' ? 'text-amber-400' : sev === 'medium' ? 'text-sky-400' : 'text-mist-300')}>
              {counts[sev]}
            </p>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 px-5 pt-3 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-2">
          {data.insights.length === 0 && (
            <Card className="p-10 text-center">
              <Icons.CheckCheck size={22} className="mx-auto text-mint-400" />
              <p className="mt-2 text-[12.5px] font-medium text-mist-200">No anomalies detected</p>
              <p className="mt-1 text-[11px] text-mist-500">Every signal is inside tolerance. Enjoy the quiet week.</p>
            </Card>
          )}
          {data.insights.map((ins, i) => {
            const Icon = Icons[SEV_ICON[ins.severity] ?? 'Info'] as React.ComponentType<{ size?: number; className?: string }>;
            const tone = ins.severity === 'critical' || ins.severity === 'high' ? 'rose' : ins.severity === 'medium' ? 'amber' : 'mint';
            return (
              <Card key={i} className={cls('p-3.5', ins.severity === 'critical' && 'border-rose-500/35')}>
                <div className="flex items-start gap-2.5">
                  <span className={cls('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border',
                    tone === 'rose' ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                      : tone === 'amber' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                      : 'border-mint-500/30 bg-mint-500/10 text-mint-400')}>
                    <Icon size={13} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={tone}>{ins.severity}</Badge>
                      <Badge tone="outline">{ins.kind.replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="mt-1.5 text-[12.5px] font-medium leading-snug text-mist-100">{ins.title}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-mist-500">{ins.body}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {ins.action && (
                        <Button size="xs" variant="secondary" icon="ArrowRight" onClick={() => setParams(new URLSearchParams({ task: ins.action!.taskId }))}>
                          {ins.action.label}
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" icon="Check" onClick={() => openAcknowledge(ins)}>
                        Acknowledge
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
          {/* ------------------------------------------- acknowledged -- */}
          {data.dismissed.length > 0 && (
            <Card className="p-3">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">
                <Icons.CheckCheck size={11} className="text-mint-400" />
                Acknowledged · {data.dismissed.length}
              </p>
              <div className="mt-2 space-y-1.5">
                {data.dismissed.map((d) => (
                  <div key={d.key} className="rounded-lg border border-ink-700 bg-ink-850/40 px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      <Icons.CheckCheck size={11} className="mt-0.5 shrink-0 text-mist-500" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] leading-snug text-mist-300">
                          {d.insight ? d.insight.title : <span className="text-mist-500">{d.kind.replace(/_/g, ' ')} · no longer firing</span>}
                        </p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-mist-500">
                          {d.reason || 'No reason recorded'}
                          {d.dismissedBy && <span> · {d.dismissedBy}</span>}
                          <span> · {relTime(d.dismissedAt)}</span>
                          {d.mutedUntil && <span className="text-amber-400"> · returns {relTime(d.mutedUntil)}</span>}
                        </p>
                      </div>
                      <button
                        onClick={() => restore.mutate(d.key)}
                        disabled={restore.isPending}
                        className="shrink-0 rounded px-1 py-0.5 text-[9.5px] text-mist-500 transition-colors hover:bg-ink-700 hover:text-gold-300 disabled:opacity-50"
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {restore.error ? <div className="mt-2"><ApiFailure error={restore.error} what="the finding was not restored." /></div> : null}
            </Card>
          )}
        </div>

        <div className="space-y-3">
          {dash && (
            <>
              <Card className="p-4">
                <SectionHeader title="Studio load" subtitle="Where the pressure actually is" />
                <div className="mt-3 space-y-2">
                  {dash.workload.map((w) => (
                    <div key={w.id} className="flex items-center gap-2">
                      <span className="w-[62px] shrink-0 truncate text-[10.5px] text-mist-400">{w.name.split(' ')[0]}</span>
                      <Progress value={Math.min(100, w.utilisation)} tone={w.utilisation > 100 ? 'rose' : w.utilisation > 85 ? 'amber' : 'mint'} height={4} />
                      <span className="w-9 shrink-0 text-right text-[10px] tabular text-mist-400">{w.utilisation}%</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <SectionHeader title="Clock health" subtitle="Compliance per commitment" />
                <div className="mt-3 space-y-1.5">
                  {dash.clocks.map((c) => (
                    <div key={c.key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-400">{c.name}</span>
                      <span className={cls('shrink-0 text-[10px] tabular', c.compliancePct >= 90 ? 'text-mint-400' : c.compliancePct >= 70 ? 'text-amber-400' : 'text-rose-400')}>
                        {c.compliancePct}%
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}

          <Card className="p-4">
            <SectionHeader title="Model card" subtitle="How this page scores things" />
            <div className="mt-2.5 space-y-2 text-[10.5px] leading-relaxed text-mist-500">
              <p><span className="text-mist-300">Risk:</span> weighted additive model over priority (2–22), overdue pressure (≤30), blocked state (≤20), failed turnover (14), owner overload (≤14), dependency chain (≤10), estimate burn (≤12), staleness (6) and client visibility (5). Normalised 0–100.</p>
              <p><span className="text-mist-300">Scheduling:</span> critical-path slack (topological, cycle-safe) then WSPT ordering, then calendar packing against weekly capacity.</p>
              <p><span className="text-mist-300">Insights:</span> rule-based detectors with fixed thresholds. No LLM in the decision path — every number is reproducible from the database.</p>
            </div>
          </Card>
        </div>
      </div>

      {openTask && <TaskDrawer taskId={openTask} onClose={() => setParams(new URLSearchParams())} />}

      {/* --------------------------------------------------- acknowledge */}
      <Modal
        open={acknowledging !== null}
        icon="Check"
        title="Acknowledge this finding"
        subtitle="The analysis is not changed. This records that you looked at it and are accepting it, and why."
        width={520}
        onClose={() => setAcknowledging(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAcknowledging(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={acknowledge.isPending}
              onClick={() => acknowledging && acknowledge.mutate({
                key: acknowledging.key,
                reason: reason.trim(),
                muteHours: Number(muteHours) || 0,
              })}
            >
              Acknowledge
            </Button>
          </>
        }
      >
        {acknowledging && (
          <div className="space-y-3">
            <div className="rounded-lg border border-ink-600 bg-ink-850/60 px-2.5 py-2">
              <p className="text-[11.5px] font-medium leading-snug text-mist-200">{acknowledging.title}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">{acknowledging.body}</p>
            </div>

            <Field label="Why are you accepting it?" hint="Asked after an incident: who decided this, and on what grounds. Optional, but the record is worth more with it.">
              {({ id }) => (
                <Textarea
                  id={id}
                  autoFocus
                  rows={3}
                  value={reason}
                  placeholder="Staffed on the critical path until the 14th; reviewed with the client."
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>

            <Field label="For how long" hint="A snooze returns the finding on its own, so nothing stays hidden because someone forgot.">
              {({ id }) => (
                <Select id={id} value={muteHours} onChange={(e) => setMuteHours(e.target.value)}>
                  {MUTE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              )}
            </Field>

            {acknowledge.error ? <ApiFailure error={acknowledge.error} what="the finding was not acknowledged." /> : null}
          </div>
        )}
      </Modal>
    </div>
  );
}
