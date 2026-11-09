/**
 * Pipeline — the consultation-to-kickoff board.
 * Stages are data-driven; each column shows its entry/exit criteria and SLA,
 * because the promise made to a client at each stage is a contract.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { inr, relTime, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { MutationFailure, QueryFailure } from '../components/QueryFailure';
import { useMutationFailure, useQueryState } from '../lib/query-state';
import {
  Avatar, Badge, Button, Card, Dot, Empty, Field, Input, Modal, Progress, SectionHeader, Segmented,
  Select, Skeleton, Textarea, Tooltip,
} from '../components/ui';
import { ApiFailure } from '../components/ApiFailure';
import type { Deal } from '../types';

const PHASE_TONE: Record<string, string> = {
  origin: 'neutral', discovery: 'iris', proposal: 'sky', delivery: 'mint', growth: 'amber',
};

export default function Pipeline() {
  const qc = useQueryClient();
  const pipeline = useQuery({ queryKey: ['pipeline'], queryFn: api.pipeline });
  const q = useQueryState(pipeline);
  const [view, setView] = useState<'board' | 'table'>('board');
  const [selected, setSelected] = useState<Deal | null>(null);
  const clientsQuery = useQuery({ queryKey: ['clients'], queryFn: api.clients });
  const clients = clientsQuery.data ?? [];
  const [draft, setDraft] = useState<{
    clientId: string; title: string; valueRupees: string; stageKey: string; probability: string; nextStep: string;
  } | null>(null);

  /*
   * A deal starts at the first stage of the pipeline that is not "closed", because a
   * deal created at a later gate would claim a conversation that has not happened. The
   * form still lets the reader place it deliberately.
   */
  const firstStage = (key: string | undefined) => key ?? 'inbound';

  const create = useMutation({
    mutationFn: (d: NonNullable<typeof draft>) => api.createDeal({
      clientId: d.clientId,
      title: d.title.trim(),
      valueCents: Math.max(0, Math.round((Number(d.valueRupees) || 0) * 100)),
      stageKey: d.stageKey,
      probability: Math.min(100, Math.max(0, Number(d.probability) || 0)),
      nextStep: d.nextStep.trim(),
    }),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['pipeline'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const moveError = useMutationFailure();
  const move = useMutation({
    onMutate: () => moveError.clear(),
    onError: (e: unknown) => moveError.set(e),
    mutationFn: (vars: { id: string; stageKey: string }) => api.updateDeal(vars.id, { stageKey: vars.stageKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline'] });
      qc.invalidateQueries({ queryKey: ['clocks-live'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  if (q.state === 'failed') return <QueryFailure error={q.error} what="the pipeline" retry={q.refetch} />;
  if (q.state !== 'ready') {
    return (
      <div className="p-5">
        <Skeleton className="h-8 w-48" />
        <div className="mt-4 grid grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
        <Skeleton className="mt-4 h-80" />
      </div>
    );
  }

  const data = q.data;
  const grouped = useMemo(() => {
    if (!data) return [];
    return data.columns.filter((c) => c.key !== 'closed' || c.deals.length > 0);
  }, [data]);


  const s = data.summary;

  return (
    <div className="pb-8">
      {moveError.error !== null && (
        <div className="px-5 pt-3">
          <MutationFailure error={moveError.error} what="Moving that deal" onDismiss={moveError.clear} />
        </div>
      )}

      <PageHeader
        eyebrow={<><Icons.GitBranch size={11} /> Revenue pipeline</>}
        title="Consultation → Kickoff"
        subtitle="Every deal moves through the same twelve gates. The clocks start the moment a real commitment is made — a consultation booked, a plan sent, a revision requested."
        right={
          <>
            <Segmented value={view} onChange={setView} options={[{ value: 'board', label: 'Board', icon: 'Columns3' }, { value: 'table', label: 'Table', icon: 'List' }]} />
            <Button
              variant="primary"
              size="sm"
              icon="Plus"
              disabled={clients.length === 0}
              onClick={() => { create.reset(); setDraft({ clientId: clients[0]?.id ?? '', title: '', valueRupees: '', stageKey: firstStage(data.columns[0]?.key), probability: '20', nextStep: '' }); }}
            >
              New deal
            </Button>
          </>
        }
      />

      {/*
        How the board actually works, in three sentences.

        The columns are a contract, not a guess: each one states what has to be true to
        enter it, what has to be true to leave, and the turnaround that was promised.
        A deal left in a column past its SLA is the thing this screen exists to show.
      */}
      <div className="px-5 pt-4">
        <Card className="p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-mist-500">
            <span className="flex items-center gap-1.5 font-medium text-mist-300"><Icons.Info size={11} className="text-gold-400" /> How this board works</span>
            <span><span className="text-mist-300">1.</span> Add a deal against a client</span>
            <span><span className="text-mist-300">2.</span> Move it right as each gate is cleared</span>
            <span><span className="text-mist-300">3.</span> Past the promised days, it turns amber</span>
            <span><span className="text-mist-300">4.</span> Won work becomes a project</span>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-2.5 px-5 pt-4 lg:grid-cols-5">
        <Card className="p-3.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">Open pipeline</p>
          <p className="mt-1 text-[22px] font-semibold leading-none tabular text-white">{inr(s.pipelineValueCents, { compact: true })}</p>
          <p className="mt-1 text-[10.5px] text-mist-500">{s.openDeals} live deals · avg {s.avgAgeDays}d in stage</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">Weighted forecast</p>
          <p className="mt-1 text-[22px] font-semibold leading-none tabular text-iris-300">{inr(s.weightedCents, { compact: true })}</p>
          <p className="mt-1 text-[10.5px] text-mist-500">probability-adjusted</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">Won</p>
          <p className="mt-1 text-[22px] font-semibold leading-none tabular text-mint-400">{inr(s.wonValueCents, { compact: true })}</p>
          <p className="mt-1 text-[10.5px] text-mist-500">signed this year</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">Lost</p>
          <p className="mt-1 text-[22px] font-semibold leading-none tabular text-rose-400">{inr(s.lostValueCents, { compact: true })}</p>
          <p className="mt-1 text-[10.5px] text-mist-500">win-loss reviewed monthly</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mist-500">In delivery</p>
          <p className="mt-1 text-[22px] font-semibold leading-none tabular text-sky-400">{inr(s.byPhase.delivery, { compact: true })}</p>
          <p className="mt-1 text-[10.5px] text-mist-500">revenue already contracted</p>
        </Card>
      </div>

      {data.deals.length === 0 && (
        <div className="px-5 pt-4">
          <Card className="p-6">
            <div className="mx-auto max-w-[50ch] text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl border border-gold-600/30 bg-gold-500/[0.08] text-gold-300">
                <Icons.GitBranch size={18} />
              </span>
              {clients.length === 0 ? (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">A deal needs a client</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Add a client first — a deal is a conversation with one, and every column below
                    measures how long that conversation has been waiting.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-3 text-[14px] font-semibold text-white">No deals in the pipeline</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-mist-500">
                    Add the first one. It lands in the earliest stage; each move to the right records a
                    timestamp and starts the turnaround clock for that gate.
                  </p>
                  <Button
                    variant="primary"
                    className="mt-4"
                    icon="Plus"
                    onClick={() => { create.reset(); setDraft({ clientId: clients[0]?.id ?? '', title: '', valueRupees: '', stageKey: firstStage(data.columns[0]?.key), probability: '20', nextStep: '' }); }}
                  >
                    Add the first deal
                  </Button>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      {view === 'board' ? (
        <div className="mt-4 overflow-x-auto px-3">
          <div className="flex min-w-max gap-2.5">
            {grouped.map((col) => (
              <section key={col.id} className="flex w-[268px] shrink-0 flex-col rounded-xl border border-ink-700/70 bg-ink-900/40">
                <header className="border-b border-ink-700/60 px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full" style={{ background: col.color }} />
                    <h3 className="text-[11.5px] font-semibold text-mist-200">{col.name}</h3>
                    <span className="rounded bg-ink-750 px-1 text-[9px] tabular text-mist-400">{col.deals.length}</span>
                    <Tooltip label={`Promised turnaround: ${col.slaDays} days`}>
                      <span className="ml-auto text-[9px] tabular text-mist-500">{col.slaDays}d</span>
                    </Tooltip>
                  </div>
                  <p className="mt-1 text-[9.5px] leading-snug text-mist-500">{col.description}</p>
                  <div className="mt-1.5 flex items-center justify-between border-t border-ink-700/50 pt-1.5">
                    <span className="text-[9.5px] tabular text-mist-400">{inr(col.valueCents, { compact: true })}</span>
                    <Badge tone={PHASE_TONE[col.phase] ?? 'neutral'}>{col.phase}</Badge>
                  </div>
                </header>
                <div className="min-h-[80px] flex-1 space-y-1.5 p-2">
                  {col.deals.length === 0 && (
                    <div className="grid h-16 place-items-center rounded-lg border border-dashed border-ink-600 text-[10px] text-mist-500">
                      No deals
                    </div>
                  )}
                  {col.deals.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setSelected(d)}
                      className="surface surface-hover w-full rounded-lg p-2 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="size-1.5 rounded-sm" style={{ background: d.clientColor }} />
                        <span className="truncate text-[10px] text-mist-500">{d.clientName}</span>
                        {d.status === 'lost' && <Badge tone="rose">lost</Badge>}
                        {d.status === 'won' && <Badge tone="mint">won</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11.5px] font-medium leading-snug text-mist-200">{d.title}</p>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-semibold tabular text-mist-300">{inr(d.valueCents, { compact: true })}</span>
                        <span className="text-[9.5px] tabular text-mist-500">{d.probability}%</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <Progress value={d.probability} tone={d.probability > 70 ? 'mint' : d.probability > 40 ? 'iris' : 'mist'} height={2} />
                        {d.owner && <Avatar name={d.owner.name} initials={d.owner.initials} color={d.owner.color} size={15} />}
                      </div>
                      {d.ageDays > col.slaDays && (
                        <p className="mt-1 flex items-center gap-1 text-[9px] text-amber-400">
                          <Icons.Clock size={8} /> {d.ageDays}d in stage (SLA {col.slaDays}d)
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="px-5 pt-4">
          <Card className="overflow-hidden">
            <table className="w-full text-left">
              <thead className="border-b border-ink-700 bg-ink-850/60">
                <tr className="text-[9.5px] uppercase tracking-[0.1em] text-mist-500">
                  <th className="px-3 py-2 font-medium">Deal</th>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 text-right font-medium">Prob</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Next step</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/60">
                {data.deals.map((d) => (
                  <tr key={d.id} onClick={() => setSelected(d)} className="cursor-pointer transition-colors hover:bg-ink-800/60">
                    <td className="max-w-[280px] px-3 py-2">
                      <p className="truncate text-[12px] font-medium text-mist-200">{d.title}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-[11px] text-mist-400">
                        <span className="size-1.5 rounded-sm" style={{ background: d.clientColor }} />
                        {d.clientName}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={PHASE_TONE[d.stagePhase] ?? 'neutral'} dot>{d.stageName}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right text-[11.5px] font-medium tabular text-mist-200">{inr(d.valueCents, { compact: true })}</td>
                    <td className="px-3 py-2 text-right text-[11px] tabular text-mist-400">{d.probability}%</td>
                    <td className="px-3 py-2">
                      {d.owner && <span className="flex items-center gap-1.5"><Avatar name={d.owner.name} initials={d.owner.initials} color={d.owner.color} size={16} /><span className="text-[11px] text-mist-400">{d.owner.name.split(' ')[0]}</span></span>}
                    </td>
                    <td className="max-w-[240px] px-3 py-2">
                      <p className="truncate text-[11px] text-mist-500">{d.nextStep || '—'}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {selected && data.columns.length > 0 && (
        <DealDrawer
          deal={data.deals.find((d) => d.id === selected.id) ?? selected}
          columns={data.columns.map((c) => ({ key: c.key, name: c.name, phase: c.phase, slaDays: c.slaDays, entryCriteria: c.entryCriteria, exitCriteria: c.exitCriteria, description: c.description }))}
          onClose={() => setSelected(null)}
          onMove={(stageKey) => {
            move.mutate({ id: selected.id, stageKey });
            qc.invalidateQueries({ queryKey: ['pipeline'] });
            setSelected(null);
          }}
          onDelete={async () => {
            await api.deleteDeal(selected.id);
            await qc.invalidateQueries({ queryKey: ['pipeline'] });
            await qc.invalidateQueries({ queryKey: ['dashboard'] });
            setSelected(null);
          }}
        />
      )}
      {/* -------------------------------------------------------- create sheet */}
      <Modal
        open={draft !== null}
        icon="GitBranch"
        title="New deal"
        subtitle="A deal is a conversation with a client. It starts in a stage, and every move to the right stamps a time and starts that gate's clock."
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={create.isPending}
              disabled={!draft?.title.trim() || !draft?.clientId}
              onClick={() => draft && create.mutate(draft)}
            >
              Add deal
            </Button>
          </>
        }
      >
        {create.isError && (
          <div className="mb-3"><ApiFailure error={create.error} what="Could not add this deal." /></div>
        )}
        {draft && (
          <div className="space-y-3">
            <Field label="Deal">
              {({ id }) => (
                <Input id={id} autoFocus value={draft.title} placeholder="Payments platform rebuild"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client">
                {({ id }) => (
                  <Select id={id} value={draft.clientId} onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Stage">
                {({ id }) => (
                  <Select id={id} value={draft.stageKey} onChange={(e) => setDraft({ ...draft, stageKey: e.target.value })}>
                    {data.columns.filter((c) => c.key !== 'closed').map((c) => (
                      <option key={c.key} value={c.key}>{c.name}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Value" hint="₹">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={draft.valueRupees} placeholder="0"
                    onChange={(e) => setDraft({ ...draft, valueRupees: e.target.value })} />
                )}
              </Field>
              <Field label="Confidence" hint="% — 20 is a fair opening guess">
                {({ id }) => (
                  <Input id={id} type="number" min={0} max={100} value={draft.probability}
                    onChange={(e) => setDraft({ ...draft, probability: e.target.value })} />
                )}
              </Field>
            </div>
            <Field label="Next step" hint="Optional now; the sheet asks for it every time it goes empty.">
              {({ id }) => (
                <Textarea id={id} rows={2} value={draft.nextStep} placeholder="Book the technical consultation"
                  onChange={(e) => setDraft({ ...draft, nextStep: e.target.value })} />
              )}
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function DealDrawer({
  deal, columns, onClose, onMove, onDelete,
}: {
  deal: Deal;
  columns: Array<{ key: string; name: string; phase: string; slaDays: number; entryCriteria: string; exitCriteria: string; description: string }>;
  onClose: () => void;
  onMove: (stageKey: string) => void;
  onDelete: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const idx = columns.findIndex((c) => c.key === deal.stageKey);
  /*
   * The three numbers that change as a conversation progresses. They were read-only
   * here, so a deal's value and its next step could only be set at creation — which is
   * backwards: the value is discovered during the consultation, and the next step is
   * the thing that changes every week.
   */
  const [valueRupees, setValueRupees] = useState(String(Math.round(deal.valueCents / 100)));
  const [probability, setProbability] = useState(String(deal.probability));
  const [nextStep, setNextStep] = useState(deal.nextStep ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () => api.updateDeal(deal.id, {
      valueCents: Math.max(0, Math.round((Number(valueRupees) || 0) * 100)),
      probability: Math.min(100, Math.max(0, Number(probability) || 0)),
      nextStep: nextStep.trim(),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pipeline'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => onDelete(),
    onError: () => undefined,
  });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-950/65 backdrop-blur-[2px] animate-fade" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-[min(560px,96vw)] flex-col border-l border-ink-600 bg-ink-900 animate-slide-in">
        <div className="border-b border-ink-700/80 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-sm" style={{ background: deal.clientColor }} />
                <span className="text-[10.5px] text-mist-500">{deal.clientName}</span>
                <Badge tone={PHASE_TONE[deal.stagePhase] ?? 'neutral'}>{deal.stageName}</Badge>
                {deal.status !== 'open' && <Badge tone={deal.status === 'won' ? 'mint' : 'rose'}>{deal.status}</Badge>}
              </div>
              <h2 className="mt-1.5 text-[16px] font-semibold leading-snug text-white">{deal.title}</h2>
              <p className="mt-1 text-[13px] font-semibold tabular text-iris-300">{inr(deal.valueCents)} · {deal.probability}% weighted</p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}><Icons.X size={15} /></Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <SectionHeader title="Stage contract" subtitle="What we promised at this gate" />
          <div className="mt-2.5 space-y-2">
            {columns.slice(Math.max(0, idx - 1), idx + 2).map((c, i) => (
              <div key={c.key} className={cls('rounded-lg border p-2.5', i === 1 ? 'border-iris-500/40 bg-iris-500/[0.06]' : 'border-ink-700 bg-ink-850/60')}>
                <div className="flex items-center justify-between">
                  <p className={cls('text-[11.5px] font-semibold', i === 1 ? 'text-white' : 'text-mist-400')}>{c.name}</p>
                  <span className="text-[9.5px] tabular text-mist-500">{c.slaDays}d turnover</span>
                </div>
                <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">{c.description}</p>
                <div className="mt-1.5 grid gap-1 text-[10px]">
                  <p className="text-mist-400"><span className="text-mist-500">Entry:</span> {c.entryCriteria}</p>
                  <p className="text-mist-400"><span className="text-mist-500">Exit:</span> {c.exitCriteria}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <SectionHeader title="Deal detail" subtitle="Value, confidence and the single next action — editable as the conversation moves" />
            {(save.isError || remove.isError) && (
              <div className="mt-2">
                <ApiFailure error={save.error ?? remove.error} what="That change was refused." />
              </div>
            )}
            {save.isSuccess && !save.isError && (
              <p className="mt-1.5 text-[10px] text-mint-400">Saved.</p>
            )}
            <div className="mt-2 grid grid-cols-[1fr_90px] gap-2">
              <Field label="Value" hint="₹ — what this is worth if it closes">
                {({ id }) => (
                  <Input id={id} type="number" min={0} value={valueRupees}
                    onChange={(e) => setValueRupees(e.target.value)} />
                )}
              </Field>
              <Field label="Confidence" hint="%">
                {({ id }) => (
                  <Input id={id} type="number" min={0} max={100} value={probability}
                    onChange={(e) => setProbability(e.target.value)} />
                )}
              </Field>
            </div>
            <div className="mt-2">
              <Field label="Next step" hint={nextStep.trim() ? undefined : 'Nothing recorded is itself a risk — say what happens next.'}>
                {({ id }) => (
                  <Textarea id={id} rows={2} value={nextStep} placeholder="Send the revised SOW by Friday"
                    onChange={(e) => setNextStep(e.target.value)} />
                )}
              </Field>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="primary" icon="Check" loading={save.isPending} onClick={() => save.mutate()}>
                Save changes
              </Button>
              <Button size="sm" variant="ghost" icon="Ban" className="ml-auto text-rose-300 hover:text-rose-200"
                onClick={() => setConfirmDelete(true)}>
                Delete deal
              </Button>
            </div>
          </div>

          <Modal
            open={confirmDelete}
            icon="Ban"
            title="Delete this deal?"
            subtitle="A deal that has produced a project cannot be deleted — that link is the record of where the work came from. Lost or withdrawn deals can go."
            onClose={() => setConfirmDelete(false)}
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="danger" icon="Ban" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Delete deal
                </Button>
              </>
            }
          >
            {remove.isError
              ? <ApiFailure error={remove.error} what="The server refused this deletion." />
              : <p className="text-[12px] leading-relaxed text-mist-400">{deal.title} — {deal.clientName}</p>}
          </Modal>

          <div className="mt-4">
            <SectionHeader title="Move stage" subtitle="Server stamps the timestamp and starts any attached clock" />
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {columns.filter((c) => c.key !== 'closed').map((c) => (
                <button
                  key={c.key}
                  onClick={() => onMove(c.key)}
                  disabled={c.key === deal.stageKey}
                  className={cls(
                    'rounded-lg border px-2 py-1.5 text-left text-[10.5px] transition-colors',
                    c.key === deal.stageKey
                      ? 'border-iris-500/50 bg-iris-500/12 text-iris-200'
                      : 'border-ink-600 bg-ink-850 text-mist-400 hover:border-ink-500 hover:text-mist-200',
                  )}
                >
                  <span className="flex items-center justify-between gap-1">
                    {c.name}
                    {c.key === deal.stageKey && <Icons.MapPin size={9} />}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-ink-700 bg-ink-850/50 p-3">
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-mist-500">Owner</p>
              <p className="mt-0.5 text-[11.5px] text-mist-300">{deal.owner?.name ?? 'Unassigned'}</p>
            </div>
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-mist-500">Age in stage</p>
              <p className="mt-0.5 text-[11.5px] tabular text-mist-300">{deal.ageDays} days</p>
            </div>
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-mist-500">Started</p>
              <p className="mt-0.5 text-[11.5px] text-mist-300">{shortDate(deal.startedAt)} · {relTime(deal.startedAt)}</p>
            </div>
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-mist-500">Stage SLA</p>
              <p className={cls('mt-0.5 text-[11.5px] tabular', deal.ageDays > deal.slaDays ? 'text-rose-400' : 'text-mint-400')}>
                {deal.slaDays}d budget
              </p>
            </div>
          </div>
          {deal.lostReason && (
            <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/8 p-2.5 text-[11px] text-rose-300">
              <Icons.XCircle size={11} className="mr-1 inline" /> Lost: {deal.lostReason}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
