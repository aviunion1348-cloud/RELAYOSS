/** Clients — relationship health, revenue and the consultation history. */
import { useQuery } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { inr } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Avatar, Badge, Card, HEALTH_TONE, Progress, SectionHeader, Skeleton } from '../components/ui';

export default function Clients() {
  const { data, isLoading } = useQuery({ queryKey: ['clients'], queryFn: api.clients });
  const { data: pipeline } = useQuery({ queryKey: ['pipeline'], queryFn: api.pipeline });

  if (isLoading || !data) return <div className="p-5"><Skeleton className="h-8 w-40" /><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div></div>;

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
                <span className="flex items-center gap-1 text-[9.5px] text-mist-500">
                  <Icons.Mail size={9} />{c.contactEmail ?? '—'}
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
    </div>
  );
}
