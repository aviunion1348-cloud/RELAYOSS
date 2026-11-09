/**
 * Knowledge — runbooks, ADRs, specs and exec summaries.
 *
 * This screen used to render documents it could not write. The list was real, the
 * reader was careful, the empty state was honest — and there was no way to add a
 * runbook, correct a wrong paragraph or retire a stale ADR. In a product whose
 * whole argument is that turnover is auditable, the written record was the one
 * artefact nobody could author.
 *
 * So: create, edit and retire, all three persisted, all three reflected here
 * immediately. Two details make that trustworthy rather than merely present:
 *
 *   - the form is seeded from the row it edits, so saving cannot silently blank a
 *     field the form does not show (a partial PATCH of `{title}` is fine, but a
 *     `PUT`-shaped save of an incomplete object is how data disappears);
 *   - a failed save is rendered *in the sheet*, next to the field the server
 *     rejected, and the sheet stays open with the typed text intact. Losing a
 *     paragraph to a validation error is the failure people remember.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { relTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { QueryFailure } from '../components/QueryFailure';
import { useQueryState } from '../lib/query-state';
import { ApiFailure } from '../components/ApiFailure';
import { Badge, Button, Empty, Field, Input, Modal, Select, Skeleton, Textarea } from '../components/ui';
import type { Doc } from '../types';

const KIND_ICON: Record<string, keyof typeof Icons> = {
  runbook: 'Terminal', adr: 'GitCommitVertical', spec: 'FileCode2', note: 'StickyNote',
  retro: 'RefreshCcw', exec_summary: 'FileCheck2', onboarding: 'GraduationCap',
};

const KINDS = ['runbook', 'adr', 'spec', 'note', 'retro', 'exec_summary', 'onboarding'] as const;
const STATUSES = ['draft', 'in_review', 'approved', 'archived'] as const;

const STATUS_TONE: Record<string, 'mint' | 'amber' | 'neutral' | 'rose'> = {
  approved: 'mint', in_review: 'amber', draft: 'neutral', archived: 'rose',
};

/** What the sheet is being used for. `null` means closed. */
type Draft = {
  mode: 'create' | 'edit';
  id?: string;
  title: string;
  kind: string;
  body: string;
  status: string;
  clientVisible: boolean;
};

const emptyDraft = (): Draft => ({
  mode: 'create', title: '', kind: 'note', body: '', status: 'draft', clientVisible: false,
});

