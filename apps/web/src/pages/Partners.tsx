/**
 * Partner console — IAM, device licences, API quota and uptime per partner.
 *
 * The three limits on each card are the commercial contract, and they are now
 * editable here. That matters more than it sounds: the server enforces every one
 * of them on the next request, so changing a device ceiling in this sheet changes
 * what the partner can do immediately — no redeploy, no cache to clear.
 *
 * The form refuses to be the authority on what is allowed. A limit below current
 * usage is a real conflict, and the server answers 409 with the numbers; that
 * answer is rendered as-is rather than guessed at by the client.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import {
  Badge, Button, Card, Field, Input, Modal, Progress, Ring, SectionHeader, Select, Skeleton,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';
import type { Partner } from '../types';

const PLANS = ['starter', 'growth', 'enterprise'] as const;
const PARTNER_STATUS = ['active', 'trial', 'suspended'] as const;

type PartnerDraft = {
  id: string;
  /** Only used when creating: a partner is always engaged by a client, and that
   *  link is fixed afterwards (the server does not accept a change to it). */
  clientId: string;
  name: string;
  plan: string;
  status: string;
  consoleUrl: string;
  deviceLimit: string;
  seatLimit: string;
  apiQuota: string;
};

/** A blank partner, in the shape the sheet uses. */
const emptyPartner = (clientId: string): PartnerDraft => ({
  id: '',
  clientId,
  name: '',
  plan: 'growth',
  status: 'trial',
  consoleUrl: '',
  deviceLimit: '50',
  seatLimit: '10',
  apiQuota: '100000',
});

const draftOf = (p: Partner): PartnerDraft => ({
  id: p.id,
  clientId: '',
  name: p.name,
  plan: p.plan,
  status: p.status,
  consoleUrl: p.consoleUrl ?? '',
  deviceLimit: String(p.deviceLimit),
  seatLimit: String(p.seatLimit),
  apiQuota: String(p.apiQuota),
});

