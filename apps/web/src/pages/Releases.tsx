/** Releases — demo → approval → ship, with the exec-summary clock enforced. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { daysBetween, dateTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import { Badge, Card, Progress, SectionHeader, Skeleton } from '../components/ui';

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

export default function Releases() {
  const releases = useQuery({ queryKey: ['releases'], queryFn: api.releases });
  const q = useQueryState(releases);

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
        right={<Badge tone="outline">{upcoming.length} in flight · {shipped.length} shipped</Badge>}
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
              </Card>
            );
          })}
          {upcoming.length === 0 && <p className="py-10 text-center text-[11.5px] text-mist-500">No releases in flight.</p>}
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
    </div>
  );
}
