/**
 * Clients — relationship health, revenue and the consultation history.
 *
 * Each card is now the record, not a picture of one. Health, tier, the primary
 * contact, the MRR and the notes are editable in place, and deleting a client is
 * offered honestly: the server refuses while the client still owns projects or
 * partner records, and the refusal is shown verbatim rather than pre-empted in the
 * UI, because the UI's idea of "owns work" can only ever be a second opinion.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { inr } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import {
  Badge, Button, Card, Field, HEALTH_TONE, Input, Modal, Progress, SectionHeader, Select, Skeleton, Textarea,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';
import type { ClientSummary } from '../types';

const TIERS = ['strategic', 'enterprise', 'growth', 'starter'] as const;
const HEALTHS = ['healthy', 'watch', 'at_risk', 'churn'] as const;

/** The editable fields of a client, as the form holds them. */
type ClientDraft = {
  id: string;
  name: string;
  industry: string;
  initials: string;
  tier: string;
  health: string;
  contactName: string;
  contactEmail: string;
  contactRole: string;
  notes: string;
  /** Rupees in the form, paise in the API — converted on both sides, once. */
  mrrRupees: string;
};

const draftOf = (c: ClientSummary): ClientDraft => ({
  id: c.id,
  name: c.name,
  industry: c.industry ?? '',
  initials: c.initials ?? '',
  tier: c.tier,
  health: c.health,
  contactName: c.contactName ?? '',
  contactEmail: c.contactEmail ?? '',
  contactRole: c.contactRole ?? '',
  notes: c.notes ?? '',
  mrrRupees: String(Math.round(c.mrrCents / 100)),
});

