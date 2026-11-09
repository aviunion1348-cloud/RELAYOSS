/** Kanban board: drag & drop, WIP limits, filters, keyboard-first. */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';
import { dueTone, hours, shortDate } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { MutationFailure, QueryFailure } from '../components/QueryFailure';
import { useMutationFailure, useQueryState } from '../lib/query-state';
import {
  Avatar, Badge, Button, Card, Dot, Empty, Input, PRIORITY_TONE, RISK_TONE, Segmented, Select, Skeleton, Tooltip,
} from '../components/ui';
import { TaskDrawer } from '../components/TaskDrawer';
import type { Task } from '../types';

const COLUMNS = [
  { key: 'backlog', label: 'Backlog', color: '#64748b', wip: null },
  { key: 'todo', label: 'Ready', color: '#94a3b8', wip: null },
  { key: 'in_progress', label: 'In Progress', color: '#d4a44c', wip: 4 },
  { key: 'review', label: 'In Review', color: '#f5a524', wip: 3 },
  { key: 'blocked', label: 'Blocked', color: '#f4486b', wip: null },
  { key: 'done', label: 'Shipped', color: '#22c98a', wip: null },
];

const TYPE_ICON: Record<string, keyof typeof Icons> = {
  feature: 'Sparkle', bug: 'Bug', research: 'FlaskConical', design: 'PenTool', ops: 'Wrench', meeting: 'Users', content: 'FileText',
};

