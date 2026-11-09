/**
 * Projects — the portfolio, and where a project is created.
 *
 * There was no way to add one. The screen listed what existed, linked into detail and
 * said nothing about the case this product is set up for: a fresh workspace with no
 * projects at all and no client to hang one from. Creation is here now, and it is
 * honest about its two dependencies — a name, and a client that exists.
 */
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { inr, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import {
  Avatar, Badge, Button, Card, Field, HEALTH_TONE, Input, Modal, Progress, SectionHeader, Select, Skeleton, Textarea,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';

type ProjectDraft = {
  name: string;
  key: string;
  clientId: string;
  description: string;
  status: string;
  health: string;
  targetEndAt: string;
  budgetRupees: string;
  hoursBudget: string;
};

const emptyProject = (clientId: string): ProjectDraft => ({
  name: '', key: '', clientId, description: '', status: 'active', health: 'on_track',
  targetEndAt: '', budgetRupees: '', hoursBudget: '',
});

export default function Projects() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const releasesQuery = useQuery({ queryKey: ['releases'], queryFn: api.releases });
  const clientsQuery = useQuery({ queryKey: ['clients'], queryFn: api.clients });
  const q = useQueryState(projects);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);

  const create = useMutation({
    mutationFn: (d: ProjectDraft) =>
      api.createProject({
        name: d.name.trim(),
        ...(d.key.trim() ? { key: d.key.trim().toUpperCase() } : {}),
        clientId: d.clientId,
        description: d.description.trim(),
        status: d.status,
        health: d.health,
        targetEndAt: d.targetEndAt ? new Date(d.targetEndAt).toISOString() : null,
        budgetCents: Math.max(0, Math.round((Number(d.budgetRupees) || 0) * 100)),
        hoursBudget: Math.max(0, Number(d.hoursBudget) || 0),
      }),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const clients = clientsQuery.data ?? [];

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the project portfolio" retry={q.refetch} />;
  if (q.state !== 'ready') {
    return <div className="p-5"><Skeleton className="h-8 w-48" /><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-52" />)}</div></div>;
  }

  const data = q.data;
  const releases = releasesQuery.data;

  const totalBudget = data.reduce((a, p) => a + p.budgetCents, 0);
  const totalLogged = data.reduce((a, p) => a + p.loggedHours, 0);
  const atRisk = data.filter((p) => p.health === 'at_risk' || p.health === 'critical').length;

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.FolderKanban size={11} /> Portfolio</>}
        title="Live projects"
        subtitle="Each project owns a board, a phase spine and its own turnover contract. Open one to see the ship gate: edge-case coverage, open P0s, executive summary and client acceptance."
        right={
          <>
            <Badge tone="outline">{data.length} active</Badge>
            {atRisk > 0 && <Badge tone="rose" dot>{atRisk} at risk</Badge>}
            <Badge tone="outline">{inr(totalBudget, { compact: true })} contracted · {Math.round(totalLogged)}h logged</Badge>
            <Button
              variant="primary"
              size="sm"
              icon="Plus"
              disabled={clients.length === 0}
              onClick={() => { create.reset(); setDraft(emptyProject(clients[0]?.id ?? '')); }}
            >
              New project
            </Button>
          </>
        }
      />

      <div className="grid gap-3 px-5 pt-4 md:grid-cols-2 xl:grid-cols-3">
        {data.map((p) => {
          const projectReleases = (releases ?? []).filter((r) => r.project.id === p.id);
          const nextRelease = projectReleases.find((r) => r.status !== 'shipped');
          return (
            <Link key={p.id} to={`/projects/${p.id}`} className="surface surface-hover group rounded-xl p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-sm" style={{ background: p.clientColor }} />
                    <span className="font-mono text-[9.5px] uppercase tracking-wider text-mist-500">{p.key}</span>
                    <span className="text-[9.5px] text-mist-500">· {p.clientName}</span>
                  </div>
                  <h3 className="mt-1 truncate text-[13.5px] font-semibold text-mist-100 group-hover:text-white">{p.name}</h3>
                  <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-mist-500">{p.description}</p>
                </div>
                <Badge tone={HEALTH_TONE[p.health] ?? 'neutral'} dot className="shrink-0">{p.health.replace('_', ' ')}</Badge>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <Progress value={p.progress} tone={p.health === 'at_risk' || p.health === 'critical' ? 'rose' : p.health === 'watch' ? 'amber' : 'iris'} height={4} />
                <span className="shrink-0 text-[10px] tabular text-mist-400">{p.progress}%</span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-ink-700/60 pt-2.5">
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-mist-500">Shipped</p>
                  <p className="text-[11.5px] font-medium tabular text-mist-300">{p.doneCount}/{p.taskCount}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-mist-500">Logged</p>
                  <p className="text-[11.5px] font-medium tabular text-mist-300">{Math.round(p.loggedHours)}h</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-mist-500">Budget</p>
                  <p className="text-[11.5px] font-medium tabular text-mist-300">{inr(p.budgetCents, { compact: true })}</p>
                </div>
              </div>

              <div className="mt-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[9.5px] text-mist-500">
                  <Icons.GitBranch size={9} />
                  <span className="truncate font-mono">{p.branch}</span>
                </div>
                {p.owner && <Avatar name={p.owner.name} initials={p.owner.initials} color={p.owner.color} size={18} />}
              </div>

              {nextRelease && (
                <div className={cls('mt-2.5 flex items-center justify-between rounded-lg border px-2 py-1.5',
                  nextRelease.status === 'demo_ready' ? 'border-amber-500/30 bg-amber-500/8' : 'border-ink-600 bg-ink-850/60')}>
                  <span className="flex items-center gap-1.5 text-[10px] text-mist-400">
                    <Icons.Rocket size={9} /> {nextRelease.version} · {nextRelease.status.replace('_', ' ')}
                  </span>
                  <span className="text-[9.5px] tabular text-mist-500">{nextRelease.shipPlannedAt ? shortDate(nextRelease.shipPlannedAt) : 'TBD'}</span>
                </div>
              )}
            </Link>
          );
        })}
      </div>

      {/*
        Two different empty states, because they need two different actions. With no
        clients the project button is disabled and the reason is on screen; with clients
        but no projects, the invitation is the button itself.
      */}
      {data.length === 0 && (
        <div className="px-5 pt-4">
          <Card className="p-6">
            <div className="mx-auto max-w-[48ch] text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl border border-gold-600/30 bg-gold-500/[0.08] text-gold-300">
                <Icons.FolderKanban size={18} />
              </span>
              {clients.length === 0 ? (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">A project needs a client first</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Every project belongs to a client — that is what ties the delivery work, the
                    invoices and the relationship together. Add a client, then come back here.
                  </p>
                  <Link to="/clients" className="mt-4 inline-flex">
                    <Button variant="primary" icon="Building2">Go to Clients</Button>
                  </Link>
                </>
              ) : (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">No live projects yet</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Creating one gives you a board, a phase spine, a ship gate and a release
                    timeline for {clients[0]?.name ?? 'your client'}. Nothing else is required.
                  </p>
                  <Button
                    variant="primary"
                    className="mt-4"
                    icon="Plus"
                    onClick={() => { create.reset(); setDraft(emptyProject(clients[0]?.id ?? '')); }}
                  >
                    Create a project
                  </Button>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      <div className="px-5 pt-4">
        <Card className="p-4">
          <SectionHeader title="Delivery standard" subtitle="Applied to every project on this page — enforced by the API, not by convention" />
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: 'GitBranch', title: 'Branch discipline', body: 'All work branches from lear-backend. The board shows the branch on every card; a card cannot ship from an unreviewed branch.' },
              { icon: 'TestTube', title: 'Tests before turnover', body: 'Module and milestone turnover require recorded test evidence. The gate refuses a pass without it.' },
              { icon: 'FileWarning', title: '3,500 edge cases', body: 'Ship gate requires the edge-case ledger at 3,500 catalogued and 90% verified per project.' },
              { icon: 'FileCheck2', title: 'Exec summary ≥ 2 days', body: 'The shipping summary must exist 48h before the proposed ship date — the clock enforces it.' },
            ].map((r) => {
              const Icon = Icons[r.icon as keyof typeof Icons] as React.ComponentType<{ size?: number; className?: string }>;
              return (
                <div key={r.title} className="rounded-lg border border-ink-700 bg-ink-850/50 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <Icon size={11} className="text-iris-300" />
                    <p className="text-[11px] font-medium text-mist-200">{r.title}</p>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-mist-500">{r.body}</p>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------- create sheet */}
      <Modal
        open={draft !== null}
        icon="FolderKanban"
        title="New project"
        subtitle="A name and a client are enough. The key is derived from the name unless you set one; it becomes the prefix on every task (NRTH-101)."
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={create.isPending}
              disabled={!draft?.name.trim() || !draft?.clientId}
              onClick={() => draft && create.mutate(draft)}
            >
              Create project
            </Button>
          </>
        }
      >
        {create.isError && (
          <div className="mb-3">
            <ApiFailure error={create.error} what="Could not create this project." />
          </div>
        )}
        {draft && (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_100px] gap-3">
              <Field label="Project name">
                {({ id }) => (
                  <Input id={id} autoFocus value={draft.name} placeholder="Northgate replatform"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                )}
              </Field>
              <Field label="Key" hint="2–5 chars">
                {({ id }) => (
                  <Input id={id} value={draft.key} placeholder="NRTH" maxLength={5}
                    onChange={(e) => setDraft({ ...draft, key: e.target.value.toUpperCase() })} />
                )}
              </Field>
            </div>

            <Field label="Client" hint={clients.length === 0 ? 'Add a client first — a project cannot exist without one.' : undefined}>
              {({ id }) => (
                <Select id={id} value={draft.clientId} onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </Field>

            <Field label="Description" hint="What is being delivered, in one or two sentences.">
              {({ id }) => (
                <Textarea id={id} rows={2} value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">
                {({ id }) => (
                  <Select id={id} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                    {['discovery', 'active', 'review', 'blocked', 'launched', 'archived'].map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Health">
                {({ id }) => (
                  <Select id={id} value={draft.health} onChange={(e) => setDraft({ ...draft, health: e.target.value })}>
                    {['on_track', 'watch', 'at_risk', 'critical'].map((v) => (
                      <option key={v} value={v}>{v.replace('_', ' ')}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Target end">
                {({ id }) => (
                  <Input id={id} type="date" value={draft.targetEndAt}
                    onChange={(e) => setDraft({ ...draft, targetEndAt: e.target.value })} />
                )}
              </Field>
              <Field label="Budget" hint="₹">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={draft.budgetRupees} placeholder="0"
                    onChange={(e) => setDraft({ ...draft, budgetRupees: e.target.value })} />
                )}
              </Field>
              <Field label="Hours">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={draft.hoursBudget} placeholder="0"
                    onChange={(e) => setDraft({ ...draft, hoursBudget: e.target.value })} />
                )}
              </Field>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
