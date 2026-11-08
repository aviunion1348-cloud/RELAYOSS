/** Project detail — phase spine, turnover gates, ship gate, edge-case ledger. */
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { clockLabel, inr, relTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Avatar, Badge, Button, Card, HEALTH_TONE, Progress, Ring, SectionHeader, Skeleton, Tooltip } from '../components/ui';

const PHASE_STATUS_TONE: Record<string, string> = { done: 'mint', active: 'iris', blocked: 'rose', locked: 'neutral' };

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: p, isLoading } = useQuery({ queryKey: ['project', id], queryFn: () => api.project(id!), enabled: !!id });

  const updatePhase = useMutation({
    mutationFn: (vars: { phaseRowId: string; patch: Record<string, unknown> }) => api.updatePhase(id!, vars.phaseRowId, vars.patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['clocks'] });
    },
  });

  if (isLoading || !p) {
    return <div className="p-5"><Skeleton className="h-8 w-64" /><div className="mt-4 grid gap-3 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div></div>;
  }

  const gateItems = [
    { key: 'edgeCases', label: '3,500 edge cases catalogued', ok: p.shipGate.edgeCases, detail: `${p.edgeCases.total}/${p.edgeCases.target}` },
    { key: 'edgeVerified', label: '90% edge cases verified', ok: p.shipGate.edgeVerified, detail: `${p.edgeCases.verified} verified` },
    { key: 'openP0', label: 'No open P0 / P1', ok: p.shipGate.openP0, detail: p.shipGate.openP0 ? 'clear' : 'blocking defects' },
    { key: 'execSummary', label: 'Executive summary published', ok: p.shipGate.execSummary, detail: p.shipGate.execSummary ? 'on file' : 'missing' },
    { key: 'clientAccepted', label: 'Client acceptance recorded', ok: p.shipGate.clientAccepted, detail: p.shipGate.clientAccepted ? 'signed' : 'pending' },
  ];
  const gateScore = Math.round((gateItems.filter((g) => g.ok).length / gateItems.length) * 100);

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={
          <>
            <Icons.FolderKanban size={11} />
            <span>{p.clientName}</span>
            <span className="text-mist-500/50">/</span>
            <span className="font-mono">{p.key}</span>
          </>
        }
        title={p.name}
        subtitle={p.description}
        right={
          <>
            <Badge tone={HEALTH_TONE[p.health] ?? 'neutral'} dot>{p.health.replace('_', ' ')}</Badge>
            <Badge tone="outline" mono>{p.branch}</Badge>
            <Badge tone="outline">{p.deployTarget}</Badge>
            {p.owner && <span className="flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850 px-2 py-1"><Avatar {...p.owner} size={16} /><span className="text-[11px] text-mist-300">{p.owner.name}</span></span>}
          </>
        }
      />

      {/* top metrics */}
      <div className="grid grid-cols-2 gap-2.5 px-5 pt-4 lg:grid-cols-5">
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Progress</p>
          <div className="mt-1 flex items-center gap-2.5">
            <Ring value={p.progress} size={38} stroke={3} />
            <div>
              <p className="text-[11px] tabular text-mist-300">{p.doneCount}/{p.taskCount} shipped</p>
              <p className="text-[10px] text-mist-500">{p.openTasks} open</p>
            </div>
          </div>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Effort</p>
          <p className="mt-1 text-[20px] font-semibold leading-none tabular text-white">{Math.round(p.loggedHours)}h</p>
          <p className="mt-1 text-[10px] text-mist-500">of {Math.round(p.hoursBudget)}h budgeted</p>
          <Progress value={(p.loggedHours / Math.max(1, p.hoursBudget)) * 100} tone={p.loggedHours > p.hoursBudget ? 'rose' : 'iris'} className="mt-1.5" height={3} />
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Budget</p>
          <p className="mt-1 text-[20px] font-semibold leading-none tabular text-white">{inr(p.budgetCents, { compact: true })}</p>
          <p className="mt-1 text-[10px] text-mist-500">target {p.targetEndAt ? shortDate(p.targetEndAt) : 'TBD'}</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Edge cases</p>
          <p className="mt-1 text-[20px] font-semibold leading-none tabular text-white">{p.edgeCases.total.toLocaleString('en-IN')}</p>
          <p className="mt-1 text-[10px] text-mist-500">of {p.edgeCases.target.toLocaleString('en-IN')} · {p.edgeCases.verified} verified</p>
          <Progress value={p.edgeCases.progressPct} tone={p.edgeCases.progressPct >= 100 ? 'mint' : 'amber'} className="mt-1.5" height={3} />
        </Card>
        <Card className={cls('p-3.5', gateScore === 100 && 'border-mint-500/40')}>
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Ship gate</p>
          <div className="mt-1 flex items-center gap-2">
            <p className={cls('text-[20px] font-semibold leading-none tabular', gateScore === 100 ? 'text-mint-400' : 'text-amber-400')}>{gateScore}%</p>
            {gateScore === 100 && <Icons.CheckCircle2 size={14} className="text-mint-400" />}
          </div>
          <p className="mt-1 text-[10px] text-mist-500">{gateItems.filter((g) => g.ok).length}/{gateItems.length} conditions met</p>
        </Card>
      </div>

      <div className="grid gap-3 px-5 pt-3 xl:grid-cols-[1.5fr_1fr]">
        {/* phase spine */}
        <Card className="p-4">
          <SectionHeader title="Phase spine" subtitle="Each gate must pass before the next unlocks — with a named sign-off" />
          <div className="mt-3 space-y-1.5">
            {p.phases.map((ph, i) => (
              <div key={ph.id} className={cls('relative rounded-lg border p-2.5', ph.status === 'active' ? 'border-iris-500/40 bg-iris-500/[0.05]' : 'border-ink-700 bg-ink-850/40')}>
                <div className="flex items-start gap-2.5">
                  <span className={cls('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[9px] font-semibold',
                    ph.status === 'done' ? 'border-mint-500/50 bg-mint-500/15 text-mint-400'
                      : ph.status === 'active' ? 'border-iris-500/50 bg-iris-500/15 text-iris-300'
                      : ph.status === 'blocked' ? 'border-rose-500/50 bg-rose-500/15 text-rose-400'
                      : 'border-ink-500 bg-ink-800 text-mist-500')}>
                    {ph.status === 'done' ? <Icons.Check size={10} /> : ph.status === 'blocked' ? <Icons.Ban size={9} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[12px] font-semibold text-mist-100">{ph.name}</p>
                      <Badge tone={PHASE_STATUS_TONE[ph.status]}>{ph.status}</Badge>
                      {ph.turnoverPassed && <Badge tone="mint"><Icons.ShieldCheck size={8} /> turnover</Badge>}
                      <span className="ml-auto text-[9.5px] tabular text-mist-500">{ph.doneCount}/{ph.taskCount} tasks</span>
                    </div>
                    <p className="mt-0.5 text-[10.5px] leading-relaxed text-mist-500">{ph.turnoverPolicy}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Progress value={ph.progress} tone={ph.status === 'done' ? 'mint' : ph.status === 'blocked' ? 'rose' : 'iris'} height={3} />
                      <span className="shrink-0 text-[9.5px] tabular text-mist-500">{ph.progress}%</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px] text-mist-500">
                      <span>{ph.dueAt ? `due ${shortDate(ph.dueAt)}` : 'no date'}</span>
                      <span>· SLA {ph.slaDays}d</span>
                      {ph.signoff && <span>· signed {ph.signoff}</span>}
                      <span className="ml-auto flex items-center gap-1">
                        <Icons.ShieldCheck size={8} /> gates {ph.gateScore}%
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {ph.gates.map((g) => (
                        <Tooltip key={g.id} label={`${g.key} · ${g.name} → ${g.status}`}>
                          <span className={cls('size-1.5 rounded-full',
                            g.status === 'pass' ? 'bg-mint-500' : g.status === 'fail' ? 'bg-rose-500' : g.status === 'waived' ? 'bg-sky-500' : 'bg-ink-500')} />
                        </Tooltip>
                      ))}
                    </div>
                    {ph.status === 'active' && (
                      <div className="mt-2 flex gap-1.5">
                        <Button size="xs" variant="secondary" disabled={updatePhase.isPending} onClick={() => updatePhase.mutate({ phaseRowId: ph.id, patch: { progress: Math.min(100, ph.progress + 10) } })}>
                          +10%
                        </Button>
                        <Button size="xs" variant="success" disabled={updatePhase.isPending} onClick={() => updatePhase.mutate({ phaseRowId: ph.id, patch: { status: 'done', progress: 100, turnoverPassed: true } })}>
                          Sign off & close
                        </Button>
                        <Button size="xs" variant="danger" disabled={updatePhase.isPending} onClick={() => updatePhase.mutate({ phaseRowId: ph.id, patch: { status: 'blocked' } })}>
                          Block
                        </Button>
                      </div>
                    )}
                    {ph.status === 'locked' && i > 0 && p.phases[i - 1].status === 'done' && (
                      <Button size="xs" variant="secondary" className="mt-2" disabled={updatePhase.isPending} onClick={() => updatePhase.mutate({ phaseRowId: ph.id, patch: { status: 'active' } })}>
                        Start phase
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-3">
          {/* ship gate */}
          <Card className={cls('p-4', gateScore === 100 && 'border-mint-500/40')}>
            <SectionHeader title="Ship gate" subtitle="Five non-negotiables before production" />
            <div className="mt-2.5 space-y-1.5">
              {gateItems.map((g) => (
                <div key={g.key} className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850/40 px-2 py-1.5">
                  <span className={cls('grid size-4 shrink-0 place-items-center rounded-full', g.ok ? 'bg-mint-500/15 text-mint-400' : 'bg-rose-500/15 text-rose-400')}>
                    {g.ok ? <Icons.Check size={9} /> : <Icons.X size={9} />}
                  </span>
                  <span className={cls('flex-1 text-[11px]', g.ok ? 'text-mist-300' : 'text-mist-400')}>{g.label}</span>
                  <span className="text-[9.5px] tabular text-mist-500">{g.detail}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* clocks */}
          {p.timers.length > 0 && (
            <Card className="p-4">
              <SectionHeader title="Running clocks" subtitle="Turnover commitments on this project" />
              <div className="mt-2.5 space-y-2">
                {p.timers.map((t) => (
                  <div key={t.id}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-[10.5px] text-mist-400">{t.label || t.clockName}</p>
                      <span className={cls('text-[10px] tabular', t.hoursLeft < 0 ? 'text-rose-400' : t.hoursLeft < 12 ? 'text-amber-400' : 'text-mist-400')}>
                        {clockLabel(t.hoursLeft)}
                      </span>
                    </div>
                    <Progress value={t.progressPct} tone={t.hoursLeft < 0 ? 'rose' : t.progressPct > 66 ? 'amber' : 'mint'} height={2} className="mt-1" />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* handoffs */}
          <Card className="p-4">
            <SectionHeader title="Client handoffs" subtitle="Excaliboard, Figma, Loom artefacts" />
            <div className="mt-2.5 space-y-1.5">
              {p.handoffs.length === 0 && <p className="text-[10.5px] text-mist-500">No handoff artefacts linked yet.</p>}
              {p.handoffs.map((h) => (
                <a key={h.id} href={h.url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/50 px-2 py-1.5 transition-colors hover:border-ink-500 hover:bg-ink-800">
                  <span className="grid size-5 shrink-0 place-items-center rounded bg-iris-500/12 text-iris-300">
                    {h.type === 'excalidraw' ? <Icons.PenTool size={10} /> : h.type === 'figma' ? <Icons.Figma size={10} /> : h.type === 'loom' ? <Icons.Video size={10} /> : <Icons.FileText size={10} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-mist-300">{h.title}</span>
                  <Badge tone={h.status === 'approved' ? 'mint' : h.status === 'changes_requested' ? 'rose' : h.status === 'shared' ? 'sky' : 'neutral'}>{h.status.replace('_', ' ')}</Badge>
                  <Icons.ExternalLink size={9} className="shrink-0 text-mist-500" />
                </a>
              ))}
            </div>
          </Card>

          {/* edge cases */}
          <Card className="p-4">
            <SectionHeader title="Edge-case ledger" subtitle={`${p.edgeCases.verified} verified of ${p.edgeCases.total} catalogued`} />
            <div className="mt-2.5 space-y-1.5">
              {p.edgeCases.byCategory.slice(0, 6).map((c) => (
                <div key={c.category} className="flex items-center gap-2">
                  <span className="w-[74px] shrink-0 text-[10px] capitalize text-mist-500">{c.category}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full rounded-full bg-sky-500" style={{ width: `${(c.count / Math.max(1, p.edgeCases.byCategory[0].count)) * 100}%` }} />
                  </div>
                  <span className="w-5 shrink-0 text-right text-[9.5px] tabular text-mist-500">{c.count}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* releases + qa */}
      <div className="mt-3 grid gap-3 px-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-ink-700/70 px-4 py-3"><SectionHeader title="Releases" subtitle="Demo → approval → ship" /></div>
          <div className="divide-y divide-ink-700/50">
            {p.releases.map((r) => (
              <div key={r.id} className="flex items-center gap-2.5 px-4 py-2.5">
                <Icons.Rocket size={12} className={r.status === 'shipped' ? 'text-mint-400' : r.status === 'demo_ready' ? 'text-amber-400' : 'text-mist-500'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-mist-400">{r.version}</span>
                    <span className="truncate text-[11.5px] text-mist-200">{r.name}</span>
                  </div>
                  <p className="text-[9.5px] text-mist-500">
                    demo {r.demoAt ?? '—'} · ship {r.shipPlannedAt ?? '—'}
                    {!r.execSummaryUrl && r.status !== 'shipped' && <span className="ml-1 text-amber-400">· exec summary missing</span>}
                  </p>
                </div>
                <Badge tone={r.status === 'shipped' ? 'mint' : r.status === 'demo_ready' || r.status === 'demo_done' ? 'amber' : 'neutral'}>{r.status.replace('_', ' ')}</Badge>
              </div>
            ))}
            {p.releases.length === 0 && <p className="px-4 py-6 text-center text-[11px] text-mist-500">No releases yet.</p>}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-ink-700/70 px-4 py-3"><SectionHeader title="QA reports" subtitle="12-hour turnover clock on every report" /></div>
          <div className="max-h-[280px] divide-y divide-ink-700/50 overflow-y-auto">
            {p.qa.map((q) => (
              <div key={q.id} className="flex items-center gap-2.5 px-4 py-2">
                <Badge tone={q.severity === 'p0' || q.severity === 'p1' ? 'rose' : q.severity === 'p2' ? 'amber' : 'neutral'}>{q.severity}</Badge>
                <span className="min-w-0 flex-1 truncate text-[11px] text-mist-300">{q.title}</span>
                {q.overdue && <Badge tone="rose">overdue</Badge>}
                <Badge tone={q.status === 'verified' ? 'mint' : q.status === 'open' ? 'amber' : 'neutral'}>{q.status}</Badge>
              </div>
            ))}
            {p.qa.length === 0 && <p className="px-4 py-6 text-center text-[11px] text-mist-500">No QA reports.</p>}
          </div>
        </Card>
      </div>

      {/* docs */}
      <div className="mt-3 px-5">
        <Card className="overflow-hidden">
          <div className="border-b border-ink-700/70 px-4 py-3"><SectionHeader title="Knowledge" subtitle="Runbooks, ADRs and specs for this project" /></div>
          <div className="grid gap-1.5 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {p.docs.map((d) => (
              <div key={d.id} className="rounded-lg border border-ink-700 bg-ink-850/50 p-2.5">
                <div className="flex items-center gap-1.5">
                  <Icons.FileText size={10} className="text-mist-500" />
                  <Badge tone="outline">{d.kind}</Badge>
                  {d.client_visible ? <Badge tone="sky">client</Badge> : null}
                </div>
                <p className="mt-1 text-[11px] font-medium text-mist-200">{d.title}</p>
                <p className="text-[9.5px] text-mist-500">updated {relTime(d.updated_at)} · {d.status}</p>
              </div>
            ))}
            {p.docs.length === 0 && <p className="px-1 py-4 text-[11px] text-mist-500">No docs linked.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