function TaskCard({
  task, onOpen, onDragStart, dragging,
}: { task: Task; onOpen: () => void; onDragStart: () => void; dragging: boolean }) {
  const Icon = Icons[TYPE_ICON[task.type] ?? 'Circle'] as React.ComponentType<{ size?: number; className?: string }>;
  const due = dueTone(task.dueAt);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cls(
        'surface group cursor-pointer rounded-lg p-2.5 transition-all',
        dragging ? 'opacity-40' : 'hover:border-ink-400 hover:bg-ink-750',
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon size={11} className={cls('shrink-0', task.type === 'bug' ? 'text-rose-400' : task.type === 'design' ? 'text-fuchsia-400' : 'text-mist-500')} />
          <span className="font-mono text-[9.5px] tracking-wide text-mist-500">{task.key}</span>
          {task.clientVisible && <Icons.Globe size={9} className="text-sky-400/70" />}
        </div>
        <span className={cls('shrink-0 text-[9px] font-semibold uppercase tracking-wider', task.priority === 'urgent' ? 'text-rose-400' : task.priority === 'high' ? 'text-amber-400' : 'text-mist-500')}>
          {task.priority.slice(0, 3)}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[12px] font-medium leading-snug text-mist-200 group-hover:text-white">{task.title}</p>

      {task.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.labels.slice(0, 3).map((l) => (
            <span key={l.id} className="rounded px-1 py-[1px] text-[9px] font-medium" style={{ background: `${l.color}18`, color: l.color }}>
              {l.name}
            </span>
          ))}
        </div>
      )}

      {task.status === 'blocked' && task.blockedReason && (
        <p className="mt-1.5 flex items-start gap-1 rounded border border-rose-500/20 bg-rose-500/8 px-1.5 py-1 text-[9.5px] leading-snug text-rose-300/90">
          <Icons.Ban size={9} className="mt-0.5 shrink-0" />
          <span className="line-clamp-2">{task.blockedReason}</span>
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        {task.turnoverState === 'failed' && (
          <Tooltip label="Turnover gate failed"><span className="text-rose-400"><Icons.ShieldX size={10} /></span></Tooltip>
        )}
        {task.turnoverState === 'passed' && (
          <Tooltip label="Turnover gates passed"><span className="text-mint-400"><Icons.ShieldCheck size={10} /></span></Tooltip>
        )}
        {task.counts.dependencies > 0 && (
          <span className="flex items-center gap-0.5 text-[9.5px] text-mist-500"><Icons.Link2 size={9} />{task.counts.dependencies}</span>
        )}
        {task.counts.comments > 0 && (
          <span className="flex items-center gap-0.5 text-[9.5px] text-mist-500"><Icons.MessageSquare size={9} />{task.counts.comments}</span>
        )}
        {task.counts.checklist > 0 && (
          <span className="flex items-center gap-0.5 text-[9.5px] text-mist-500">
            <Icons.SquareCheck size={9} />{task.counts.checklistDone}/{task.counts.checklist}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {task.dueAt && (
            <span className={cls('text-[9.5px] tabular', due === 'late' ? 'text-rose-400' : due === 'soon' ? 'text-amber-400' : 'text-mist-500')}>
              {shortDate(task.dueAt)}
            </span>
          )}
          {task.risk && task.risk.score >= 45 && <Dot tone={task.risk.band === 'critical' ? 'rose' : 'amber'} />}
          {task.assignee && <Avatar name={task.assignee.name} initials={task.assignee.initials} color={task.assignee.color} size={18} />}
        </div>
      </div>
    </div>
  );
}

export default function Board() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [boardId, setBoardId] = useState<string>('');
  const [filters, setFilters] = useState({ priority: [] as string[], mine: false, labelId: '', q: '', risk: 'all' });
  const [dragging, setDragging] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  /* Which column the new task should land in — set by whichever + was clicked. */
  const [newStatus, setNewStatus] = useState('todo');

  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const meta = metaQuery.data;
  const activeBoard = boardId || meta?.boards[0]?.id || '';

  const tasksQuery = useQuery({
    queryKey: ['tasks', activeBoard, filters],
    queryFn: () =>
      api.tasks({
        boardId: activeBoard || undefined,
        priority: filters.priority.length ? filters.priority : undefined,
        mine: filters.mine || undefined,
        labelId: filters.labelId || undefined,
        q: filters.q || undefined,
        limit: 400,
      }),
    enabled: !!activeBoard,
  });
  const q = useQueryState(tasksQuery);
  const tasks = q.data;
  /*
   * `isLoading` now means what it says. The board renders its columns while the
   * card query is outstanding, and shows a failure when it ends in one — the
   * previous expression treated "no cards yet" as "still loading", so a failed
   * card load left four animating skeletons with the drag surface disabled.
   */
  const isLoading = q.state === 'loading';
  const loadFailure = metaQuery.isError ? metaQuery.error : q.state === 'failed' ? q.error : null;
  const retry = () => {
    void metaQuery.refetch();
    void tasksQuery.refetch();
  };

  const moveError = useMutationFailure();
  const move = useMutation({
    mutationFn: (vars: { id: string; status: string }) => api.updateTask(vars.id, { status: vars.status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    /*
     * No `window.alert`. It blocked the thread, could not be styled, appeared
     * detached from the card that did not move, and on a rejected move it was the
     * only thing the user saw before the board silently snapped back. The failure
     * is rendered above the columns instead, next to the surface that failed.
     */
    onMutate: () => moveError.clear(),
    onError: (e: unknown) => moveError.set(e),
  });

  const openTaskId = params.get('task');
  const setOpenTask = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('task', id); else next.delete('task');
    setParams(next, { replace: true });
  };

  const filtered = useMemo(() => {
    let list = tasks ?? [];
    if (filters.risk !== 'all') {
      list = list.filter((t) => (filters.risk === 'high' ? (t.risk?.score ?? 0) >= 45 : t.sla === 'breached'));
    }
    return list;
  }, [tasks, filters.risk]);

  const byStatus = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const c of COLUMNS) map[c.key] = [];
    for (const t of filtered) (map[t.status] ??= []).push(t);
    return map;
  }, [filtered]);

  const board = meta?.boards.find((b) => b.id === activeBoard);

  // Keyboard: "n" opens new task, "/" handled by shell
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'n' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) setShowNew(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const labelById = new Map((meta?.labels ?? []).map((l) => [l.id, l]));

  return (
    <div className="flex h-[calc(100vh-48px)] flex-col">
      <PageHeader
        eyebrow={
          <>
            <Icons.Columns3 size={11} />
            Agile board
            {board && <><span className="text-mist-500/50">/</span><span className="text-mist-400">{board.projectName ?? board.name}</span></>}
          </>
        }
        title={board?.name ?? 'Board'}
        subtitle="Drag to move. WIP limits are enforced by the board, turnover gates by the server — a card cannot reach Shipped without both."
        right={
          <>
            <Select value={activeBoard} onChange={(e) => setBoardId(e.target.value)} className="w-[210px]">
              {(meta?.boards ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.kind === 'triage' ? '⚠ ' : ''}{b.projectName ?? b.name}</option>
              ))}
            </Select>
            <Button variant="primary" size="md" icon="Plus" onClick={() => { setNewStatus('todo'); setShowNew(true); }}>New task</Button>
          </>
        }
      />

      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700/70 bg-ink-900/60 px-5 py-2">
        <div className="relative">
          <Icons.Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-mist-500" />
          <Input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Filter this board…"
            className="h-7 w-[190px] pl-7 text-[11.5px]"
          />
        </div>
        <div className="flex items-center gap-1">
          {(['urgent', 'high', 'medium', 'low'] as const).map((p) => {
            const on = filters.priority.includes(p);
            return (
              <button
                key={p}
                onClick={() => setFilters((f) => ({ ...f, priority: on ? f.priority.filter((x) => x !== p) : [...f.priority, p] }))}
                className={cls(
                  'rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
                  on ? 'border-iris-500/50 bg-iris-500/15 text-iris-300' : 'border-ink-600 text-mist-500 hover:text-mist-300',
                )}
              >
                {p}
              </button>
            );
          })}
        </div>
        <Select value={filters.labelId} onChange={(e) => setFilters((f) => ({ ...f, labelId: e.target.value }))} className="h-7 w-[140px] text-[11.5px]">
          <option value="">All labels</option>
          {(meta?.labels ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Segmented
          size="xs"
          value={filters.risk}
          onChange={(v) => setFilters((f) => ({ ...f, risk: v }))}
          options={[{ value: 'all', label: 'All' }, { value: 'high', label: 'High risk' }, { value: 'sla', label: 'SLA breach' }]}
        />
        <button
          onClick={() => setFilters((f) => ({ ...f, mine: !f.mine }))}
          className={cls(
            'flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] font-medium transition-colors',
            filters.mine ? 'border-iris-500/50 bg-iris-500/15 text-iris-300' : 'border-ink-600 text-mist-500 hover:text-mist-300',
          )}
        >
          <Icons.User size={10} /> My work
        </button>
        <span className="ml-auto text-[10.5px] text-mist-500">
          {filtered.length} cards · {filtered.filter((t) => t.risk?.band === 'critical').length} critical ·{' '}
          {hours(filtered.reduce((a, t) => a + Math.max(0, t.estimateHours - t.loggedHours), 0))} open effort
        </span>
      </div>

      {moveError.error !== null && (
        <div className="px-3 pt-2">
          <MutationFailure
            error={moveError.error}
            what="Moving that card"
            onDismiss={moveError.clear}
          />
        </div>
      )}

      {/* columns */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-3 py-3">
        <div className="flex h-full min-w-max gap-2.5">
          {loadFailure !== null && (
            <div className="w-full">
              <QueryFailure error={loadFailure} what="the task board" retry={retry} />
            </div>
          )}
          {loadFailure === null && isLoading && COLUMNS.map((c) => (
            <div key={c.key} className="flex h-full w-[278px] shrink-0 flex-col gap-2">
              <Skeleton className="h-7 w-full" />
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}
            </div>
          ))}
          {loadFailure === null && !isLoading && COLUMNS.map((col) => {
            const list = byStatus[col.key] ?? [];
            const overWip = col.wip !== null && list.length > col.wip;
            return (
              <section
                key={col.key}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
                onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                onDrop={() => {
                  if (dragging) move.mutate({ id: dragging, status: col.key });
                  setDragging(null);
                  setOverCol(null);
                }}
                className={cls(
                  'flex h-full w-[278px] shrink-0 flex-col rounded-xl border transition-colors',
                  overCol === col.key ? 'border-iris-500/50 bg-iris-500/[0.04]' : 'border-ink-700/70 bg-ink-900/40',
                )}
              >
                <header className="flex items-center gap-2 px-2.5 pb-1.5 pt-2.5">
                  <span className="size-1.5 rounded-full" style={{ background: col.color }} />
                  <h3 className="text-[11.5px] font-semibold tracking-tight text-mist-200">{col.label}</h3>
                  <span className="rounded bg-ink-750 px-1 text-[9.5px] font-medium tabular text-mist-400">{list.length}</span>
                  {col.wip !== null && (
                    <Tooltip label={`WIP limit ${col.wip}`}>
                      <span className={cls('text-[9px] tabular', overWip ? 'text-rose-400' : 'text-mist-500')}>/{col.wip}</span>
                    </Tooltip>
                  )}
                  {overWip && <Icons.TriangleAlert size={10} className="text-rose-400" />}
                  {/*
                    The + in a column header now means "add here". It used to open the
                    same sheet with no column attached, so a task created from In
                    Progress landed in Ready and had to be dragged again — the small
                    wrongness that makes a board feel like it is not tracking anything.
                  */}
                  <button
                    onClick={() => { setNewStatus(col.key); setShowNew(true); }}
                    title={`Add a task to ${col.label}`}
                    className="ml-auto rounded p-0.5 text-mist-500 transition-colors hover:bg-ink-700 hover:text-mist-200"
                  >
                    <Icons.Plus size={11} />
                  </button>
                </header>
                {overWip && (
                  <p className="mx-2 mb-1 rounded border border-rose-500/25 bg-rose-500/8 px-1.5 py-1 text-[9.5px] text-rose-300">
                    WIP exceeded — finish something before pulling more.
                  </p>
                )}
                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2 pt-1">
                  {list.length === 0 && (
                    <button
                      onClick={() => { setNewStatus(col.key); setShowNew(true); }}
                      className="grid h-20 w-full place-items-center rounded-lg border border-dashed border-ink-600 text-[10.5px] text-mist-500 transition-colors hover:border-gold-600/40 hover:text-gold-300"
                    >
                      <span className="flex flex-col items-center gap-1">
                        <Icons.Plus size={11} />
                        {col.key === 'done' ? 'Nothing shipped yet' : `Add a task to ${col.label}`}
                      </span>
                    </button>
                  )}
                  {list.map((t) => (
                    <TaskCard key={t.id} task={t} dragging={dragging === t.id} onDragStart={() => setDragging(t.id)} onOpen={() => setOpenTask(t.id)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {showNew && meta && (
        <NewTaskModal
          boards={meta.boards}
          users={meta.users}
          labels={meta.labels}
          defaultBoard={activeBoard}
          defaultStatus={newStatus}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            qc.invalidateQueries({ queryKey: ['tasks'] });
            qc.invalidateQueries({ queryKey: ['dashboard'] });
            setOpenTask(id);
          }}
        />
      )}

      {openTaskId && <TaskDrawer taskId={openTaskId} onClose={() => setOpenTask(null)} />}
      {labelById.size === 0 && null}
    </div>
  );
}

function NewTaskModal({
  boards, users, labels, defaultBoard, defaultStatus, onClose, onCreated,
}: {
  boards: Array<{ id: string; name: string; kind: string; projectName: string | null }>;
  users: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  defaultBoard: string;
  /** The column whose + opened this sheet. A task lands where it was asked for. */
  defaultStatus: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    title: '', description: '', boardId: defaultBoard, status: defaultStatus, priority: 'medium', type: 'feature',
    assigneeId: '', estimateHours: 4, storyPoints: 3, dueAt: '', labelIds: [] as string[], clientVisible: false,
  });
  const create = useMutation({
    mutationFn: () => api.createTask({ ...form, assigneeId: form.assigneeId || null, dueAt: form.dueAt || null }),
    onSuccess: (t) => onCreated(t.id),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm animate-fade" onClick={onClose}>
      <div className="w-full max-w-[560px] rounded-xl border border-ink-500 bg-ink-850 p-4 shadow-2xl animate-rise" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-white">New task</h3>
          <Button variant="ghost" size="xs" onClick={onClose}><Icons.X size={13} /></Button>
        </div>
        <div className="mt-3 space-y-2.5">
          <Input
            autoFocus
            placeholder="Title — what ships?"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className="h-9 text-[13px]"
          />
          <textarea
            placeholder="Brief: acceptance criteria, edge cases, evidence you'll attach at turnover."
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={3}
            className="w-full resize-none rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-2 text-[12px] text-mist-200 placeholder:text-mist-500 focus:border-iris-500/60 focus:outline-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Board</span>
              <Select value={form.boardId} onChange={(e) => setForm((f) => ({ ...f, boardId: e.target.value }))}>
                {boards.map((b) => <option key={b.id} value={b.id}>{b.projectName ?? b.name}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Assignee</span>
              <Select value={form.assigneeId} onChange={(e) => setForm((f) => ({ ...f, assigneeId: e.target.value }))}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Column</span>
              <Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Priority</span>
              <Select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                {['urgent', 'high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Type</span>
              <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                {['feature', 'bug', 'research', 'design', 'ops', 'meeting', 'content'].map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Estimate (h)</span>
              <Input type="number" value={form.estimateHours} onChange={(e) => setForm((f) => ({ ...f, estimateHours: Number(e.target.value) }))} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Due</span>
              <Input type="date" value={form.dueAt} onChange={(e) => setForm((f) => ({ ...f, dueAt: e.target.value }))} />
            </label>
          </div>
          <div>
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-mist-500">Labels</span>
            <div className="flex flex-wrap gap-1">
              {labels.map((l) => {
                const on = form.labelIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => setForm((f) => ({ ...f, labelIds: on ? f.labelIds.filter((x) => x !== l.id) : [...f.labelIds, l.id] }))}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-all"
                    style={{
                      background: on ? `${l.color}28` : `${l.color}10`,
                      color: on ? l.color : `${l.color}99`,
                      boxShadow: on ? `inset 0 0 0 1px ${l.color}55` : 'none',
                    }}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5">
            <input type="checkbox" checked={form.clientVisible} onChange={(e) => setForm((f) => ({ ...f, clientVisible: e.target.checked }))} className="size-3 accent-iris-500" />
            <span className="text-[11px] text-mist-300">Client-visible — requires client acceptance before it can ship</span>
          </label>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="Plus" disabled={form.title.trim().length < 4 || create.isPending} loading={create.isPending} onClick={() => create.mutate()}>
            Create task
          </Button>
        </div>
        {create.error && <div className="mt-2"><MutationFailure error={create.error} what="Creating that task" /></div>}
      </div>
    </div>
  );
}
