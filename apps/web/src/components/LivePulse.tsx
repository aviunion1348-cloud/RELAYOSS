/**
 * A visible heartbeat for the live feed.
 *
 * Background synchronisation that nobody can see is indistinguishable from
 * background synchronisation that has silently stopped — and a stale dashboard is
 * worse than one that says it is stale, because the person reading it has no reason
 * to doubt it.
 *
 * So this shows three states, each of them honest:
 *
 *   live      the version counter is being read and last read succeeded
 *   caught up  something changed elsewhere and the affected screens were refreshed
 *   offline   the last read failed; the numbers on screen may be out of date
 *
 * It is a status indicator, not a control. A manual refresh button would imply the
 * feed needs help; it does not, and offering it would make people distrust the
 * automatic path.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icons } from './icons';
import { api } from '../lib/api';
import { cls } from '../lib/cls';

export function LivePulse({ enabled = true }: { enabled?: boolean }) {
  const [updating, setUpdating] = useState(false);

  /*
   * The same counter the feed polls, on a slower interval, purely for display. It is
   * a separate query rather than shared state so this component stays readable: the
   * feed's job is invalidation, this component's job is to say whether the feed is
   * healthy, and neither should have to know about the other's internals.
   */
  const { data, isError } = useQuery({
    queryKey: ['live-pulse'],
    queryFn: () => api.changes(0),
    refetchInterval: 10_000,
    enabled,
    // A pulse that shows a spinner in the corner on every poll would be noise.
    retry: false,
  });

  useEffect(() => {
    if (!data) return;
    setUpdating(true);
    const timer = window.setTimeout(() => setUpdating(false), 1200);
    return () => window.clearTimeout(timer);
  }, [data?.latestId]);

  if (!enabled) return null;

  const tone = isError ? 'offline' : updating ? 'fresh' : 'live';
  const label = isError ? 'offline' : updating ? 'updated' : 'live';

  return (
    <span
      title={
        isError
          ? 'The change feed is not reachable, so what is on screen may be out of date.'
          : 'Changes made anywhere in the workspace appear on these screens automatically.'
      }
      className={cls(
        'hidden items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.08em] sm:flex',
        tone === 'offline' && 'border-rose-500/35 bg-rose-500/[0.07] text-rose-300',
        tone === 'fresh' && 'border-gold-600/40 bg-gold-500/[0.08] text-gold-300',
        tone === 'live' && 'border-ink-600 bg-ink-850 text-mist-500',
      )}
    >
      {isError
        ? <Icons.Cloud size={9} />
        : updating
          ? <Icons.RefreshCw size={9} className="animate-spin" />
          : <span className="size-1.5 rounded-full bg-mint-400 shadow-[0_0_6px_0_rgb(34_201_138/0.8)]" />}
      {label}
    </span>
  );
}
