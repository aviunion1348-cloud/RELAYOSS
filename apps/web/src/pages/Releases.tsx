/**
 * Releases — demo → approval → ship, with the exec-summary clock enforced.
 *
 * The screen could show a release and refuse to ship it; it could not create one and
 * could not remove a draft. On an empty workspace it therefore showed nothing at all
 * with no way to begin, which made the whole gate unreachable — the checks were real
 * and there was nothing to run them against.
 *
 * Every release on this page is now editable in the two ways that matter: advance it
 * along the lifecycle (forward only — the server refuses a rewind and this UI does not
 * offer one), and delete a draft. A shipped release stays, because it is the record of
 * what reached a customer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { daysBetween, dateTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import {
  Badge, Button, Card, Field, Input, Modal, Progress, SectionHeader, Select, Skeleton, Textarea,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';

const FLOW = ['planning', 'in_qa', 'demo_ready', 'demo_done', 'approved', 'shipped'];

/**
 * Ship gate panel.
 *
 * The checks come from `GET /api/releases/:id/gate` — the same function that
 * guards the ship transition. Nothing here is computed in the browser: if the
 * server would refuse the ship, this panel shows why, and if it would allow it,
 * this panel cannot invent a reason not to.
 */
function ShipGatePanel({ releaseId }: { releaseId: string }) {
  const [open, setOpen] = useState(false);
  const gate = useQuery({
    queryKey: ['release-gate', releaseId],
    queryFn: () => api.releaseGate(releaseId),
    enabled: open,
  });
  const gq = useQueryState(gate);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850 px-2 py-1 text-[10px] text-mist-300 transition hover:border-ink-500 hover:text-mist-100"
      >
        <Icons.ShieldCheck size={9} /> Check ship gate
      </button>
    );
  }

  /*
   * The gate panel is opened by a deliberate click, so its failure is the most
   * confusing one to leave as a bare skeleton: the reader asked a direct question
   * ("will this ship?") and got an animation. The compact failure keeps the
   * question visible and allows another attempt.
   */
  if (gq.state === 'failed') {
    return <div className="mt-2.5"><QueryFailure compact error={gq.error} what="the ship gate" retry={gq.refetch} /></div>;
  }
  if (gq.state !== 'ready') {
    return <div className="mt-2.5"><Skeleton className="h-16 w-full" /></div>;
  }

  const data = gq.data;
  const blocking = data.checks.filter((c) => !c.passed);
  return (
    <div className="mt-2.5 rounded-lg border border-ink-700 bg-ink-850/60 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10.5px] font-medium text-mist-200">
          <Icons.ShieldCheck size={10} className={data.shippable ? 'text-mint-400' : 'text-amber-400'} />
          {data.shippable ? 'All requirements met — this release may ship' : `${blocking.length} requirement${blocking.length === 1 ? '' : 's'} outstanding`}
        </p>
        <span className="text-[9px] uppercase tracking-wider text-mist-500">evaluated {dateTime(data.evaluatedAt)}</span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {data.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-1.5 text-[10px] leading-relaxed">
            <span className={cls('mt-0.5 grid size-3 shrink-0 place-items-center rounded-full', c.passed ? 'bg-mint-500/15 text-mint-400' : 'bg-amber-500/15 text-amber-400')}>
              {c.passed ? <Icons.Check size={7} /> : <Icons.AlertTriangle size={7} />}
            </span>
            <span className="text-mist-400">
              <span className="text-mist-200">{c.label}</span> — {c.detail}
            </span>
          </li>
        ))}
      </ul>
      {!data.shippable && (
        <p className="mt-1.5 text-[9.5px] leading-relaxed text-mist-500">
          Shipping is refused by the server until these are resolved. The refusal is recorded on the release.
        </p>
      )}
    </div>
  );
}

