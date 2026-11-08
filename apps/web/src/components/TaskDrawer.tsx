/**
 * Task drawer — where governance actually happens.
 * Shows: description, the 4-step acceptance ladder, turnover gates with
 * evidence capture, blockers, timers, comments, checklist and audit trail.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from './icons';
import { api, ApiError } from '../lib/api';
import { cls } from '../lib/cls';
import { dateTime, hours, relTime, shortDate } from '../lib/format';
import type { AcceptanceStep, TaskDetail } from '../types';
import { Avatar, Badge, Button, Dot, Input, PRIORITY_TONE, Progress, Select, STATUS_LABEL, STATUS_TONE, Textarea, Tooltip } from './ui';
import { QueryFailure } from './QueryFailure';
import { useQueryState } from '../lib/query-state';

const LADDER: Array<{ step: AcceptanceStep; label: string; icon: keyof typeof Icons; blurb: string; role: string }> = [
  { step: 'dev_complete', label: 'Dev complete', icon: 'Code2', blurb: 'Implementation merged behind a flag', role: 'Engineer' },
  { step: 'qa_approved', label: 'QA approved', icon: 'ShieldCheck', blurb: 'Bug & test report attached within 12h', role: 'QA' },
  { step: 'lead_approved', label: 'Lead approved', icon: 'UserCheck', blurb: 'CTO / HoE signs the turnover gate', role: 'CTO / HoE' },
  { step: 'client_accepted', label: 'Client accepted', icon: 'Handshake', blurb: 'Written acceptance from the client', role: 'PM + Client' },
];

function Sig({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[9.5px] font-medium uppercase tracking-[0.1em] text-mist-500">{label}</p>
      <div className="mt-1 text-[11.5px] text-mist-300">{value}</div>
    </div>
  );
}

function useToast() {
  const [errored, setErrored] = useState<string | null>(null);
  useEffect(() => {
    if (!errored) return;
    const t = setTimeout(() => setErrored(null), 6000);
    return () => clearTimeout(t);
  }, [errored]);
  return { errored, setErrored };
}

export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const taskQuery = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId) });
  const tq = useQueryState(taskQuery);
  const task = tq.data;
  const { data: meta } = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const [comment, setComment] = useState('');
  const [gateDraft, setGateDraft] = useState<Record<string, string>>({});
  const { errored, setErrored } = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['insights'] });
  };

  const onError = (e: unknown) => {
    if (e instanceof ApiError) setErrored(e.message + (e.details ? ` — ${JSON.stringify((e.details as { blockers?: unknown }).blockers ?? e.details).slice(0, 200)}` : ''));
    else setErrored(String(e));
  };

  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.updateTask(taskId, body), onSuccess: invalidate, onError });
  const gate = useMutation({
    mutationFn: (vars: { gateId: string; status: string; evidence?: string }) => api.turnoverCheck(taskId, vars.gateId, vars.status, vars.evidence),
    onSuccess: () => { invalidate(); setErrored(null); },
    onError,
  });
  const accept = useMutation({
    mutationFn: (vars: { step: AcceptanceStep; state: 'passed' | 'rejected' }) => api.acceptance(taskId, vars.step, vars.state, 'Signed off in Relay'),
    onSuccess: () => { invalidate(); setErrored(null); },
    onError,
  });
  const addComment = useMutation({
    mutationFn: (body: string) => api.comment(taskId, body),
    onSuccess: () => { setComment(''); setErrored(null); invalidate(); },
    onError,
  });
  const toggleCheck = useMutation({
    mutationFn: (vars: { itemId: string; done: boolean }) => api.toggleChecklist(taskId, vars.itemId, vars.done),
    onSuccess: () => { setErrored(null); invalidate(); },
    onError,
  });

  /*
   * The drawer is opened by clicking a specific card, so a failure here has to
   * name the card and offer a retry. It used to render one shimmering bar inside
   * an open drawer — indistinguishable from slow loading, on a panel the reader
   * cannot close except by clicking outside.
   */
  if (tq.state === 'failed') {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-[2px]" onClick={onClose} />
        <aside className="glass-strong fixed right-0 top-0 z-50 flex h-full w-[min(760px,96vw)] flex-col border-l border-gold-600/20">
          <div className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
            <p className="text-[13px] font-semibold text-mist-100">Task {taskId}</p>
            <Button size="xs" variant="ghost" icon="X" onClick={onClose}>Close</Button>
          </div>
          <QueryFailure error={tq.error} what={`task ${taskId}`} retry={tq.refetch} />
        </aside>
      </>
    );
  }

  if (tq.state !== 'ready') {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-[2px]" onClick={onClose} />
        <aside className="glass-strong fixed right-0 top-0 z-50 h-full w-[min(760px,96vw)] border-l border-gold-600/20 p-6">
          <div className="shimmer h-6 w-56 rounded" />
        </aside>
      </>
    );
  }

  const t = task as TaskDetail;
  const acceptanceMap = new Map(t.acceptance.map((a) => [a.step, a]));
  const ready = t.turnover.ready;
  const canShip = ready && acceptanceMap.get('qa_approved')?.state === 'passed' && acceptanceMap.get(t.clientVisible ? 'client_accepted' : 'lead_approved')?.state === 'passed';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-950/65 backdrop-blur-[2px] animate-fade" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-[min(820px,97vw)] flex-col border-l border-ink-600 bg-ink-900 shadow-[-24px_0_60px_-20px_rgb(0_0_0/0.9)] animate-slide-in">
        {/* header */}
        <div className="shrink-0 border-b border-ink-700/80 px-5 pb-3 pt-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-md border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] text-mist-400">{t.key}</span>
                <Badge tone={PRIORITY_TONE[t.priority]} dot>{t.priority}</Badge>
                <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                {t.clientVisible && <Badge tone="sky"><Icons.Globe size={9} /> client-visible</Badge>}
                {t.turnoverState === 'failed' && <Badge tone="rose">gate failed</Badge>}
                {t.dueAt && <Badge tone="outline"><Icons.Calendar size={9} /> {shortDate(t.dueAt)}</Badge>}
              </div>
              <h2 className="mt-2 text-balance text-[17px] font-semibold leading-snug tracking-tight text-white">{t.title}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-mist-500">
                {t.project && (
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-sm" style={{ background: t.client?.color }} />
                    {t.project.name}
                  </span>
                )}
                {t.phase && <span className="flex items-center gap-1.5"><Icons.Layers size={10} /> {t.phase.name}</span>}
                <span className="flex items-center gap-1.5"><Icons.GitBranch size={10} /> {t.branch || 'lear-backend'}</span>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}><Icons.X size={15} /></Button>
          </div>

          {/* quick actions */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Select
              value={t.status}
              onChange={(e) => patch.mutate({ status: e.target.value })}
              className="h-7 w-[130px] text-[11.5px]"
            >
              {(['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'] as const).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </Select>
            <Select
              value={t.assignee?.id ?? ''}
              onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}
              className="h-7 w-[150px] text-[11.5px]"
            >
              <option value="">Unassigned</option>
              {(meta?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
            <Select
              value={t.priority}
              onChange={(e) => patch.mutate({ priority: e.target.value })}
              className="h-7 w-[110px] text-[11.5px]"
            >
              {(['urgent', 'high', 'medium', 'low'] as const).map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <div className="ml-auto flex items-center gap-1.5">
              <Tooltip label={canShip ? 'All gates green — ship it' : 'Turnover gates or acceptance steps are outstanding'}>
                <Button
                  variant={canShip ? 'success' : 'secondary'}
                  size="sm"
                  icon="CheckCheck"
                  disabled={t.status === 'done' || patch.isPending}
                  onClick={() => patch.mutate({ status: 'done' })}
                >
                  Mark shipped
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>

        {errored && (
          <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-rose-300 animate-rise">
            <Icons.ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{errored}</span>
            <button onClick={() => setErrored(null)} className="text-rose-400/60 hover:text-rose-300"><Icons.X size={12} /></button>
          </div>
        )}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
            {/* left */}
            <div className="min-w-0 space-y-5">
              {/* acceptance ladder */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-mist-400">
                    <Icons.ListChecks size={12} /> Acceptance ladder
                  </h3>
                  <Badge tone="outline" mono>
                    {t.acceptance.filter((a) => a.state === 'passed').length}/4
                  </Badge>
                </div>
                <div className="surface rounded-lg p-2.5">
                  <div className="space-y-0">
                    {LADDER.map((l, i) => {
                      const state = acceptanceMap.get(l.step)?.state ?? 'pending';
                      const passed = state === 'passed';
                      const rejected = state === 'rejected';
                      const Icon = Icons[l.icon] as React.ComponentType<{ size?: number }>;
                      const isNext = !passed && LADDER.slice(0, i).every((p) => acceptanceMap.get(p.step)?.state === 'passed');
                      return (
                        <div key={l.step} className="relative flex gap-2.5 pb-3 last:pb-0">
                          {i < LADDER.length - 1 && (
                            <span className={cls('absolute left-[9px] top-5 h-full w-px', passed ? 'bg-mint-500/40' : 'bg-ink-600')} />
                          )}
                          <span
                            className={cls(
                              'relative mt-0.5 grid size-[19px] shrink-0 place-items-center rounded-full border text-[9px]',
                              passed ? 'border-mint-500/60 bg-mint-500/15 text-mint-400'
                                : rejected ? 'border-rose-500/60 bg-rose-500/15 text-rose-400'
                                : isNext ? 'border-iris-500/60 bg-iris-500/15 text-iris-300'
                                : 'border-ink-500 bg-ink-800 text-mist-500',
                            )}
                          >
                            {passed ? <Icons.Check size={10} /> : rejected ? <Icons.X size={10} /> : <Icon size={9} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className={cls('text-[11.5px] font-medium', passed ? 'text-mist-200' : 'text-mist-400')}>{l.label}</p>
                              <div className="flex items-center gap-1">
                                {passed ? (
                                  <span className="text-[9.5px] text-mint-400">
                                    {acceptanceMap.get(l.step)?.decidedAt ? relTime(acceptanceMap.get(l.step)!.decidedAt) : 'approved'}
                                  </span>
                                ) : rejected ? (
                                  <Badge tone="rose">rejected</Badge>
                                ) : isNext ? (
                                  <>
                                    <Button size="xs" variant="success" onClick={() => accept.mutate({ step: l.step, state: 'passed' })} disabled={accept.isPending}>
                                      Pass
                                    </Button>
                                    <Button size="xs" variant="danger" onClick={() => accept.mutate({ step: l.step, state: 'rejected' })} disabled={accept.isPending}>
                                      Reject
                                    </Button>
                                  </>
                                ) : (
                                  <span className="text-[9.5px] text-mist-500">{l.role}</span>
                                )}
                              </div>
                            </div>
                            <p className="text-[10px] leading-snug text-mist-500">{l.blurb}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>

              {/* turnover gates */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-mist-400">
                    <Icons.ShieldCheck size={12} /> Turnover gates
                  </h3>
                  <div className="flex items-center gap-2">
                    <Progress value={t.turnover.score} tone={t.turnover.ready ? 'mint' : 'amber'} className="w-16" height={3} />
                    <span className="text-[10px] tabular text-mist-400">{t.turnover.passed}/{t.turnover.checks.length}</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {t.turnover.checks.map((g) => {
                    const tone = g.status === 'pass' ? 'mint' : g.status === 'fail' ? 'rose' : g.status === 'waived' ? 'sky' : 'neutral';
                    return (
                      <div key={g.gateId} className={cls('surface rounded-lg p-2.5', g.status === 'fail' && 'border-rose-500/30')}>
                        <div className="flex items-start gap-2">
                          <span
                            className={cls(
                              'mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[9px]',
                              g.status === 'pass' ? 'border-mint-500/50 bg-mint-500/15 text-mint-400'
                                : g.status === 'fail' ? 'border-rose-500/50 bg-rose-500/15 text-rose-400'
                                : g.status === 'waived' ? 'border-sky-500/50 bg-sky-500/15 text-sky-400'
                                : 'border-ink-500 bg-ink-800 text-mist-500',
                            )}
                          >
                            {g.status === 'pass' ? <Icons.Check size={9} /> : g.status === 'fail' ? <Icons.X size={9} /> : g.status === 'waived' ? '~' : ''}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[9px] text-mist-500">{g.key}</span>
                              <p className="truncate text-[11.5px] font-medium text-mist-300">{g.name}</p>
                              {g.required && g.status === 'pending' && <Badge tone="amber">required</Badge>}
                            </div>
                            <p className="mt-0.5 text-[10px] leading-snug text-mist-500">{g.description}</p>
                            {g.evidence && (
                              <p className="mt-1 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-[10px] leading-snug text-mist-400">
                                <Icons.Paperclip size={9} className="mr-1 inline" />{g.evidence}
                              </p>
                            )}
                            {g.status !== 'pass' && (
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <Input
                                  value={gateDraft[g.gateId] ?? ''}
                                  onChange={(e) => setGateDraft((s) => ({ ...s, [g.gateId]: e.target.value }))}
                                  placeholder="Evidence — PR link, CI run, test output…"
                                  className="h-6 flex-1 text-[10.5px]"
                                />
                                <Button
                                  size="xs"
                                  variant="success"
                                  disabled={gate.isPending}
                                  onClick={() => gate.mutate({ gateId: g.gateId, status: 'pass', evidence: gateDraft[g.gateId] })}
                                >
                                  Pass
                                </Button>
                                <Button size="xs" variant="danger" disabled={gate.isPending} onClick={() => gate.mutate({ gateId: g.gateId, status: 'fail', evidence: gateDraft[g.gateId] })}>
                                  Fail
                                </Button>
                                <Button size="xs" variant="ghost" disabled={gate.isPending} onClick={() => gate.mutate({ gateId: g.gateId, status: 'waived', evidence: gateDraft[g.gateId] || 'Waived by delivery lead' })}>
                                  Waive
                                </Button>
                              </div>
                            )}
                          </div>
                          <Badge tone={tone}>{g.status}</Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* description */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-mist-400">
                  <Icons.AlignLeft size={12} /> Brief
                </h3>
                <DecisionTextarea
                  value={t.description}
                  onSave={(v) => patch.mutate({ description: v })}
                  placeholder="What does done look like? Acceptance criteria, edge cases, and the evidence you'll attach."
                />
              </section>

              {/* checklist */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-mist-400">
                  <Icons.SquareCheck size={12} /> Definition of done
                  <span className="ml-1 text-[10px] normal-case tracking-normal text-mist-500">
                    {t.checklist.filter((c) => c.done).length}/{t.checklist.length}
                  </span>
                </h3>
                <div className="space-y-1">
                  {t.checklist.map((c) => (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-ink-800/60">
                      <input
                        type="checkbox"
                        checked={c.done}
                        onChange={() => toggleCheck.mutate({ itemId: c.id, done: !c.done })}
                        className="size-3 accent-iris-500"
                      />
                      <span className={cls('text-[11.5px]', c.done ? 'text-mist-500 line-through' : 'text-mist-300')}>{c.label}</span>
                    </label>
                  ))}
                  {t.checklist.length === 0 && <p className="px-1 text-[11px] text-mist-500">No checklist items yet.</p>}
                </div>
              </section>

              {/* comments */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-mist-400">
                  <Icons.MessageSquare size={12} /> Discussion
                </h3>
                <div className="space-y-2">
                  {t.comments.map((c) => (
                    <div key={c.id} className="flex gap-2">
                      <Avatar name={c.author.name} initials={c.author.initials} color={c.author.color} size={20} />
                      <div className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-medium text-mist-200">{c.author.name}</span>
                          <span className="text-[9.5px] text-mist-500">{relTime(c.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed text-mist-400">{c.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Textarea
                    rows={2}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Add context, a decision, or an @mention…"
                    className="text-[11.5px]"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    icon="Send"
                    disabled={!comment.trim() || addComment.isPending}
                    onClick={() => addComment.mutate(comment.trim())}
                  >
                    Send
                  </Button>
                </div>
              </section>
            </div>

            {/* right rail */}
            <div className="min-w-0 space-y-4">
              <div className="surface rounded-lg p-3">
                <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">Properties</p>
                <div className="grid grid-cols-2 gap-3">
                  <Sig label="Assignee" value={t.assignee ? (
                    <span className="flex items-center gap-1.5"><Avatar {...t.assignee} size={16} />{t.assignee.name.split(' ')[0]}</span>
                  ) : <span className="text-mist-500">Unassigned</span>} />
                  <Sig label="Reporter" value={t.reporter?.name ?? '—'} />
                  <Sig label="Estimate" value={`${hours(t.estimateHours)} · ${t.storyPoints} pts`} />
                  <Sig label="Logged" value={hours(t.loggedHours)} />
                  <Sig label="Phase" value={t.phase?.name ?? '—'} />
                  <Sig label="Due" value={t.dueAt ? shortDate(t.dueAt) : '—'} />
                </div>
              </div>

              {/* risk */}
              <div className="surface rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">Risk exposure</p>
                  {t.risk && <Badge tone={t.risk.band === 'critical' ? 'rose' : t.risk.band === 'high' ? 'amber' : 'neutral'}>{t.risk.band}</Badge>}
                </div>
                <div className="mt-2 flex items-center gap-2.5">
                  <span className={cls('text-[24px] font-semibold leading-none tabular', (t.risk?.score ?? 0) >= 70 ? 'text-rose-400' : (t.risk?.score ?? 0) >= 45 ? 'text-amber-400' : 'text-mist-300')}>
                    {t.risk?.score ?? 0}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    {(t.risk?.factors ?? []).slice(0, 4).map((f) => (
                      <div key={f.key} className="flex items-center gap-1.5">
                        <span className="w-[86px] shrink-0 truncate text-[9.5px] text-mist-500">{f.label}</span>
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
                          <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, (f.weight / 30) * 100)}%` }} />
                        </div>
                        <span className="w-4 shrink-0 text-right text-[9px] tabular text-mist-500">{Math.round(f.weight)}</span>
                      </div>
                    ))}
                    {(t.risk?.factors ?? []).length === 0 && <p className="text-[10.5px] text-mist-500">No risk factors detected.</p>}
                  </div>
                </div>
              </div>

              {/* timers */}
              {t.timers.length > 0 && (
                <div className="surface rounded-lg p-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">Operational clocks</p>
                  <div className="space-y-2">
                    {t.timers.map((tm) => (
                      <div key={tm.id} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[11px] text-mist-300">{tm.label || tm.clock}</p>
                          <p className="text-[9.5px] text-mist-500">due {dateTime(tm.dueAt)}</p>
                        </div>
                        <Badge tone={tm.outcome === 'missed' ? 'rose' : tm.outcome === 'met' ? 'mint' : 'amber'}>{tm.outcome}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* deps */}
              {(t.dependencies.length > 0 || t.blockedBy.length > 0) && (
                <div className="surface rounded-lg p-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">Dependencies</p>
                  <div className="space-y-1.5">
                    {t.dependencies.map((d) => (
                      <div key={d.id} className="flex items-center gap-1.5 text-[11px]">
                        <Icons.ArrowUpRight size={10} className="text-mist-500" />
                        <span className="font-mono text-[9.5px] text-mist-500">{d.key}</span>
                        <span className="truncate text-mist-400">{d.title}</span>
                        <Badge tone={STATUS_TONE[d.status] ?? 'neutral'} className="ml-auto shrink-0">{d.status}</Badge>
                      </div>
                    ))}
                    {t.blockedBy.map((d) => (
                      <div key={d.id} className="flex items-center gap-1.5 text-[11px]">
                        <Icons.Lock size={10} className="text-amber-400" />
                        <span className="font-mono text-[9.5px] text-mist-500">{d.key}</span>
                        <span className="truncate text-mist-400">{d.title}</span>
                        <Badge tone="amber" className="ml-auto shrink-0">blocks</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* blocked reason */}
              {t.status === 'blocked' && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/8 p-3">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-rose-400">
                    <Icons.Ban size={10} /> Blocked
                  </p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-rose-300/90">{t.blockedReason || 'No reason recorded.'}</p>
                </div>
              )}

              {/* activity */}
              <div className="surface rounded-lg p-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">History</p>
                <div className="space-y-2">
                  {t.activity.slice(0, 8).map((a, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="mt-1 size-1 shrink-0 rounded-full bg-mist-500" />
                      <div className="min-w-0">
                        <p className="text-[10.5px] leading-snug text-mist-400">
                          <span className="text-mist-300">{a.actor?.name.split(' ')[0] ?? 'System'}</span> {a.summary}
                        </p>
                        <p className="text-[9px] text-mist-500/70">{relTime(a.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                  {t.activity.length === 0 && <p className="text-[10.5px] text-mist-500">No history yet.</p>}
                </div>
              </div>

              <div className="roundeding-lg rounded-lg border border-iris-500/20 bg-iris-500/[0.06] p-3">
                <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-iris-300">
                  <Icons.Info size={10} /> Ship rule
                </p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-mist-400">
                  {t.clientVisible ? 'Client-visible' : 'Internal'} work ships only when all required turnover gates pass{' '}
                  <em>and</em> QA + {t.clientVisible ? 'client acceptance' : 'lead approval'} are recorded. The API rejects any other transition.
                </p>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function DecisionTextarea({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <div
        onClick={() => setEditing(true)}
        className="min-h-[64px] cursor-text rounded-lg border border-transparent px-2 py-1.5 text-[11.5px] leading-relaxed text-mist-300 transition-colors hover:border-ink-600 hover:bg-ink-850"
      >
        {value || <span className="text-mist-500">{placeholder}</span>}
      </div>
    );
  }
  return (
    <div>
      <Textarea rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus placeholder={placeholder} />
      <div className="mt-1.5 flex gap-1.5">
        <Button size="xs" variant="primary" onClick={() => { onSave(draft); setEditing(false); }}>Save</Button>
        <Button size="xs" variant="ghost" onClick={() => { setDraft(value); setEditing(false); }}>Cancel</Button>
      </div>
    </div>
  );
}
