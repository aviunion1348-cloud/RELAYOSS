/**
 * One decision, stated once: is this screen waiting, broken, or empty?
 *
 * Every screen in this application used to answer that question with a single
 * expression:
 *
 *     if (isLoading || !data) return <Skeleton />;
 *
 * The second half of that condition is the bug. `!data` is true when a request
 * is *in flight*, but it is equally true when a request has **failed** — and a
 * failed request never produces data. So a screen whose single query errored
 * (a 503 from an unseeded database, a 502 from a proxy, a dropped connection, a
 * DNS failure on a bad deploy) rendered its skeleton forever. To a person
 * looking at the product that is indistinguishable from "still loading": the
 * dashboard opens, the sidebar works, and every panel buffers and never
 * resolves. There was no timeout to end it and no error state to end it.
 *
 * This module makes the three states distinct so a screen cannot confuse them:
 *
 *   loading   nothing yet, and nothing has gone wrong — render the skeleton;
 *   failed    the request ended in an error — render the error and a retry,
 *             never a skeleton;
 *   ready     data arrived (possibly an empty list, which is a real answer).
 *
 * Screens use it as `useQueryState(query)` and branch on `.state`, which is
 * exhaustive: there is no fourth case in which a skeleton can outlive its query.
 */
import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

export type QueryState<T> =
  /** First load, nothing to show, nothing wrong. */
  | { state: 'loading'; isLoading: true; data: undefined; error: null; refetch: () => void }
  /** Terminal failure with no data to fall back on. */
  | { state: 'failed'; isLoading: false; data: undefined; error: unknown; refetch: () => void }
  /** Data is present. `isError` is still possible here: a background refetch failed. */
  | { state: 'ready'; isLoading: false; data: T; error: unknown; refetch: () => void };

/**
 * Classify a query.
 *
 * `isPending`/`isLoading` alone are not enough to call a query "loading": React
 * Query reports `isLoading` only while a request is genuinely outstanding, but
 * callers historically read the absence of data as "loading" too. This function
 * is the place that reads the distinction, so no screen has to.
 *
 * A query with `enabled: false` is pending and *not* loading and has no error —
 * for example a project detail route whose `id` has not resolved yet. That is
 * reported as `loading` deliberately: it is a transient state that resolves on
 * its own, and a screen that showed an error there would flash.
 */
export function useQueryState<T>(query: UseQueryResult<T>): QueryState<T> {
  const refetch = () => {
    void query.refetch();
  };

  if (query.data !== undefined && query.data !== null) {
    return { state: 'ready', isLoading: false, data: query.data as T, error: query.error, refetch };
  }

  /*
   * Order matters. An error is checked before the loading flags because React
   * Query can hold both at once: during a retry after a failure `isLoading` is
   * true *and* `error` is set. Reporting that as "loading" is what let a retry
   * loop present as an endless skeleton, so an error always wins the branch.
   */
  if (query.error !== null && query.error !== undefined) {
    return { state: 'failed', isLoading: false, data: undefined, error: query.error, refetch };
  }

  return { state: 'loading', isLoading: true, data: undefined, error: null, refetch };
}

/** The same classification for a query whose result is not used directly. */
export function hasFailed(query: { error: unknown; data: unknown }): boolean {
  return (query.error !== null && query.error !== undefined) && (query.data === undefined || query.data === null);
}

/**
 * Track a mutation's failure so the screen can say what went wrong.
 *
 * React Query keeps a mutation's error on the mutation object, but a component
 * that never reads `.error` silently discards it: the button returns to its
 * resting state, nothing changed on the server, and the reader concludes the
 * click worked. That is the write-path twin of the endless skeleton — same
 * defect, different symptom ("nothing happens when I click").
 *
 * This hook makes the failure visible and sets it back to `null` as soon as the
 * next attempt starts, so a stale message cannot outlive its attempt.
 */
export function useMutationFailure(): {
  error: unknown;
  set: (error: unknown) => void;
  clear: () => void;
} {
  const [error, setError] = useState<unknown>(null);
  return {
    error,
    set: (next: unknown) => setError(next ?? new Error('The request failed without a reason.')),
    clear: () => setError(null),
  };
}