/**
 * What can be done to one release, on the card itself.
 *
 * Advancing is a single explicit action rather than a free-choice dropdown: the
 * lifecycle is forward-only, so offering every status would invite a selection the
 * server is guaranteed to refuse. The button names the next step ("Mark demo done"),
 * and when the server refuses — a demo that was never scheduled, an exec summary that
 * is not 48 hours old — the refusal is printed here verbatim.
 */
function ReleaseActions({ release, onDelete }: {
  release: { id: string; status: string; version: string };
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [demoAt, setDemoAt] = useState('');
  const [shipAt, setShipAt] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const advance = useMutation({
    mutationFn: (next: string) => api.updateRelease(release.id, { status: next }),
    onSuccess: (_data, next) => {
      setFeedback(`Moved to ${String(next).replace('_', ' ')}.`);
      void qc.invalidateQueries({ queryKey: ['releases'] });
      void qc.invalidateQueries({ queryKey: ['release-gate', release.id] });
    },
  });

  const schedule = useMutation({
    mutationFn: () => api.updateRelease(release.id, {
      ...(demoAt ? { demoAt: new Date(demoAt).toISOString() } : {}),
      ...(shipAt ? { shipPlannedAt: new Date(shipAt).toISOString() } : {}),
    }),
    onSuccess: () => {
      setScheduleOpen(false);
      setFeedback('Dates saved.');
      void qc.invalidateQueries({ queryKey: ['releases'] });
    },
  });

  const next = FLOW[FLOW.indexOf(release.status) + 1];
  const label = (s: string) => s.replace(/_/g, ' ');

  return (
    <div className="mt-2.5 border-t border-ink-700/60 pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {next && (
          <Button size="sm" variant="primary" icon="ArrowRight" loading={advance.isPending}
            onClick={() => { setFeedback(null); advance.mutate(next); }}>
            Mark {label(next)}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon="Calendar" onClick={() => { setScheduleOpen(true); schedule.reset(); }}>
          Schedule demo &amp; ship
        </Button>
        {release.status !== 'shipped' && (
          <Button size="sm" variant="ghost" icon="Ban" onClick={onDelete} className="text-rose-300 hover:text-rose-200">
            Delete
          </Button>
        )}
        <span className="ml-auto text-[9.5px] text-mist-500">forward-only lifecycle</span>
      </div>

      {(advance.isError || schedule.isError) && (
        <div className="mt-2">
          <ApiFailure
            error={advance.error ?? schedule.error}
            what={`The server refused that change to ${release.version}.`}
          />
        </div>
      )}
      {feedback && !advance.isError && !schedule.isError && (
        <p className="mt-1.5 text-[10px] text-mint-400">{feedback}</p>
      )}

      <Modal
        open={scheduleOpen}
        icon="Calendar"
        title={`Schedule ${release.version}`}
        subtitle="A demo must be scheduled before it can be marked done, and the ship date is what the 48-hour exec-summary rule measures against."
        onClose={() => setScheduleOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="Check" loading={schedule.isPending}
              disabled={!demoAt && !shipAt} onClick={() => schedule.mutate()}>
              Save dates
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Demo date" hint="The client walkthrough.">
            {({ id }) => <Input id={id} type="date" value={demoAt} onChange={(e) => setDemoAt(e.target.value)} />}
          </Field>
          <Field label="Planned ship date" hint="Exec summary must exist 48h before this.">
            {({ id }) => <Input id={id} type="date" value={shipAt} onChange={(e) => setShipAt(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </div>
  );
}

type ReleaseDraft = {
  projectId: string; version: string; name: string; branch: string;
  deployTarget: string; demoAt: string; shipPlannedAt: string; rollbackPlan: string;
};

const emptyRelease = (projectId: string): ReleaseDraft => ({
  projectId, version: '', name: '', branch: 'main', deployTarget: '',
  demoAt: '', shipPlannedAt: '', rollbackPlan: '',
});

export default function Releases() {
  const qc = useQueryClient();
  const releases = useQuery({ queryKey: ['releases'], queryFn: api.releases });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const q = useQueryState(releases);
  const [draft, setDraft] = useState<ReleaseDraft | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; version: string } | null>(null);
  const projects = projectsQuery.data ?? [];

  const create = useMutation({
    mutationFn: (d: ReleaseDraft) => api.createRelease({
      projectId: d.projectId,
      version: d.version.trim(),
      name: d.name.trim(),
      branch: d.branch.trim() || 'main',
      deployTarget: d.deployTarget.trim(),
      demoAt: d.demoAt ? new Date(d.demoAt).toISOString() : null,
      shipPlannedAt: d.shipPlannedAt ? new Date(d.shipPlannedAt).toISOString() : null,
      rollbackPlan: d.rollbackPlan,
    }),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['releases'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRelease(id),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['releases'] });
    },
  });

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the release calendar" retry={q.refetch} />;
  if (q.state !== 'ready') return <div className="p-5"><Skeleton className="h-8 w-48" /><Skeleton className="mt-4 h-64" /></div>;

  const data = q.data;

  const upcoming = data.filter((r) => r.status !== 'shipped');
  const shipped = data.filter((r) => r.status === 'shipped');

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.Rocket size={11} /> Release management</>}
        title="Releases"
        subtitle="Demo within two weeks of kickoff, ship within five days of approval, and the executive summary published at least 48 hours before the proposed ship date. These are clocks, not aspirations."
        right={
          <>
            <Badge tone="outline">{upcoming.length} in flight · {shipped.length} shipped</Badge>
            <Button
              variant="primary"
              size="sm"
              icon="Plus"
              disabled={projects.length === 0}
              onClick={() => { create.reset(); setDraft(emptyRelease(projects[0]?.id ?? '')); }}
            >
              New release
            </Button>
          </>
        }
      />

      <div className="px-5 pt-4">
        <div className="space-y-2.5">
          {upcoming.map((r) => {
            const stepIdx = FLOW.indexOf(r.status);
            const demoDays = r.demoAt ? daysBetween(r.demoAt) : null;
            const shipDays = r.shipPlannedAt ? daysBetween(r.shipPlannedAt) : null;
            const summaryMissing = !r.execSummaryUrl;
            return (
              <Card key={r.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-sm" style={{ background: r.clientColor }} />
                      <span className="text-[10px] text-mist-500">{r.clientName}</span>
                      <span className="font-mono text-[10px] text-mist-400">{r.version}</span>
                      <Badge tone={r.status === 'demo_ready' ? 'amber' : 'neutral'}>{r.status.replace('_', ' ')}</Badge>
                      {summaryMissing && (r.status === 'demo_ready' || r.status === 'demo_done') && (
                        <Badge tone="rose"><Icons.FileWarning size={8} /> exec summary missing</Badge>
                      )}
                    </div>
                    <h3 className="mt-1 text-[13.5px] font-semibold text-mist-100">{r.name} — {r.project.name}</h3>
                    <p className="mt-0.5 flex items-center gap-2 text-[10px] text-mist-500">
                      <Icons.GitBranch size={9} /><span className="font-mono">{r.branch}</span>
                      <span>·</span>
                      <Icons.Cloud size={9} />{r.deployTarget}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    {demoDays !== null && (
                      <div className="text-right">
                        <p className="text-[9px] uppercase tracking-wider text-mist-500">Demo</p>
                        <p className={cls('text-[12px] font-medium tabular', demoDays < 0 ? 'text-mist-500' : demoDays <= 14 ? 'text-mint-400' : 'text-amber-400')}>
                          {shortDate(r.demoAt)}
                        </p>
                      </div>
                    )}
                    {shipDays !== null && (
                      <div className="text-right">
                        <p className="text-[9px] uppercase tracking-wider text-mist-500">Ship</p>
                        <p className={cls('text-[12px] font-medium tabular', shipDays < 0 ? 'text-mist-500' : shipDays <= 5 ? 'text-mint-400' : 'text-amber-400')}>
                          {shortDate(r.shipPlannedAt)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* progress rail */}
                <div className="mt-3 flex items-center gap-1">
                  {FLOW.map((f, i) => (
                    <div key={f} className="flex flex-1 items-center gap-1">
                      <div className={cls('h-1 flex-1 rounded-full', i <= stepIdx ? 'bg-iris-500' : 'bg-ink-700')} />
                      <span className={cls('shrink-0 text-[8.5px] uppercase tracking-wide', i <= stepIdx ? 'text-iris-300' : 'text-mist-500/60')}>
                        {f.replace('_', ' ')}
                      </span>
                    </div>
                  ))}
                </div>

                {r.demoFeedback && (
                  <p className="mt-2.5 rounded-lg border border-ink-700 bg-ink-850/60 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-mist-400">
                    <Icons.MessageSquare size={9} className="mr-1 inline text-mist-500" />{r.demoFeedback}
                  </p>
                )}
                {r.rollbackPlan && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-mist-500">
                    <Icons.Undo2 size={9} className="mr-1 inline" />Rollback: {r.rollbackPlan}
                  </p>
                )}
                <ShipGatePanel releaseId={r.id} />
                <ReleaseActions release={r} onDelete={() => { remove.reset(); setDeleting({ id: r.id, version: r.version }); }} />
              </Card>
            );
          })}
          {upcoming.length === 0 && (
            <Card className="p-6">
              <div className="mx-auto max-w-[48ch] text-center">
                <span className="mx-auto grid size-11 place-items-center rounded-xl border border-gold-600/30 bg-gold-500/[0.08] text-gold-300">
                  <Icons.Rocket size={18} />
                </span>
                {projects.length === 0 ? (
                  <>
                    <p className="mt-3 text-[14px] font-semibold text-white">A release belongs to a project</p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                      Create a project first — the demo, the ship date and the gate are all tracked per
                      project. Then come back and cut the first release.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-3 text-[14px] font-semibold text-white">No releases yet</p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                      A release starts at planning. Schedule the demo and the ship date, then move it
                      along — the gate refuses to ship until the evidence is there.
                    </p>
                    <Button
                      variant="primary"
                      className="mt-4"
                      icon="Plus"
                      onClick={() => { create.reset(); setDraft(emptyRelease(projects[0]?.id ?? '')); }}
                    >
                      Cut your first release
                    </Button>
                  </>
                )}
              </div>
            </Card>
          )}
        </div>

        <Card className="mt-3 overflow-hidden">
          <div className="border-b border-ink-700/70 px-4 py-3">
            <SectionHeader title="Shipped" subtitle="Audit trail of what went to production" />
          </div>
          <table className="w-full text-left">
            <thead className="bg-ink-850/60">
              <tr className="text-[9px] uppercase tracking-[0.1em] text-mist-500">
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Shipped</th>
                <th className="px-4 py-2 font-medium">Chain</th>
                <th className="px-4 py-2 font-medium">Exec summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/50">
              {shipped.map((r) => (
                <tr key={r.id} className="hover:bg-ink-800/40">
                  <td className="px-4 py-2 font-mono text-[10.5px] text-mist-300">{r.version}</td>
                  <td className="px-4 py-2 text-[11px] text-mist-400">{r.project.name}</td>
                  <td className="px-4 py-2 text-[10.5px] tabular text-mist-400">{dateTime(r.shippedAt)}</td>
                  <td className="px-4 py-2 text-[10px] text-mist-500">approved {shortDate(r.demoApprovedAt)} → shipped {shortDate(r.shippedAt)}</td>
                  <td className="px-4 py-2">
                    {r.execSummaryUrl
                      ? <span className="flex items-center gap-1 text-[10px] text-mint-400"><Icons.Check size={9} /> published</span>
                      : <span className="text-[10px] text-rose-400">missing</span>}
                  </td>
                </tr>
              ))}
              {shipped.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-[11px] text-mist-500">No shipped releases yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card className="mt-3 p-4">
          <SectionHeader
            title="Release gate"
            subtitle="Evaluated server-side — this is the same check that refuses the ship transition"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {['3,500 edge cases catalogued', '90% verified', 'No open P0/P1', 'Exec summary ≥ 48h ahead', 'Turnover gates with evidence', 'Demo or client acceptance'].map((s, i) => (
              <span key={s} className="flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850 px-2 py-1 text-[10.5px] text-mist-300">
                <span className="grid size-3.5 place-items-center rounded-full bg-iris-500/15 text-[8px] font-semibold text-iris-300">{i + 1}</span>
                {s}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-mist-500">
            A release cannot be marked shipped while any check is outstanding, and it also needs a deployment acknowledgement and a
            post-ship verification with a source. A pipeline exiting zero is not delivery.
          </p>
        </Card>
      </div>

      {/* ------------------------------------------------------- create sheet */}
      <Modal
        open={draft !== null}
        icon="Rocket"
        title="New release"
        subtitle="It starts at planning — the lifecycle only moves forward, so nothing is created already-shipped."
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={create.isPending}
              disabled={!draft?.version.trim() || !draft?.name.trim() || !draft?.projectId}
              onClick={() => draft && create.mutate(draft)}
            >
              Create release
            </Button>
          </>
        }
      >
        {create.isError && (
          <div className="mb-3"><ApiFailure error={create.error} what="Could not create this release." /></div>
        )}
        {draft && (
          <div className="space-y-3">
            <Field label="Project">
              {({ id }) => (
                <Select id={id} value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-[110px_1fr] gap-3">
              <Field label="Version" hint="per project">
                {({ id }) => (
                  <Input id={id} autoFocus value={draft.version} placeholder="v1.0" maxLength={40}
                    onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
                )}
              </Field>
              <Field label="Name">
                {({ id }) => (
                  <Input id={id} value={draft.name} placeholder="First client demo"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Branch">
                {({ id }) => (
                  <Input id={id} value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} />
                )}
              </Field>
              <Field label="Deploy target">
                {({ id }) => (
                  <Input id={id} value={draft.deployTarget} placeholder="AWS · ap-south-1"
                    onChange={(e) => setDraft({ ...draft, deployTarget: e.target.value })} />
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Demo date" hint="Optional now — required before 'demo done'.">
                {({ id }) => (
                  <Input id={id} type="date" value={draft.demoAt}
                    onChange={(e) => setDraft({ ...draft, demoAt: e.target.value })} />
                )}
              </Field>
              <Field label="Planned ship" hint="Exec summary 48h ahead of this.">
                {({ id }) => (
                  <Input id={id} type="date" value={draft.shipPlannedAt}
                    onChange={(e) => setDraft({ ...draft, shipPlannedAt: e.target.value })} />
                )}
              </Field>
            </div>
            <Field label="Rollback plan" hint="What happens if this goes wrong in production.">
              {({ id }) => (
                <Textarea id={id} rows={2} value={draft.rollbackPlan}
                  onChange={(e) => setDraft({ ...draft, rollbackPlan: e.target.value })} />
              )}
            </Field>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------- delete sheet */}
      <Modal
        open={deleting !== null}
        icon="Ban"
        title={`Delete ${deleting?.version ?? 'release'}?`}
        subtitle="Only a release that has not shipped can be deleted. Its gate acknowledgements go with it; a shipped release stays as the record of what reached the customer."
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep it</Button>
            <Button
              variant="danger"
              icon="Ban"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              Delete release
            </Button>
          </>
        }
      >
        {remove.isError && <ApiFailure error={remove.error} what="The server refused this deletion." />}
        {!remove.isError && (
          <p className="text-[12px] leading-relaxed text-mist-400">
            This removes the release record. Any acknowledgements recorded against it are removed too —
            the database cascades them, there is no orphaned evidence left behind.
          </p>
        )}
      </Modal>
    </div>
  );
}