export default function Partners() {
  const qc = useQueryClient();
  const partners = useQuery({ queryKey: ['partners'], queryFn: api.partners });
  const clientsQuery = useQuery({ queryKey: ['clients'], queryFn: api.clients });
  const q = useQueryState(partners);
  const [editing, setEditing] = useState<PartnerDraft | null>(null);
  const [deleting, setDeleting] = useState<Partner | null>(null);
  const clients = clientsQuery.data ?? [];
  const creating = editing?.id === '';

  /*
   * A limit change has to re-read the list rather than patch the row: `usage`,
   * `devicesActive` and the percentages are computed server-side alongside the
   * limit, and a half-updated card would show a new ceiling against a stale graph.
   * The entitlements endpoint is what enforcement reads, so it is refreshed too.
   */
  const save = useMutation({
    mutationFn: (d: PartnerDraft) => {
      const limits = {
        name: d.name.trim(),
        plan: d.plan,
        status: d.status,
        consoleUrl: d.consoleUrl.trim(),
        deviceLimit: Number(d.deviceLimit),
        seatLimit: Number(d.seatLimit),
        apiQuotaMonth: Number(d.apiQuota),
      };
      return d.id
        ? api.updatePartner(d.id, limits)
        : api.createPartner({ ...limits, clientId: d.clientId });
    },
    onSuccess: (_saved, d) => {
      void qc.invalidateQueries({ queryKey: ['partners'] });
      if (d.id) void qc.invalidateQueries({ queryKey: ['partner-entitlements', d.id] });
      setEditing(null);
    },
  });

  /*
   * Removal is a real operation with a real refusal: the server declines while the
   * partner has an active device licence or an enabled seat, because cascading those
   * away would end access that someone is currently using. The refusal is shown
   * verbatim, with its counts, instead of being pre-empted by a guess here.
   */
  const remove = useMutation({
    mutationFn: (id: string) => api.deletePartner(id),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['partners'] });
    },
  });

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the partner consoles" retry={q.refetch} />;
  if (q.state !== 'ready') return <div className="p-5"><Skeleton className="h-8 w-48" /><div className="mt-4 grid gap-3 lg:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56" />)}</div></div>;

  const data = q.data;

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.KeyRound size={11} /> Partner operations</>}
        title="Partner console"
        subtitle="Each partner gets its own console: IAM users, device licences, API quota, usage metering and uptime. Limits are enforced at the edge — a partner cannot exceed contracted devices or seats."
        right={
          <>
            <Badge tone="outline">{data.length} partner consoles</Badge>
            <Button
              variant="primary"
              size="sm"
              icon="Plus"
              disabled={clients.length === 0}
              onClick={() => { save.reset(); remove.reset(); setEditing(emptyPartner(clients[0]?.id ?? '')); }}
            >
              New partner
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 px-5 pt-4 lg:grid-cols-4">
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Active devices</p>
          <p className="mt-1 text-[22px] font-semibold tabular text-white">{data.reduce((a, p) => a + p.devicesActive, 0)}</p>
          <p className="mt-0.5 text-[10px] text-mist-500">of {data.reduce((a, p) => a + p.deviceLimit, 0)} licensed</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">API calls · 30d</p>
          <p className="mt-1 text-[22px] font-semibold tabular text-white">{(data.reduce((a, p) => a + p.apiCalls, 0) / 1000).toFixed(0)}k</p>
          <p className="mt-0.5 text-[10px] text-mist-500">against {(data.reduce((a, p) => a + p.apiQuota, 0) / 1_000_000).toFixed(1)}M quota</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">Median uptime</p>
          <p className="mt-1 text-[22px] font-semibold tabular text-mint-400">
            {(data.reduce((a, p) => a + p.uptimePct, 0) / Math.max(1, data.length)).toFixed(2)}%
          </p>
          <p className="mt-0.5 text-[10px] text-mist-500">last 30 days</p>
        </Card>
        <Card className={cls('p-3.5', data.some((p) => p.mfaPct < 100) && 'border-amber-500/40')}>
          <p className="text-[10px] uppercase tracking-[0.1em] text-mist-500">IAM MFA coverage</p>
          <p className="mt-1 text-[22px] font-semibold tabular text-white">
            {Math.round(data.reduce((a, p) => a + p.mfaPct, 0) / Math.max(1, data.length))}%
          </p>
          <p className="mt-0.5 text-[10px] text-mist-500">invited users pending</p>
        </Card>
      </div>

      <div className="grid gap-3 px-5 pt-3 lg:grid-cols-2">
        {data.map((p) => {
          const quotaPct = Math.round((p.apiCalls / Math.max(1, p.apiQuota)) * 100);
          const devicePct = Math.round((p.devicesActive / Math.max(1, p.deviceLimit)) * 100);
          return (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-sm" style={{ background: p.clientColor }} />
                    <p className="truncate text-[13px] font-semibold text-mist-100">{p.name}</p>
                    <Badge tone={p.plan === 'enterprise' ? 'iris' : p.plan === 'growth' ? 'sky' : 'neutral'}>{p.plan}</Badge>
                    {p.status !== 'active' && <Badge tone="amber">{p.status}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[9.5px] text-mist-500">{p.consoleUrl || 'no console URL'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => { save.reset(); setEditing(draftOf(p)); }}
                    className="rounded-md border border-ink-600 px-1.5 py-0.5 text-[9.5px] text-mist-400 transition-colors hover:border-gold-600/50 hover:text-gold-300"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => { remove.reset(); setDeleting(p); }}
                    className="rounded-md border border-ink-600 px-1.5 py-0.5 text-[9.5px] text-mist-400 transition-colors hover:border-rose-500/50 hover:text-rose-300"
                  >
                    Delete
                  </button>
                </div>
                <Ring value={Math.round(p.uptimePct)} size={40} stroke={3} tone={p.uptimePct > 99.5 ? '#22c98a' : '#f5a524'} label={<span className="text-[8px]">{p.uptimePct.toFixed(1)}</span>} />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3">
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] uppercase tracking-wider text-mist-500">Devices</p>
                    <span className="text-[9px] tabular text-mist-400">{p.devicesActive}/{p.deviceLimit}</span>
                  </div>
                  <Progress value={devicePct} tone={devicePct > 90 ? 'amber' : 'iris'} height={3} className="mt-1" />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] uppercase tracking-wider text-mist-500">Seats</p>
                    <span className="text-[9px] tabular text-mist-400">{p.seats}/{p.seatLimit}</span>
                  </div>
                  <Progress value={(p.seats / Math.max(1, p.seatLimit)) * 100} tone="sky" height={3} className="mt-1" />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] uppercase tracking-wider text-mist-500">API</p>
                    <span className="text-[9px] tabular text-mist-400">{quotaPct}%</span>
                  </div>
                  <Progress value={quotaPct} tone={quotaPct > 80 ? 'amber' : 'mint'} height={3} className="mt-1" />
                </div>
              </div>

              <div className="mt-3 h-[74px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={p.usage} margin={{ top: 2, right: 0, left: -34, bottom: 0 }}>
                    <defs>
                      <linearGradient id={`gu-${p.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#d4a44c" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#d4a44c" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#221d17" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" hide />
                    <YAxis tick={{ fill: '#8a8378', fontSize: 8.5 }} axisLine={false} tickLine={false} width={34} />
                    <RTooltip contentStyle={{ background: '#0e0c0a', border: '1px solid #3a3128', borderRadius: 8, fontSize: 10.5 }} labelStyle={{ color: '#ded9d0' }} />
                    <Area type="monotone" dataKey="apiCalls" stroke="#d4a44c" strokeWidth={1.4} fill={`url(#gu-${p.id})`} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-2 flex items-center justify-between border-t border-ink-700/60 pt-2">
                <span className="flex items-center gap-1 text-[9.5px] text-mist-500">
                  <Icons.ShieldCheck size={9} className={p.mfaPct === 100 ? 'text-mint-400' : 'text-amber-400'} />
                  MFA {p.mfaPct}%
                </span>
                <span className="flex items-center gap-1 text-[9.5px] text-mist-500"><Icons.Users size={9} /> {p.seats} IAM users</span>
                <span className="flex items-center gap-1 text-[9.5px] text-mist-500"><Icons.Activity size={9} /> {p.usage.at(-1)?.activeUsers ?? 0} active today</span>
              </div>
            </Card>
          );
        })}
      </div>

      {data.length === 0 && (
        <div className="px-5 pt-4">
          <Card className="p-6">
            <div className="mx-auto max-w-[48ch] text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl border border-gold-600/30 bg-gold-500/[0.08] text-gold-300">
                <Icons.KeyRound size={18} />
              </span>
              {clients.length === 0 ? (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">A partner is engaged by a client</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Add a client first. A partner's console exists inside a client relationship — its
                    seats, devices and quota are contracted through one.
                  </p>
                  <Link to="/clients" className="mt-4 inline-flex">
                    <Button variant="primary" icon="Building2">Go to Clients</Button>
                  </Link>
                </>
              ) : (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">No partner consoles yet</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Create one and its limits start being enforced on the next request — device ceiling,
                    seat count and API quota are checked at the edge, not at the next deploy.
                  </p>
                  <Button
                    variant="primary"
                    className="mt-4"
                    icon="Plus"
                    onClick={() => { save.reset(); setEditing(emptyPartner(clients[0]?.id ?? '')); }}
                  >
                    Create a partner console
                  </Button>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      <div className="px-5 pt-3">
        <Card className="p-4">
          <SectionHeader title="Enforcement policy" subtitle="Applied per partner at the API edge" />
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            {[
              ['Device ceiling', 'A device activates only while the partner is under its licensed ceiling. Revocation fails closed within 60 seconds.'],
              ['Seat ceiling', 'IAM invitations beyond the contracted seat count are rejected at creation with an upgrade path.'],
              ['API quota', 'Metered per day; soft-warn at 80%, hard-limit at 100% with an ops alert before the client notices.'],
              ['Uptime SLA', 'Tracked per partner per day. Two consecutive days below 99.5% opens an incident without a human asking.'],
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
        icon="Handshake"
        title={creating ? 'New partner' : editing ? `Edit ${editing.name}` : 'Edit partner'}
        subtitle={
          creating
            ? 'A partner is an external agency engaged by one of your clients. It gets its own console, IAM users, device licences and quota from the moment it exists.'
            : 'Limits are enforced on the next request, not at the next deployment.'
        }
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={save.isPending}
              disabled={!editing?.name.trim() || (creating && !editing?.clientId)}
              onClick={() => editing && save.mutate(editing)}
            >
              {creating ? 'Create partner' : 'Save partner'}
            </Button>
          </>
        }
      >
        {save.isError && (
          <div className="mb-3"><ApiFailure error={save.error} what="Could not save this partner." /></div>
        )}
        {editing && (
          <div className="space-y-3">
            {creating && (
              <Field label="Engaged by client" hint={clients.length === 0 ? 'Add a client first — a partner cannot belong to nobody.' : undefined}>
                {({ id }) => (
                  <Select id={id} value={editing.clientId} onChange={(e) => setEditing({ ...editing, clientId: e.target.value })}>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Partner name">
              {({ id }) => (
                <Input id={id} autoFocus value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Plan">
                {({ id }) => (
                  <Select id={id} value={editing.plan} onChange={(e) => setEditing({ ...editing, plan: e.target.value })}>
                    {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Status" hint="A suspended tenant can provision nothing at all.">
                {({ id }) => (
                  <Select id={id} value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                    {PARTNER_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </Select>
                )}
              </Field>
            </div>

            <Field label="Console URL" hint="Where the partner's own console lives. Optional.">
              {({ id }) => (
                <Input id={id} value={editing.consoleUrl} placeholder="https://console.partner.example"
                  onChange={(e) => setEditing({ ...editing, consoleUrl: e.target.value })} />
              )}
            </Field>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Devices" hint="Licensed ceiling">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={editing.deviceLimit}
                    onChange={(e) => setEditing({ ...editing, deviceLimit: e.target.value })} />
                )}
              </Field>
              <Field label="Seats" hint="IAM invitations">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={editing.seatLimit}
                    onChange={(e) => setEditing({ ...editing, seatLimit: e.target.value })} />
                )}
              </Field>
              <Field label="API / month">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={editing.apiQuota}
                    onChange={(e) => setEditing({ ...editing, apiQuota: e.target.value })} />
                )}
              </Field>
            </div>

            <p className="rounded-lg border border-ink-600 bg-ink-850/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-mist-500">
              A device limit cannot be cut below the number of devices the partner already has —
              the server refuses that with the current count, because the tenant would otherwise sit
              permanently over quota with no way to see why.
            </p>

            {save.error ? <ApiFailure error={save.error} what="the partner was not saved." /> : null}
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------- delete sheet */}
      <Modal
        open={deleting !== null}
        icon="Ban"
        title={`Delete ${deleting?.name ?? 'partner'}?`}
        subtitle="A partner with an active device licence or an enabled seat cannot be deleted — those are credentials in use, and the server refuses rather than revoking them silently."
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
              Delete partner
            </Button>
          </>
        }
      >
        {remove.isError ? (
          <ApiFailure error={remove.error} what="The server refused this deletion." />
        ) : deleting && (
          <p className="text-[12px] leading-relaxed text-mist-400">
            {deleting.devicesActive === 0 && deleting.seats === 0
              ? 'This partner has no active devices and no enabled seats, so nothing in flight is ended by removing it.'
              : `Right now it has ${deleting.devicesActive} active device(s) and ${deleting.seats} enabled seat(s), so expect a refusal until those are revoked.`}
            {' '}Usage history and invitations are removed with the console.
          </p>
        )}
      </Modal>
    </div>
  );
}
