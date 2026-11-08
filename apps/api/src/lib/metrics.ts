/**
 * Operational metrics.
 *
 * Deliberately dependency-free and Prometheus-text-format compatible: an
 * internal tool should not need a metrics SDK to answer "are we breaching SLAs
 * and is the sweeper alive". Business gauges are computed from the database on
 * scrape (they are the numbers the delivery leads actually run the studio on),
 * and process counters are maintained in memory.
 *
 * Cardinality is bounded by construction: label values come from fixed
 * enumerations (route template, status class, clock key), never from user input.
 */

export interface Counter {
  name: string;
  help: string;
  labels: Record<string, string>;
  value: number;
}

const counters = new Map<string, Counter>();
const gauges = new Map<string, { name: string; help: string; value: number }>();

function key(name: string, labels: Record<string, string>) {
  return `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
}

export function inc(name: string, labels: Record<string, string> = {}, by = 1, help = '') {
  const id = key(name, labels);
  const existing = counters.get(id);
  if (existing) existing.value += by;
  else counters.set(id, { name, help: help || name, labels, value: by });
}

export function setGauge(name: string, value: number, help = '') {
  gauges.set(name, { name, help: help || name, value });
}

/** Escape per the Prometheus text exposition format. */
function esc(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelString(labels: Record<string, string>) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;
}

/** Group counters by metric name so the HELP/TYPE lines are emitted once. */
export function renderMetrics(): string {
  const lines: string[] = [];
  const byName = new Map<string, Counter[]>();
  for (const counter of counters.values()) {
    const bucket = byName.get(counter.name) ?? [];
    bucket.push(counter);
    byName.set(counter.name, bucket);
  }
  for (const [name, bucket] of [...byName.entries()].sort()) {
    lines.push(`# HELP ${name} ${bucket[0].help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const c of bucket) lines.push(`${name}${labelString(c.labels)} ${c.value}`);
  }
  for (const g of [...gauges.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    lines.push(`${g.name} ${g.value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetrics() {
  counters.clear();
  gauges.clear();
}

/**
 * Collapse a concrete URL into a route template so metric cardinality does not
 * grow with the number of tasks: `/api/tasks/tsk_8fj2` → `/api/tasks/:id`.
 */
export function routeTemplate(url: string): string {
  const path = url.split('?')[0];
  return path
    .replace(/\/[a-z]{2,4}_[A-Za-z0-9]{6,}/g, '/:id')
    .replace(/\/\d+/g, '/:n');
}

/** Shared worker health, updated by the sweeper loop. */
const worker = { sweeps: 0, failures: 0, running: false, lastRunAt: null as number | null };

export function recordSweep(result: { count: number; failed?: boolean }) {
  if (result.failed) worker.failures += 1;
  else worker.sweeps += 1;
  worker.running = false;
  worker.lastRunAt = Date.now();
  inc('relay_clock_sweep_events_total', { outcome: result.failed ? 'error' : 'ok' });
  inc('relay_clock_swept_total', {}, result.count);
}

export function setSweepRunning(running: boolean) {
  worker.running = running;
}

export function sweeperStats() {
  return { ...worker };
}
