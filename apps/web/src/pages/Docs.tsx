/** Knowledge — runbooks, ADRs, specs and exec summaries. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { relTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import { Badge, Button, Card, Input, Skeleton } from '../components/ui';

const KIND_ICON: Record<string, keyof typeof Icons> = {
  runbook: 'Terminal', adr: 'GitCommitVertical', spec: 'FileCode2', note: 'StickyNote', retro: 'RefreshCcw', exec_summary: 'FileCheck2', onboarding: 'GraduationCap',
};

export default function Docs() {
  const docs = useQuery({ queryKey: ['docs'], queryFn: () => api.docs() });
  const docState = useQueryState(docs);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  if (docState.state === 'failed') return <QueryFailure error={docState.error} what="the knowledge base" retry={docState.refetch} />;
  if (docState.state !== 'ready') return <div className="p-5"><Skeleton className="h-8 w-44" /><Skeleton className="mt-4 h-72" /></div>;

  const data = docState.data;

  const filtered = data.filter((d) => !q || d.title.toLowerCase().includes(q.toLowerCase()) || d.body.toLowerCase().includes(q.toLowerCase()));
  const active = data.find((d) => d.id === selected) ?? filtered[0];

  return (
    <div className="flex h-[calc(100vh-48px)] flex-col">
      <PageHeader
        eyebrow={<><Icons.BookOpen size={11} /> Knowledge base</>}
        title="Runbooks & decisions"
        subtitle="The written record that makes turnover auditable: ADRs for the choices, runbooks for the operations, exec summaries for the client."
        right={
          <div className="relative">
            <Icons.Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-mist-500" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search docs…" className="h-8 w-[220px] pl-7" />
          </div>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr] gap-0">
        <div className="min-h-0 overflow-y-auto border-r border-ink-700/70 p-2">
          {filtered.map((d) => {
            const Icon = Icons[KIND_ICON[d.kind] ?? 'FileText'] as React.ComponentType<{ size?: number; className?: string }>;
            const isActive = active?.id === d.id;
            return (
              <button
                key={d.id}
                onClick={() => setSelected(d.id)}
                className={cls('mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                  isActive ? 'bg-ink-750' : 'hover:bg-ink-800/60')}
              >
                <span className={cls('mt-0.5 grid size-5 shrink-0 place-items-center rounded', isActive ? 'bg-iris-500/15 text-iris-300' : 'bg-ink-800 text-mist-500')}>
                  <Icon size={10} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cls('truncate text-[11.5px] font-medium', isActive ? 'text-white' : 'text-mist-300')}>{d.title}</p>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-[9px] uppercase tracking-wider text-mist-500">{d.kind.replace('_', ' ')}</span>
                    <span className="text-[9px] text-mist-500/60">· {relTime(d.updatedAt)}</span>
                  </div>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && <p className="px-2 py-8 text-center text-[11px] text-mist-500">No docs match.</p>}
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          {active ? (
            <article className="mx-auto max-w-[720px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="outline">{active.kind.replace('_', ' ')}</Badge>
                <Badge tone={active.status === 'approved' ? 'mint' : active.status === 'in_review' ? 'amber' : 'neutral'}>{active.status}</Badge>
                {active.clientVisible && <Badge tone="sky"><Icons.Globe size={8} /> client-visible</Badge>}
                {active.projectName && <Badge tone="iris">{active.projectName}</Badge>}
              </div>
              <h1 className="mt-2.5 text-balance text-[22px] font-semibold leading-tight tracking-tight text-white">{active.title}</h1>
              <p className="mt-1 text-[10.5px] text-mist-500">updated {relTime(active.updatedAt)}</p>
              <div className="mt-4 space-y-3 border-t border-ink-700/70 pt-4 text-[12.5px] leading-[1.75] text-mist-300">
                {active.body.split('. ').reduce<string[]>((acc, sentence, i) => {
                  if (i % 3 === 0) acc.push(sentence);
                  else acc[acc.length - 1] += '. ' + sentence;
                  return acc;
                }, []).map((para, i) => <p key={i}>{para}</p>)}
              </div>
              <div className="mt-6 rounded-xl border border-iris-500/20 bg-iris-500/[0.05] p-3">
                <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-iris-300">
                  <Icons.GitPullRequest size={11} /> Docs are governed too
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-mist-400">
                  Phase turnover requires the docs and runbook to reflect the shipped state (gate TG-11). A missing ADR blocks a phase closure just like a missing test.
                </p>
              </div>
            </article>
          ) : (
            <div className="grid h-full place-items-center text-center">
              <div>
                <Icons.BookOpen size={22} className="mx-auto text-mist-500" />
                <p className="mt-2 text-[12px] text-mist-500">Select a document.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
