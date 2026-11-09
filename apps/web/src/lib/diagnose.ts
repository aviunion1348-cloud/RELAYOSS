/**
 * Why can this page not reach its own API?
 *
 * A red box saying "the request never reached the server" is truthful and
 * useless: it is the same sentence for six different faults with six different
 * fixes. This module runs one cheap probe when a screen has already failed, and
 * turns the browser's generic `TypeError` into a specific verdict.
 *
 * The probe is deliberately tiny — a `GET /api/health` with no cache — because it
 * runs exactly when the network is suspect. It never changes state, never
 * authenticates, and its failure is itself the answer.
 *
 * Everything here is evidence gathered from the browser, not a guess: the URL
 * probed, the status returned, the content type, and whether the body looked like
 * a document. The verdict is derived from that evidence and states which of the
 * plausible causes it can rule in or out.
 */

export type Diagnosis = {
  /** Machine-readable cause, used by tests and for stable rendering. */
  code:
    | 'api-ok'          // the probe succeeded — the failure was transient
    | 'not-json'        // /api answered, but with a document: misrouted
    | 'not-deployed'    // /api answered 404/405: nothing is serving it
    | 'server-error'    // /api answered 5xx
    | 'blocked'         // the request was refused before any response
    | 'offline';        // the browser itself reports no network
  /** One sentence a person can act on. */
  summary: string;
  /** The evidence the verdict rests on, shown verbatim. */
  evidence: string[];
  /** Ordered, concrete things to try. */
  remedies: string[];
};

const PROBE = '/api/health';

export async function diagnoseApiFailure(): Promise<Diagnosis> {
  const evidence: string[] = [
    `page origin: ${window.location.origin}`,
    `probed: ${PROBE}`,
    `browser online: ${navigator.onLine ? 'yes' : 'no'}`,
  ];

  if (!navigator.onLine) {
    return {
      code: 'offline',
      summary: 'This browser reports that it has no network connection.',
      evidence,
      remedies: [
        'Reconnect to a network and press Retry.',
        'If you are on a VPN or a corporate proxy, confirm it is connected — a proxy that is down looks exactly like this.',
      ],
    };
  }

  let response: Response;
  try {
    response = await fetch(PROBE, {
      method: 'GET',
      cache: 'no-store',
      // Same reasoning as the client: this product authenticates nothing by
      // cookie, and the probe must test the same contract the screens use.
      credentials: 'omit',
    });
  } catch (cause) {
    evidence.push(`probe threw: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
    return {
      code: 'blocked',
      summary:
        'The request was refused before any response arrived. Something between this browser and the server is blocking it — the API service is usually not the problem at this point.',
      evidence,
      remedies: [
        'Disable any ad-blocker, privacy extension or content blocker for this site, then press Retry. These routinely cancel requests to /api paths.',
        'If you are on a corporate network or VPN, try another network: a TLS-inspecting proxy rejects these requests and the browser reports it only as "Failed to fetch".',
        'Open /api/health directly in a new tab. If that also fails, the fault is between you and the host, not in this page.',
      ],
    };
  }

  const type = response.headers.get('content-type') ?? '(none)';
  evidence.push(`status: ${response.status}`);
  evidence.push(`content-type: ${type}`);

  if (response.status === 404 || response.status === 405) {
    return {
      code: 'not-deployed',
      summary:
        'This host answered, but there is no API at /api. The API service is almost certainly not deployed — the page was served without the backend that it needs.',
      evidence,
      remedies: [
        'On Vercel: the project Framework Preset must be "Services". With any other preset Vercel ignores the services block silently, builds only the frontend, and every /api call 404s like this.',
        'Confirm the "api" service appears in the build log. If the log shows a single root build, the services block was never read.',
        'Leave the project-level Build Command empty: a value there overrides the per-service build commands even in Services mode.',
      ],
    };
  }

  if (response.status >= 500) {
    const body = await response.text().catch(() => '');
    evidence.push(`body: ${body.slice(0, 160) || '(empty)'}`);
    return {
      code: 'server-error',
      summary: `The API is deployed but failing (HTTP ${response.status}). This is a server-side fault, not a browser one.`,
      evidence,
      remedies: [
        'Open the API service logs for this deployment and read the first error line.',
        'A 503 with a "misconfigured" body means a required environment variable is missing; the response names it.',
        'Press Retry after the service recovers — nothing in this page needs to change.',
      ],
    };
  }

  // A 2xx: what did it actually return?
  const body = await response.text().catch(() => '');
  const looksHtml = /^\s*<(?:!doctype|html)/i.test(body);
  if (looksHtml) {
    evidence.push('body begins with an HTML document');
    return {
      code: 'not-json',
      summary:
        'The API address is answering with the web page, not data. Traffic for /api is being routed to the frontend service instead of the API service.',
      evidence,
      remedies: [
        'Check the rewrite order: "/api/(.*)" must come before the catch-all, because the first match wins.',
        'Check that the /api rewrite targets the "api" service by name, exactly as declared in services.',
        'If this is a preview deployment, confirm both services built — a service that failed to build is silently absent from routing.',
      ],
    };
  }

  return {
    code: 'api-ok',
    summary:
      'The API answered this probe successfully, so the earlier failure was transient — a cold start, a dropped connection or a timeout.',
    evidence,
    remedies: ['Press Retry. Nothing is misconfigured.'],
  };
}