export default function Clients() {
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: api.clients });
  const pipelineQuery = useQuery({ queryKey: ['pipeline'], queryFn: api.pipeline });
  const q = useQueryState(clients);
  const [editing, setEditing] = useState<ClientDraft | null>(null);
  const [deleting, setDeleting] = useState<ClientSummary | null>(null);

  /*
   * Every write invalidates rather than patching the cache in place. `projectCount`
   * and the pipeline totals on this screen are computed by the server from other
   * tables, so a locally patched row would be a card whose headline number is a
   * guess. One invalidation re-reads the truth, and the dashboard that summarises
   * the same clients is refreshed with it.
   */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['clients'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['pipeline'] });
  };

  const save = useMutation({
    mutationFn: (d: ClientDraft) =>
      api.updateClient(d.id, {
        name: d.name.trim(),
        industry: d.industry.trim(),
        initials: d.initials.trim(),
        tier: d.tier,
        health: d.health,
        primaryContactName: d.contactName.trim(),
        primaryContactEmail: d.contactEmail.trim(),
        primaryContactRole: d.contactRole.trim(),
        notes: d.notes,
        mrrCents: Math.max(0, Math.round((Number(d.mrrRupees) || 0) * 100)),
      }),
    onSuccess: () => { refresh(); setEditing(null); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteClient(id),
    onSuccess: () => { refresh(); setDeleting(null); },
  });

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the client list" retry={q.refetch} />;
  if (q.state !== 'ready') return <div className="p-5"><Skeleton className="h-8 w-40" /><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div></div>;

  const data = q.data;
  const pipeline = pipelineQuery.data;

  const totalMrr = data.reduce((a, c) => a + c.mrrCents, 0);
  const atRisk = data.filter((c) => c.health === 'at_risk' || c.health === 'churn');

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.Building2 size={11} /> Client relationships</>}
        title="Clients"
        subtitle="Health is computed, not declared: turnover performance, blocked work, payment cadence and executive engagement. A client that needs attention shows up here before they tell you."
        right={
          <>
            <Badge tone="mint" dot>{inr(totalMrr, { compact: true })} MRR</Badge>
            {atRisk.length > 0 && <Badge tone="rose">{atRisk.length} need attention</Badge>}
          </>
        }
      />

      <div className="grid gap-3 px-5 pt-4 md:grid-cols-2 xl:grid-cols-3">
        {data.map((c) => {
          const deals = (pipeline?.deals ?? []).filter((d) => d.clientId === c.id);
          const liveDeal = deals.find((d) => d.status === 'open');
          return (
            <Card key={c.id} hover className="p-4">
              <div className="flex items-start gap-2.5">
                <span
                  className="grid size-9 shrink-0 place-items-center rounded-lg text-[12px] font-semibold"
                  style={{ background: `${c.color}20`, color: c.color, boxShadow: `inset 0 0 0 1px ${c.color}38` }}
                >
                  {c.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[13px] font-semibold text-mist-100">{c.name}</p>
                    <Badge tone={HEALTH_TONE[c.health]} dot>{c.health.replace('_', ' ')}</Badge>
                  </div>
                  <p className="text-[10.5px] text-mist-500">{c.industry} · {c.tier}</p>
                  <p className="mt-1 truncate text-[10.5px] text-mist-400">
                    {c.contactName} <span className="text-mist-500">· {c.contactRole}</span>
                  </p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-ink-700/60 pt-2.5">
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-mist-500">MRR</p>
                  <p className="text-[11.5px] font-medium tabular text-mist-300">{inr(c.mrrCents, { compact: true })}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-mist-500">In pipe</p>
                  <p className="text-[11.5px] font-medium tabular text-mist-300">{inr(c.openValueCents, { compact: true })}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-mist-500">Projects</p>
                  <p className="text-[11.5px] font-medium tabular text-mist-300">{c.projectCount}</p>
                </div>
              </div>

              {liveDeal && (
                <div className="mt-2.5 rounded-lg border border-ink-700 bg-ink-850/60 px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="size-1 rounded-full" style={{ background: liveDeal.stageColor }} />
                    <span className="text-[9.5px] uppercase tracking-wider text-mist-500">{liveDeal.stageName}</span>
                    <span className="ml-auto text-[9.5px] tabular text-mist-500">{liveDeal.probability}%</span>
                  </div>
                  <p className="mt-0.5 truncate text-[10.5px] text-mist-300">{liveDeal.title}</p>
                  <Progress value={liveDeal.probability} tone="iris" height={2} className="mt-1" />
                </div>
              )}

              <div className="mt-2 flex items-center justify-between">
                <span className="text-[9.5px] text-mist-500">{deals.length} deals lifetime</span>
                <span className="flex items-center gap-1.5">
                  <button
                    onClick={() => { save.reset(); remove.reset(); setEditing(draftOf(c)); }}
                    className="rounded px-1 py-0.5 text-[9.5px] text-mist-500 transition-colors hover:bg-ink-700 hover:text-gold-300"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => { remove.reset(); setDeleting(c); }}
                    className="rounded px-1 py-0.5 text-[9.5px] text-mist-500 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    Delete
                  </button>
                  <span className="flex items-center gap-1 text-[9.5px] text-mist-500">
                    <Icons.Mail size={9} />{c.contactEmail || '—'}
                  </span>
                </span>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="px-5 pt-3">
        <Card className="p-4">
          <SectionHeader
            title="Relationship protocol"
            subtitle="How the delivery board expects us to run the relationship"
          />
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {[
              ['CTO / HoE relationship first', 'Every engagement pairs a delivery lead with the client’s technical owner. Commercial conversations never bypass them.'],
              ['One channel, one voice', 'Client communication runs through the PM and dev lead. The dedicated client channel is the system of record for decisions.'],
              ['Continuous passive feedback', 'Weekly demo, written summary, and a status page. Silence is treated as a risk signal, not as approval.'],
            ].map(([t, b]) => (
              <div key={t} className="rounded-lg border border-ink-700 bg-ink-850/50 p-2.5">
                <p className="text-[11px] font-medium text-mist-200">{t}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-mist-500">{b}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------------- edit sheet */}
      <Modal
        open={editing !== null}
        icon="Building2"
        title={editing ? `Edit ${editing.name || 'client'}` : 'Edit client'}
        subtitle="These fields drive the health badges, the pipeline columns and every report that names this client."
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={save.isPending}
              disabled={!editing?.name.trim()}
              onClick={() => editing && save.mutate(editing)}
            >
              Save client
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_90px] gap-3">
              <Field label="Name">
                {({ id }) => (
                  <Input id={id} autoFocus value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                )}
              </Field>
              <Field label="Initials" hint="2–3 characters">
                {({ id }) => (
                  <Input id={id} maxLength={3} value={editing.initials}
                    onChange={(e) => setEditing({ ...editing, initials: e.target.value.toUpperCase() })} />
                )}
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Tier">
                {({ id }) => (
                  <Select id={id} value={editing.tier} onChange={(e) => setEditing({ ...editing, tier: e.target.value })}>
                    {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Health">
                {({ id }) => (
                  <Select id={id} value={editing.health} onChange={(e) => setEditing({ ...editing, health: e.target.value })}>
                    {HEALTHS.map((h) => <option key={h} value={h}>{h.replace('_', ' ')}</option>)}
                  </Select>
                )}
              </Field>
            </div>

            <Field label="Industry">
              {({ id }) => (
                <Input id={id} value={editing.industry}
                  onChange={(e) => setEditing({ ...editing, industry: e.target.value })} />
              )}
            </Field>

            <div className="grid grid-cols-[1fr_1fr] gap-3">
              <Field label="Primary contact">
                {({ id }) => (
                  <Input id={id} value={editing.contactName} placeholder="Dana Whitfield"
                    onChange={(e) => setEditing({ ...editing, contactName: e.target.value })} />
                )}
              </Field>
              <Field label="Role">
                {({ id }) => (
                  <Input id={id} value={editing.contactRole} placeholder="VP Engineering"
                    onChange={(e) => setEditing({ ...editing, contactRole: e.target.value })} />
                )}
              </Field>
            </div>

            <Field label="Contact email" hint="Validated by the server — an invalid address is refused, not silently stored.">
              {({ id }) => (
                <Input id={id} type="email" value={editing.contactEmail} placeholder="dana@acme.io"
                  onChange={(e) => setEditing({ ...editing, contactEmail: e.target.value })} />
              )}
            </Field>

            <Field label="Monthly recurring revenue" hint="In rupees. Shown compacted as ₹L / ₹Cr on the card.">
              {({ id }) => (
                <Input id={id} type="number" min={0} value={editing.mrrRupees}
                  onChange={(e) => setEditing({ ...editing, mrrRupees: e.target.value })} />
              )}
            </Field>

            <Field label="Notes" hint="Private to the delivery team. Not shown to the client.">
              {({ id }) => (
                <Textarea id={id} rows={4} value={editing.notes}
                  placeholder="Renewal risk, escalation history, anything the next lead needs."
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
              )}
            </Field>

            {save.error ? <ApiFailure error={save.error} what="the client was not saved." /> : null}
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------- delete guard */}
      <Modal
        open={deleting !== null}
        icon="Ban"
        title={deleting ? `Delete ${deleting.name}?` : 'Delete client?'}
        subtitle="This cannot be undone. A client that still owns projects or partner records will be refused — the reason is shown here."
        width={470}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep client</Button>
            <Button
              variant="danger"
              icon="Ban"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              Delete client
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-[11.5px] leading-relaxed text-mist-400">
            Deleting removes the client record itself. Projects, tasks and documents are
            never deleted with it — if any exist, the request is refused and nothing changes.
          </p>
          {remove.error ? <ApiFailure error={remove.error} what="the client was not deleted." /> : null}
        </div>
      </Modal>
    </div>
  );
}
