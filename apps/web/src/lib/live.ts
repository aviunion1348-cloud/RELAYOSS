/**
 * Live updates, without a second transport.
 *
 * The product is a shared workspace: someone edits a client while you are looking at
 * the dashboard, and the numbers you are reading are now wrong. Every screen used to
 * learn about that only when you navigated, or polled its own endpoint on its own
 * timer — which is N requests per interval, and still leaves the reader on stale
 * numbers until their particular timer fires.
 *
 * So the question is asked once and cheaply. Every mutation already writes an
 * `audit_log` row, and that table's integer id is monotonic, so `MAX(id)` is a
 * complete version counter for the whole database. One indexed read answers "has
 * anything changed since the last id I saw", and this hook turns a change in that
 * counter into invalidation of exactly the queries whose entity type was written.
 *
 * Why not websockets or SSE:
 *
 *   - they are a second transport to operate, authenticate, reconnect and back off;
 *   - the deployment is a serverless function, where a long-lived connection is the
 *     one thing the runtime will not keep;
 *   - the payload here is an integer. Polling it is correct on every platform, and
 *     the cost is one indexed scan per interval.
 *
 * The interval is deliberately visible and deliberately modest. This is a workspace
 * for a delivery team, not a trading floor: five seconds is fast enough that a change
 * appears while you are still looking at the screen it affects, and slow enough that
 * leaving twenty tabs open costs nothing anyone notices.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/** How often the version counter is read. */
const POLL_MS = 5_000;

/**
 * Which query keys are affected by a written entity type.
 *
 * This table is the difference between "live" and "reload the world". A task write
 * touches the board, the dashboard aggregates, the intelligence findings and search —
 * but not the knowledge base or the partner console, so those are left alone and do
 * not flicker. Anything not listed is refreshed conservatively, because a stale
 * screen is a worse bug than a redundant fetch.
 */
const AFFECTED: Record<string, string[]> = {
  task: ['tasks', 'dashboard', 'insights', 'search', 'activity', 'workload', 'planner'],
  comment: ['tasks', 'activity', 'search'],
  client: ['clients', 'dashboard', 'pipeline', 'search'],
  deal: ['pipeline', 'dashboard', 'clients', 'search'],
  project: ['projects', 'dashboard', 'search', 'workload', 'releases', 'qa'],
  doc: ['docs', 'search', 'dashboard'],
  partner: ['partners', 'dashboard'],
  device_license: ['partners'],
  release: ['releases', 'dashboard'],
  qa_report: ['qa', 'releases', 'dashboard'],
  insight_dismissal: ['insights'],
  insight: ['insights'],
  timer: ['clocks', 'dashboard', 'tasks'],
  clock: ['clocks', 'dashboard'],
  change_request: ['qa', 'projects', 'dashboard'],
  legal_document: ['docs', 'projects'],
  meeting: ['dashboard', 'pipeline'],
  thread: ['docs', 'dashboard'],
};

/** Everything, for an entity type this table has not been taught about. */
const EVERYTHING = ['tasks', 'dashboard', 'insights', 'search', 'activity'];

export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  /** The last version this tab has accounted for. */
  const seen = useRef<number | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      // Never stack requests: a slow network must not queue up polls behind itself.
      if (inFlight.current || document.hidden) return;
      inFlight.current = true;
      try {
        const res = await api.changes(seen.current ?? 0);
        if (cancelled) return;

        const first = seen.current === null;
        seen.current = res.latestId;

        /*
         * The first poll only establishes the baseline. Without this, opening the app
         * would mark every row ever written as new and refetch everything once, which
         * is a visible flash for no benefit.
         */
        if (first || res.writes === 0) return;

        const keys = new Set<string>();
        for (const entity of res.changed) {
          for (const key of AFFECTED[entity] ?? EVERYTHING) keys.add(key);
        }
        for (const key of keys) {
          void qc.invalidateQueries({ queryKey: [key] });
        }
      } catch {
        /*
         * A failed poll is not an error state for the screen. The data on it is still
         * whatever the last successful fetch returned, and the screens have their own
         * failure handling for a request that actually matters. Swallowing this keeps a
         * blip in the version check from replacing a working page with an error panel.
         */
      } finally {
        inFlight.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(tick, POLL_MS);

    /*
     * A background tab does not need to poll, and coming back should not wait for the
     * next interval: `visibilitychange` catches up immediately, which is the moment a
     * person actually looks at the numbers again.
     */
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, qc]);
}
