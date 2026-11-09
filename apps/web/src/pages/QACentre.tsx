/** QA Centre — reports with a 12-hour turnover clock, severity-first ordering. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { relTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { MutationFailure, QueryFailure } from '../components/QueryFailure';
import { useMutationFailure, useQueryState } from '../lib/query-state';
import { Badge, Button, Card, Field, Input, Modal, SectionHeader, Segmented, Select, Skeleton, Textarea } from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';

const SEV_TONE: Record<string, string> = { p0: 'rose', p1: 'rose', p2: 'amber', p3: 'sky', p4: 'neutral' };
const STATUS_TONE: Record<string, string> = { open: 'amber', triaged: 'sky', in_progress: 'iris', fixed: 'mint', verified: 'mint', wont_fix: 'neutral', duplicate: 'neutral' };

/**
 * One report, with the verification chain attached.
 *
 * The four states are a sequence, not a set of labels: reported → triaged → fixed →
 * verified. The only status the ship gate trusts is the last one, and the server now
 * refuses it unless the report was fixed first and carries evidence. This row explains
 * that where the reader is standing instead of in a policy card at the bottom of the
 * page, and it names the missing half when a verification is refused.
 */
function ReportRow({
  report,
  onUpdate,
  pending,
}: {
  report: {
    id: string; title: string; kind: string; severity: string; status: string;
    project: { name: string; key: string }; reporter: string | null; assignee: string | null;
    reproduction: string; evidenceUrl: string; submittedAt: string; dueAt: string | null;
    overdue: boolean;
  };
  onUpdate: (patch: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState(report.evidenceUrl ?? '');
  const [error, setError] = useState<unknown>(null);

  const saveEvidence = async () => {
    setError(null);
    try {
      await api.updateQA(report.id, { evidenceUrl: evidence.trim() });
      onUpdate({}); /* invalidate */
    } catch (e) {
      setError(e);
    }
  };

  const hasEvidence = Boolean(report.evidenceUrl?.trim());
  const closed = ['verified', 'wont_fix', 'duplicate'].includes(report.status);

  return (
    <div className="px-4 py-2.5 transition-colors hover:bg-ink-800/30">
      <div className="flex items-start gap-2.5">
        <Badge tone={SEV_TONE[report.severity]} mono>{report.severity}</Badge>
        <div className="min-w-0 flex-1">
          <button onClick={() => setOpen((v) => !v)} className="block w-full text-left">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[9px] text-mist-500">{report.project.key}</span>
              <p className="text-[11.5px] font-medium text-mist-200">{report.title}</p>
              {report.overdue && <Badge tone="amber"><Icons.Clock size={8} /> 12h missed</Badge>}
            </div>
            <p className="mt-0.5 truncate text-[10px] text-mist-500">
              {report.reproduction || 'No reproduction steps recorded.'}
            </p>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px] text-mist-500">
            <Badge tone="outline">{report.kind}</Badge>
            <span>reported {relTime(report.submittedAt)} by {report.reporter ?? 'QA'}</span>
            {report.dueAt && <span>· due {shortDate(report.dueAt)}</span>}
            {report.assignee && <span>· {report.assignee.split(' ')[0]}</span>}
            {hasEvidence
              ? <span className="flex items-center gap-0.5 text-sky-400"><Icons.Paperclip size={8} /> evidence attached</span>
              : <span className="text-mist-500/70">no evidence</span>}
            <button
              onClick={() => setOpen((v) => !v)}
              className="ml-1 rounded px-1 text-[9.5px] text-mist-500 underline-offset-2 hover:text-gold-300 hover:underline"
            >
              {open ? 'hide detail' : 'detail & evidence'}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge tone={STATUS_TONE[report.status] ?? 'neutral'}>{report.status.replace('_', ' ')}</Badge>
          {!closed && (
            <>
              {report.status === 'open' && (
                <Button size="xs" variant="ghost" disabled={pending} onClick={() => onUpdate({ status: 'triaged' })}>
                  Triage
                </Button>
              )}
              {(report.status === 'open' || report.status === 'triaged' || report.status === 'in_progress') && (
                <Button size="xs" variant="secondary" disabled={pending} onClick={() => onUpdate({ status: 'fixed' })}>
                  Mark fixed
                </Button>
              )}
              {report.status === 'fixed' && (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={pending || !hasEvidence}
                  title={hasEvidence ? 'Verify against the attached evidence' : 'Attach evidence first — verification without proof is not verification'}
                  onClick={() => onUpdate({ status: 'verified' })}
                >
                  Verify
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {report.status === 'fixed' && !hasEvidence && (
        <p className="mt-1.5 rounded border border-amber-500/25 bg-amber-500/[0.06] px-2 py-1 text-[10px] leading-relaxed text-amber-300/90">
          Verification is blocked: this report has no evidence. Attach a test run, screenshot or PR link below —
          that is what “verified” will mean when the ship gate reads it.
        </p>
      )}

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-ink-700 bg-ink-850/50 p-2.5">
          <div>
            <p className="text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">Reproduction</p>
            <p className="mt-0.5 whitespace-pre-wrap text-[10.5px] leading-relaxed text-mist-300">
              {report.reproduction || 'Not recorded. A report without a reproduction is a rumour.'}
            </p>
          </div>
          <Field
            label="Evidence"
            hint="A URL to the failing test run, the screenshot, the PR or the deploy. Required before verification."
          >
            {({ id }) => (
              <div className="flex gap-1.5">
                <Input
                  id={id}
                  value={evidence}
                  placeholder="https://…"
                  onChange={(e) => setEvidence(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={evidence.trim() === (report.evidenceUrl ?? '')}
                  onClick={() => void saveEvidence()}
                >
                  Save
                </Button>
              </div>
            )}
          </Field>
          {report.evidenceUrl && (
            <a
              href={report.evidenceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-sky-400 hover:underline"
            >
              <Icons.ExternalLink size={9} /> open the attached evidence
            </a>
          )}
          {error !== null && <ApiFailure error={error} what="Could not save that evidence." />}
        </div>
      )}
    </div>
  );
}

export default function QACentre() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'open' | 'verified'>('all');
  const [showNew, setShowNew] = useState(false);
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const meta = metaQuery.data;
  const qa = useQuery({ queryKey: ['qa'], queryFn: () => api.qa() });
  const q = useQueryState(qa);

  const updateError = useMutationFailure();
  const update = useMutation({
    onMutate: () => updateError.clear(),
    onError: (e: unknown) => updateError.set(e),
    mutationFn: (vars: { id: string; patch: Record<string, unknown> }) => api.updateQA(vars.id, vars.patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['qa'] }); qc.invalidateQueries({ queryKey: ['clocks'] }); },
  });

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the QA register" retry={q.refetch} />;
  if (q.state !== 'ready') return <div className="p-5"><Skeleton className="h-8 w-52" /><Skeleton className="mt-4 h-72" /></div>;

  const data = q.data;
  const filtered = data.filter((row) =>
    status === 'all' ? true : status === 'open' ? !['verified', 'wont_fix', 'duplicate'].includes(row.status) : row.status === 'verified',
  );
  const overdue = data.filter((row) => row.overdue);
  const openP0 = data.filter((row) => ['p0', 'p1'].includes(row.severity) && !['verified', 'wont_fix', 'duplicate'].includes(row.status));

  return (
    <div className="pb-8">
      {updateError.error !== null && (
        <div className="px-5 pt-3">
          <MutationFailure error={updateError.error} what="Updating that report" onDismiss={updateError.clear} />
        </div>
      )}

      <PageHeader
        eyebrow={<><Icons.ShieldCheck size={11} /> Quality engineering</>}
        title="QA Centre"
        subtitle="Every QA pass produces a bug or testing report within 12 hours. Reports are severity-ranked, evidence-linked and tracked until verified — a fix without verification is not a fix."
        right={
          <>
            <Segmented value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'verified', label: 'Verified' }]} />
            <Button
              variant="primary"
              size="md"
              icon="Plus"
              disabled={!meta || meta.projects.length === 0}
              title={meta && meta.projects.length === 0 ? 'A report belongs to a project — create one first.' : undefined}
              onClick={() => setShowNew(true)}
            >
              New report
            </Button>
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

      {data.length === 0 && (
        <div className="px-5 pt-4">
          <Card className="p-6">
            <div className="mx-auto max-w-[52ch] text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl border border-gold-600/30 bg-gold-500/[0.08] text-gold-300">
                <Icons.ShieldCheck size={18} />
              </span>
              {meta && meta.projects.length === 0 ? (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">A QA report belongs to a project</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Create a project first. Reports are ranked per project, and the ship gate counts the
                    open P0s of the project it is releasing.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">No QA reports yet</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Filing one starts a 12-hour turnover clock. It then moves reported → triaged → fixed →
                    verified, and only a verified report stops blocking a release.
                  </p>
                  <Button
                    variant="primary"
                    className="mt-4"
                    icon="Plus"
                    disabled={!meta || meta.projects.length === 0}
                    onClick={() => setShowNew(true)}
                  >
                    File the first report
                  </Button>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      <div className="px-5 pt-3">
        <Card className="overflow-hidden">
          <div className="divide-y divide-ink-700/50">
            {filtered.map((row) => (
              <ReportRow
                key={row.id}
                report={row}
                pending={update.isPending}
                onUpdate={(patch) => {
                  if (Object.keys(patch).length === 0) {
                    qc.invalidateQueries({ queryKey: ['qa'] });
                    return;
                  }
                  update.mutate({ id: row.id, patch });
                }}
              />
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
              ['12-hour report turnover', 'A report lands within 12 hours of the QA pass. The clock starts on submission and is audited against the record.'],
              ['Per-module and per-milestone', 'Both module turnover (24h) and milestone turnover (7d) require recorded test evidence, not a verbal OK.'],
              ['Verification is a cross-check', 'Reported → triaged → fixed → verified. “Verified” needs the report to be fixed first and to carry evidence — a test run, a screenshot, a PR or a deploy link. The server refuses it otherwise, so the ship gate never trusts a self-certified fix.'],
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
  /*
   * A rejected submission used to leave the dialog exactly as it was: the button
   * stopped spinning and nothing else changed, so the reader assumed a slow
   * network and pressed it again. The reason is now shown inside the dialog,
   * where the fix (a missing field, a bad project id) is actionable.
   */

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
          {create.error && <div className="pb-2"><MutationFailure error={create.error} what="Submitting that report" /></div>}
          <Button variant="primary" disabled={form.title.length < 4 || create.isPending} loading={create.isPending} onClick={() => create.mutate()}>Submit report</Button>
        </div>
      </div>
    </div>
  );
}
