/**
 * Why the application cannot be used, stated in one place.
 *
 * Three different failures reach the same screen and used to produce the same
 * wrong sentence ("is the API running on :4000?"):
 *
 *   misconfigured  the API started and refused to serve, because its environment
 *                  is incomplete. It knows exactly what is missing and says so.
 *   unreachable    the request never reached the API — wrong deployment, a build
 *                  that shipped without the service, a network fault.
 *   other          any other non-401 status.
 *
 * Only the middle case is a connectivity question, and only it should ever
 * suggest that the API is down. Conflating them sent a deployment problem
 * hunting for a missing server that was running the whole time.
 */
import type { ReactNode } from 'react';
import { ApiError, NetworkError, isMisconfigured, type MisconfiguredDetail } from '../lib/api';
import { Icons } from './icons';

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2.5 text-left">
      <Icons.AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-400" />
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
    </div>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <p className="text-[11.5px] leading-relaxed text-rose-200/90">{children}</p>;
}

/**
 * The request never produced a response.
 *
 * `NetworkError` is raised by the client itself, so it is authoritative — it
 * already says whether the deadline fired or the transport failed. The `TypeError`
 * branch stays for anything thrown by a `fetch` that did not go through
 * `request()` (and for React Query's own serialized copies in devtools).
 */
function isNetworkFailure(error: unknown): error is NetworkError | TypeError {
  return error instanceof NetworkError || error instanceof TypeError;
}

export function ApiFailure({ error, what }: { error: unknown; what: string }) {
  if (isMisconfigured(error)) {
    const details = (error as ApiError).details as MisconfiguredDetail;
    return (
      <Shell>
        <Line>
          <span className="font-medium">This deployment is not configured yet.</span>{' '}
          The API is running but refused to start, so it is serving no requests.
        </Line>
        {details.missing.length > 0 && (
          <Line>
            Missing:{' '}
            <span className="font-mono text-[11px] text-rose-100">{details.missing.join(', ')}</span>
          </Line>
        )}
        {(details.optional ?? []).length > 0 && (
          <Line>
            <span className="text-amber-200/80">Not set (optional):</span>{' '}
            {details.optional!.map((o, i) => (
              <span key={o.name}>
                {i > 0 ? ', ' : ''}
                <span className="font-mono text-[11px] text-amber-100/90">{o.name}</span>
              </span>
            ))}
            <span className="block pt-0.5 text-[11px] text-amber-200/60">
              {details.optional![0].consequence}
            </span>
          </Line>
        )}
        {details.invalid.map((i) => (
          <Line key={i.name}>
            <span className="font-mono text-[11px] text-rose-100">{i.name}</span> {i.problem}
          </Line>
        ))}
        {details.remedy.length > 0 && (
          <details className="pt-0.5">
            <summary className="cursor-pointer text-[11px] text-rose-300/80 underline-offset-2 hover:underline">
              How to fix this
            </summary>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-rose-200/80">
              {details.remedy.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        )}
        <Line>
          <span className="text-rose-300/70">Details are in docs/DEPLOYMENT.md §2. Nothing is wrong with this browser.</span>
        </Line>
      </Shell>
    );
  }

  if (isNetworkFailure(error)) {
    /*
     * A timeout and a transport failure are different faults with different
     * fixes, so they get different sentences. Collapsing them into "could not
     * reach the API" sent people to check connectivity for a request that had
     * reached the API and was simply never answered.
     */
    const timedOut = error instanceof NetworkError && error.code === 'timeout';
    return (
      <Shell>
        <Line>
          <span className="font-medium">
            {timedOut ? 'The server did not answer in time.' : 'Could not reach the API.'}
          </span>{' '}
          {error instanceof NetworkError ? error.message : `${what} The request never completed, so this is a network or routing fault rather than a rejected request.`}
        </Line>
        <Line>
          <span className="text-rose-300/70">
            {timedOut
              ? 'A request that is still running after 20 seconds is not slow, it is stuck. Retrying is safe.'
              : 'Nothing was changed. If this is a deployment, check that the API service is built and routable.'}
          </span>
        </Line>
      </Shell>
    );
  }

  if (error instanceof ApiError) {
    return (
      <Shell>
        <Line>
          <span className="font-medium">The API rejected the request</span> ({error.status}
          {error.code && error.code !== 'unknown' ? ` · ${error.code}` : ''}): {error.message}
        </Line>
      </Shell>
    );
  }

  return (
    <Shell>
      <Line>
        <span className="font-medium">{what}</span>{' '}
        {error instanceof Error ? error.message : 'An unexpected error occurred.'}
      </Line>
    </Shell>
  );
}
