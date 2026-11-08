/** Partner console — IAM, device licences, API quota and uptime per partner. */
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { PageHeader } from '../components/Shell';
import { Badge, Card, Progress, Ring, SectionHeader, Skeleton } from '../components/ui';

export default function Partners() {
  const { data, isLoading } = useQuery({ queryKey: ['partners'], queryFn: api.partners });

  if (isLoading || !data) return <div className="p-5"><Skeleton className="h-8 w-48" /><div className="mt-4 grid gap-3 lg:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56" />)}</div></div>;

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={<><Icons.KeyRound size={11} /> Partner operations</>}
        title="Partner console"
        subtitle="Each partner gets its own console: IAM users, device licences, API quota, usage metering and uptime. Limits are enforced at the edge — a partner cannot exceed contracted devices or seats."
        right={<Badge tone="outline">{data.length} partner consoles</Badge>}
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
                  <p className="mt-0.5 truncate font-mono text-[9.5px] text-mist-500">{p.consoleUrl}</p>
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
                        <stop offset="0%" stopColor="#7c5cff" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#7c5cff" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1f232d" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" hide />
                    <YAxis tick={{ fill: '#6b7382', fontSize: 8.5 }} axisLine={false} tickLine={false} width={34} />
                    <RTooltip contentStyle={{ background: '#11131a', border: '1px solid #2e3340', borderRadius: 8, fontSize: 10.5 }} labelStyle={{ color: '#b4bccb' }} />
                    <Area type="monotone" dataKey="apiCalls" stroke="#7c5cff" strokeWidth={1.4} fill={`url(#gu-${p.id})`} />
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
    </div>
  );
}
