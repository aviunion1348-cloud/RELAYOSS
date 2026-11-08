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
import { useState } from 'react';
import { Icons } from './icons';
import { ApiFailure } from './ApiFailure';

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
