/**
 * What a screen shows when its data did not arrive.
 *
 * This is the other half of `lib/query-state.ts`. A failed query used to render
 * a skeleton, which is the one thing a failure must never look like: the
 * skeleton animates, so the screen appears to be working, and the person
 * waits instead of reloading or reporting. Everything here exists to make the
 * failure unmistakable and immediately actionable:
 *
 *   - it says the load failed, in words, not just with an icon;
 *   - it prints the actual reason (status, code, message) rather than a
 *     reassuring generic;
 *   - it offers a retry that re-runs that exact query;
 *   - it keeps the page header above it, so the shell and navigation stay
 *     usable while one panel is broken.
 *
 * The specific remediation text is delegated to `ApiFailure`, which already
 * distinguishes "the API refused to start because its environment is
 * incomplete" from "the API never answered" from "the API rejected this".
 */
import { useEffect, useState } from 'react';
import { Icons } from './icons';
import { ApiFailure } from './ApiFailure';
import { NetworkError } from '../lib/api';
import { diagnoseApiFailure, type Diagnosis } from '../lib/diagnose';

export function QueryFailure({
  error,
  what,
  retry,
  compact,
}: {
  error: unknown;
  /** What was being loaded, lower-case and noun-like: "the task board". */
  what: string;
  /** Re-runs the query. Wired to React Query's `refetch`. */
  retry?: () => void;
  /** Trimmed padding for a panel inside a larger page. */
  compact?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  /*
   * Diagnose, do not merely report.
   *
   * "The request never reached the server" is true for half a dozen different
   * faults and leads to a different fix for each. Once the screen has failed, one
   * cheap probe turns the browser's generic TypeError into a named cause with
   * instructions. It runs after the failure, so it costs nothing on the happy
   * path.
   */
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  useEffect(() => {
    let live = true;
    // Only worth asking when the failure was a transport failure rather than a
    // status the API itself returned and explained.
    const transport = error instanceof TypeError || error instanceof NetworkError;
    if (!transport) return;
    void diagnoseApiFailure().then((d) => {
      if (live) setDiagnosis(d);
    });
    return () => {
      live = false;
    };
  }, [error]);

  async function run() {
    if (!retry) return;
    setRetrying(true);
    try {
      await retry();
    } finally {
      /*
       * Always released. `refetch` resolves even when the retry fails, but a
       * throw from a misconfigured query function must not leave the button
       * stuck in "Retrying…" — that would reproduce the same dead end in
       * miniature.
       */
      setRetrying(false);
    }
  }

  return (
    <div className={compact ? 'p-2.5' : 'p-5'}>
      <div className="surface rounded-xl p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/25">
            <Icons.AlertTriangle size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-mist-100">Could not load {what}.</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-mist-500">
              This is shown instead of a loading placeholder on purpose: the request
              finished, and it failed. Retrying is safe — nothing was changed.
            </p>

            <div className="mt-2.5">
              <ApiFailure error={error} what={`Could not load ${what}.`} />
            </div>

            {diagnosis && <DiagnosisPanel diagnosis={diagnosis} />}

            {retry && (
              <button
                type="button"
                onClick={() => void run()}
                disabled={retrying}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[11.5px] font-medium text-mist-200 transition-colors hover:border-gold-600/50 hover:bg-ink-750 disabled:opacity-60"
              >
                <Icons.RotateCw size={12} className={retrying ? 'animate-spin' : undefined} />
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A background refetch that failed while data is still on screen.
 *
 * Deliberately small: the numbers below it are real, just old. Replacing the
 * panel with a full error would discard information the reader can still use,
 * so this only states that the page is no longer live.
 */
export function StaleNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const reason = error instanceof Error ? error.message : 'the last refresh failed';
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-200/90">
      <Icons.AlertTriangle size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Showing the last successful result — refreshing now fails: {reason}
      </span>
      {retry && (
        <button
          type="button"
          onClick={() => void retry()}
          className="shrink-0 rounded-md border border-amber-500/30 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-200 hover:bg-amber-500/10"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * A write that did not happen.
 *
 * Reads and writes fail differently in a way that matters: a failed read shows
 * you a stale or empty screen, but a failed write shows you an *unchanged* one,
 * which looks exactly like a successful no-op. Drag a card and it snaps back;
 * press "Mark verified" and the badge stays put. Without a message the reader
 * cannot tell a refused write from a slow one, and will usually click again.
 *
 * The message is rendered where the control is, stays until dismissed or until
 * the next attempt starts, and states that nothing was changed — which is the
 * fact the reader actually needs.
 */
export function MutationFailure({ error, what, onDismiss }: { error: unknown; what: string; onDismiss?: () => void }) {
  if (!error) return null;
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status: number }).status : null;
  const message = error instanceof Error && error.message ? error.message : 'The request failed.';
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-2.5 py-2 text-[11px] text-rose-200">
      <Icons.AlertCircle size={12} className="mt-0.5 shrink-0 text-rose-400" />
      <span className="min-w-0 flex-1 leading-relaxed">
        <span className="font-medium">{what} failed{status ? ` (${status})` : ''}.</span> {message}{' '}
        <span className="text-rose-300/70">Nothing was changed.</span>
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-rose-300/70 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <Icons.X size={11} />
        </button>
      )}
    </div>
  );
}


/**
 * The verdict from `diagnoseApiFailure`, shown as a checklist.
 *
 * Deliberately not a paragraph: the reader is already in a failure state, and
 * what they need is the one cause that applies and the two or three actions that
 * follow from it. The raw evidence sits underneath, collapsed, for the case where
 * the verdict is wrong.
 */
function DiagnosisPanel({ diagnosis }: { diagnosis: Diagnosis }) {
  const healthy = diagnosis.code === 'api-ok';
  return (
    <div
      className={
        healthy
          ? 'mt-2.5 rounded-lg border border-mint-500/30 bg-mint-500/[0.06] p-3'
          : 'mt-2.5 rounded-lg border border-gold-600/35 bg-gold-500/[0.05] p-3'
      }
    >
      <p className="flex items-start gap-2 text-[11.5px] font-medium leading-relaxed text-mist-100">
        <Icons.Info size={13} className={healthy ? 'mt-0.5 shrink-0 text-mint-400' : 'mt-0.5 shrink-0 text-gold-400'} />
        <span>
          <span className="text-gold-300">Diagnosis · {diagnosis.code}</span>
          <span className="mt-1 block font-normal text-mist-300">{diagnosis.summary}</span>
        </span>
      </p>

      {!healthy && diagnosis.remedies.length > 0 && (
        <ol className="mt-2.5 space-y-1.5 pl-1">
          {diagnosis.remedies.map((step, i) => (
            <li key={step} className="flex gap-2 text-[11px] leading-relaxed text-mist-400">
              <span className="mt-[2px] grid size-4 shrink-0 place-items-center rounded-full border border-gold-600/40 bg-gold-500/10 text-[9px] font-semibold text-gold-300">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}

      <details className="mt-2.5">
        <summary className="cursor-pointer text-[10.5px] text-mist-500 hover:text-mist-300">
          Evidence
        </summary>
        <ul className="mt-1.5 space-y-0.5 border-l border-ink-600 pl-2.5">
          {diagnosis.evidence.map((line) => (
            <li key={line} className="font-mono text-[10px] leading-relaxed text-mist-500">
              {line}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
