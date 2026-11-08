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
import { ApiError, isMisconfigured, type MisconfiguredDetail } from '../lib/api';
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

/** `fetch` rejects with a TypeError when the request never completed. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch|network/i.test(error.message));
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
    return (
      <Shell>
        <Line>
          <span className="font-medium">Could not reach the API.</span> {what} The request never
          completed, so this is a network or routing fault rather than a rejected request.
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