export default function Docs() {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['docs'], queryFn: () => api.docs() });
  const docState = useQueryState(docs);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Doc | null>(null);

  /*
   * Every write invalidates rather than patching the cache by hand.
   *
   * The list is ordered by `updated_at` on the server, so a locally patched row
   * would sit in the wrong place until the next fetch, and a document created here
   * would not appear at all. One invalidation of `['docs']` re-reads the truth; the
   * dashboard and search also read documents, so both are refreshed with it.
   */
  const refreshAfterWrite = () => {
    void qc.invalidateQueries({ queryKey: ['docs'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['search'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.mode === 'create'
        ? api.createDoc({
            title: d.title.trim(), kind: d.kind, body: d.body, status: d.status,
            clientVisible: d.clientVisible,
          })
        : api.updateDoc(d.id!, {
            title: d.title.trim(), kind: d.kind, body: d.body, status: d.status,
            clientVisible: d.clientVisible,
          }),
    onSuccess: (saved) => {
      refreshAfterWrite();
      // Land the reader on what they just wrote, rather than leaving them on the
      // document they had selected before.
      setSelected(saved.id);
      setDraft(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDoc(id),
    onSuccess: (_r, id) => {
      refreshAfterWrite();
      setSelected((current) => (current === id ? null : current));
      setConfirmDelete(null);
    },
  });

  const filtered = useMemo(() => {
    if (docState.state !== 'ready') return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return docState.data;
    return docState.data.filter(
      (d) => d.title.toLowerCase().includes(needle) || d.body.toLowerCase().includes(needle),
    );
  }, [docState, q]);

  if (docState.state === 'failed') {
    return <QueryFailure error={docState.error} what="the knowledge base" retry={docState.refetch} />;
  }
  if (docState.state !== 'ready') {
    return <div className="p-5"><Skeleton className="h-8 w-44" /><Skeleton className="mt-4 h-72" /></div>;
  }

  const data = docState.data;
  const active = data.find((d) => d.id === selected) ?? filtered[0];

  const openCreate = () => { save.reset(); setDraft(emptyDraft()); };
  const openEdit = (d: Doc) => {
    save.reset();
    setDraft({
      mode: 'edit', id: d.id, title: d.title, kind: d.kind, body: d.body,
      status: d.status, clientVisible: d.clientVisible,
    });
  };

  return (
    <div className="flex h-[calc(100vh-52px)] flex-col">
      <PageHeader
        eyebrow={<><Icons.BookOpen size={11} /> Knowledge base</>}
        title="Runbooks & decisions"
        subtitle="The written record that makes turnover auditable: ADRs for the choices, runbooks for the operations, exec summaries for the client."
        right={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Icons.Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-mist-500" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search docs…" className="h-8 w-[200px] pl-7" />
            </div>
            <Button variant="primary" size="sm" icon="Plus" onClick={openCreate}>New document</Button>
          </div>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr] gap-0">
        {/* ------------------------------------------------------------ list */}
        <div className="min-h-0 overflow-y-auto border-r border-ink-700/70 p-2">
          {filtered.map((d) => {
            const Icon = Icons[KIND_ICON[d.kind] ?? 'FileText'] as React.ComponentType<{ size?: number; className?: string }>;
            const isActive = active?.id === d.id;
            return (
              <button
                key={d.id}
                onClick={() => setSelected(d.id)}
                className={cls(
                  'edge mb-1.5 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                  isActive ? 'bg-ink-750' : 'hover:bg-ink-800/60',
                )}
              >
                <span className={cls('mt-0.5 grid size-5 shrink-0 place-items-center rounded', isActive ? 'bg-gold-500/15 text-gold-300' : 'bg-ink-800 text-mist-500')}>
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
          {filtered.length === 0 && (
            q.trim()
              ? <p className="px-2 py-8 text-center text-[11px] text-mist-500">No documents match “{q}”.</p>
              : (
                <Empty
                  icon="BookOpen"
                  title="Nothing written yet"
                  hint="Create the first runbook — the next person to take this project over will need it."
                />
              )
          )}
        </div>

        {/* --------------------------------------------------------- reader */}
        <div className="min-h-0 overflow-y-auto p-5">
          {active ? (
            <article className="mx-auto max-w-[720px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="outline">{active.kind.replace('_', ' ')}</Badge>
                <Badge tone={STATUS_TONE[active.status] ?? 'neutral'}>{active.status.replace('_', ' ')}</Badge>
                {active.clientVisible && <Badge tone="sky"><Icons.Globe size={8} /> client-visible</Badge>}
                {active.projectName && <Badge tone="iris">{active.projectName}</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  <Button size="xs" variant="ghost" icon="PenTool" onClick={() => openEdit(active)}>Edit</Button>
                  <Button size="xs" variant="ghost" icon="Ban" onClick={() => setConfirmDelete(active)}>Retire</Button>
                </span>
              </div>

              <h1 className="mt-2.5 text-balance text-[23px] font-semibold leading-tight tracking-tight text-white display">{active.title}</h1>
              <p className="mt-1 text-[10.5px] text-mist-500">updated {relTime(active.updatedAt)}</p>

              <div className="mt-4 space-y-3 border-t border-ink-700/70 pt-4 text-[12.5px] leading-[1.75] text-mist-300">
                {active.body.trim()
                  ? active.body.split(/\n{2,}/).map((para, i) => (
                      <p key={i} className="whitespace-pre-wrap">{para}</p>
                    ))
                  : <p className="text-[11.5px] italic text-mist-500">This document has no body yet. Use Edit to write it.</p>}
              </div>

              <div className="mt-6 rounded-xl border border-gold-600/25 bg-gold-500/[0.04] p-3">
                <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gold-300 eyebrow">
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
                <p className="mt-2 text-[12px] text-mist-500">Select a document, or write a new one.</p>
                <Button className="mt-3" variant="primary" icon="Plus" onClick={openCreate}>New document</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ sheet */}
      <Modal
        open={draft !== null}
        icon={draft?.mode === 'edit' ? 'PenTool' : 'Plus'}
        title={draft?.mode === 'edit' ? 'Edit document' : 'New document'}
        subtitle="Saved to the knowledge base and visible to everyone the project is shared with."
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="Check"
              loading={save.isPending}
              disabled={!draft?.title.trim()}
              onClick={() => draft && save.mutate(draft)}
            >
              {draft?.mode === 'edit' ? 'Save changes' : 'Create document'}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            <Field label="Title" hint="What this document answers, in one line.">
              {({ id }) => (
                <Input
                  id={id}
                  autoFocus
                  value={draft.title}
                  placeholder="Phase-2 turnover runbook"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind">
                {({ id }) => (
                  <Select id={id} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                    {KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Status">
                {({ id }) => (
                  <Select id={id} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                  </Select>
                )}
              </Field>
            </div>

            <Field label="Body" hint="Blank lines separate paragraphs. Plain text — no markup.">
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={12}
                  value={draft.body}
                  placeholder="What changed, why, and what the next person has to know."
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              )}
            </Field>

            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-ink-600 bg-ink-850/60 px-2.5 py-2">
              <input
                type="checkbox"
                checked={draft.clientVisible}
                onChange={(e) => setDraft({ ...draft, clientVisible: e.target.checked })}
                className="mt-0.5 size-3.5 accent-gold-500"
              />
              <span className="min-w-0">
                <span className="block text-[11.5px] font-medium text-mist-200">Client-visible</span>
                <span className="block text-[10.5px] leading-relaxed text-mist-500">
                  Client users can read this. Internal documents stay internal — leaving this off is the safe default.
                </span>
              </span>
            </label>

            {save.error ? <ApiFailure error={save.error} what="the document was not saved." /> : null}
          </div>
        )}
      </Modal>

      {/* --------------------------------------------------------- retire */}
      <Modal
        open={confirmDelete !== null}
        icon="Ban"
        title="Retire this document?"
        subtitle="This removes it from the knowledge base for everyone. If it needs to stay on the record, set its status to archived instead."
        width={470}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Keep it</Button>
            <Button
              variant="danger"
              icon="Ban"
              loading={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
            >
              Retire document
            </Button>
          </>
        }
      >
        {confirmDelete && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-mist-200">{confirmDelete.title}</p>
            <p className="text-[11px] text-mist-500">
              {confirmDelete.kind.replace('_', ' ')} · updated {relTime(confirmDelete.updatedAt)}
            </p>
            {remove.error ? <ApiFailure error={remove.error} what="the document was not retired." /> : null}
          </div>
        )}
      </Modal>
    </div>
  );
}
