/** QA Centre — reports with a 12-hour turnover clock, severity-first ordering. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { relTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Badge, Button, Card, Input, SectionHeader, Segmented, Select, Skeleton } from '../components/ui';

const SEV_TONE: Record<string, string> = { p0: 'rose', p1: 'rose', p2: 'amber', p3: 'sky', p4: 'neutral' };
const STATUS_TONE: Record<string, string> = { open: 'amber', triaged: 'sky', in_progress: 'iris', fixed: 'mint', verified: 'mint', wont_fix: 'neutral', duplicate: 'neutral' };

export default function QACentre() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'open' | 'verified'>('all');
  const [showNew, setShowNew] = useState(false);
  const { data: meta } = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const { data, isLoading } = useQuery({ queryKey: ['qa'], queryFn: () => api.qa() });

  const update = useMutation({
    mutationFn: (vars: { id: string; patch: Record<string, unknown> }) => api.updateQA(vars.id, vars.patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['qa'] }); qc.invalidateQueries({ queryKey: ['clocks'] }); },
  });

  if (isLoading || !data) return <div className="p-5"><Skeleton className="h-8 w-52" /><Skeleton className="mt-4 h-72" /></div>;

  const filtered = data.filter((q) =>
    status === 'all' ? true : status === 'open' ? !['verified', 'wont_fix', 'duplicate'].includes(q.status) : q.status === 'verified',
  );
  const overdue = data.filter((q) => q.overdue);
  const openP0 = data.filter((q) => ['p0', 'p1'].includes(q.severity) && !['verified', 'wont_fix', 'duplicate'].includes(q.status));

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.ShieldCheck size={11} /> Quality engineering</>}
        title="QA Centre"
        subtitle="Every QA pass produces a bug or testing report within 12 hours. Reports are severity-ranked, evidence-linked and tracked until verified — a fix without verification is not a fix."
        right={
          <>
            <Segmented value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'verified', label: 'Verified' }]} />
            <Button variant="primary" size="md" icon="Plus" onClick={() => setShowNew(true)}>New report</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 px-5 pt-4 lg:grid-cols-4">
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Open reports</p>
          <p className="mt-1 text-[22px] font-semibold tabular text-white">{data.filter((q) => !['verified', 'wont_fix', 'duplicate'].includes(q.status)).length}</p>
        </Card>
        <Card className={cls('p-3.5', openP0.length > 0 && 'border-rose-500/40')}>
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Blocking (P0/P1)</p>
          <p className={cls('mt-1 text-[22px] font-semibold tabular', openP0.length ? 'text-rose-400' : 'text-mint-400')}>{openP0.length}</p>
          <p className="mt-0.5 text-[10px] text-mist-500">block the ship gate</p>
        </Card>
        <Card className={cls('p-3.5', overdue.length > 0 && 'border-amber-500/40')}>
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Past 12h turnover</p>
          <p className={cls('mt-1 text-[22px] font-semibold tabular', overdue.length ? 'text-amber-400' : 'text-mint-400')}>{overdue.length}</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Verified</p>
          <p className="mt-1 text-[22px] font-semibold tabular text-mint-400">{data.filter((q) => q.status === 'verified').length}</p>
        </Card>
      </div>

      <div className="px-5 pt-3">
        <Card className="overflow-hidden">
          <div className="divide-y divide-ink-700/50">
            {filtered.map((q) => (
              <div key={q.id} className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-ink-800/40">
                <Badge tone={SEV_TONE[q.severity]} mono>{q.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[9px] text-mist-500">{q.project.key}</span>
                    <p className="text-[11.5px] font-medium text-mist-200">{q.title}</p>
                    {q.overdue && <Badge tone="amber"><Icons.Clock size={8} /> 12h missed</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-mist-500">
                    {q.reproduction || 'No reproduction steps recorded.'}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px] text-mist-500">
                    <Badge tone="outline">{q.kind}</Badge>
                    <span>reported {relTime(q.submittedAt)} by {q.reporter ?? 'QA'}</span>
                    {q.dueAt && <span>· due {shortDate(q.dueAt)}</span>}
                    {q.assignee && <span>· {q.assignee.split(' ')[0]}</span>}
                    {q.evidenceUrl && <span className="flex items-center gap-0.5 text-sky-400"><Icons.Paperclip size={8} /> evidence</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge tone={STATUS_TONE[q.status] ?? 'neutral'}>{q.status.replace('_', ' ')}</Badge>
                  {q.status !== 'verified' && (
                    <>
                      {q.status === 'open' && <Button size="xs" variant="ghost" onClick={() => update.mutate({ id: q.id, patch: { status: 'triaged' } })}>Triage</Button>}
                      <Button size="xs" variant="secondary" disabled={update.isPending} onClick={() => update.mutate({ id: q.id, patch: { status: q.status === 'fixed' ? 'verified' : 'fixed' } })}>
                        {q.status === 'fixed' ? 'Verify' : 'Fix'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {filtered.length === 0 && <p className="px-4 py-10 text-center text-[11.5px] text-mist-500">No reports in this view.</p>}
          </div>
        </Card>
      </div>

      <div className="px-5 pt-3">
        <Card className="p-4">
          <SectionHeader title="QA contract" subtitle="What the delivery board requires from every QA pass" />
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {[
              ['12-hour report turnover', 'A report lands within 12 hours of the QA pass. The clock starts on submission and is audited.'],
              ['Per-module and per-milestone', 'Both module turnover (24h) and milestone turnover (7d) require recorded test evidence, not a verbal OK.'],
              ['Verification is separate', 'Status moves open → triaged → fixed → verified. Only a verified report stops blocking the ship gate.'],
            ].map(([t, b]) => (
              <div key={t} className="rounded-lg border border-ink-700 bg-ink-850/50 p-2.5">
                <p className="text-[11px] font-medium text-mist-200">{t}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-mist-500">{b}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {showNew && meta && (
        <NewReport
          projects={meta.projects}
          users={meta.users}
          onClose={() => setShowNew(false)}
          onDone={() => { setShowNew(false); qc.invalidateQueries({ queryKey: ['qa'] }); }}
        />
      )}
    </div>
  );
}

function NewReport({
  projects, users, onClose, onDone,
}: { projects: Array<{ id: string; name: string }>; users: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ projectId: projects[0]?.id ?? '', title: '', severity: 'p2', kind: 'bug', reproduction: '', body: '', assigneeId: '' });
  const create = useMutation({ mutationFn: () => api.createQA({ ...form, assigneeId: form.assigneeId || null }), onSuccess: onDone });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm animate-fade" onClick={onClose}>
      <div className="w-full max-w-[540px] rounded-xl border border-ink-500 bg-ink-850 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-white">New QA report</h3>
          <Button variant="ghost" size="xs" onClick={onClose}><Icons.X size={13} /></Button>
        </div>
        <div className="mt-3 space-y-2">
          <Input autoFocus placeholder="Title — what broke, where?" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          <div className="grid grid-cols-3 gap-2">
            <Select value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
              {['p0', 'p1', 'p2', 'p3', 'p4'].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
            </Select>
            <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
              {['bug', 'test', 'regression', 'security', 'a11y', 'perf'].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <textarea rows={2} placeholder="Reproduction steps" value={form.reproduction} onChange={(e) => setForm((f) => ({ ...f, reproduction: e.target.value }))}
            className="w-full resize-none rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-2 text-[12px] text-mist-200 placeholder:text-mist-500 focus:border-iris-500/60 focus:outline-none" />
          <Select value={form.assigneeId} onChange={(e) => setForm((f) => ({ ...f, assigneeId: e.target.value }))}>
            <option value="">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <p className="text-[10px] text-mist-500">A 12-hour turnover clock starts the moment this report is submitted.</p>
        </div>
        <div className="mt-3 flex justify-end gap-1.5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={form.title.length < 4 || create.isPending} loading={create.isPending} onClick={() => create.mutate()}>Submit report</Button>
        </div>
      </div>
    </div>
  );
}
