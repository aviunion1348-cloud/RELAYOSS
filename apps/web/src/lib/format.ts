/** Formatting helpers shared across every surface. */

export function inr(cents: number, opts: { compact?: boolean } = {}): string {
  const value = cents / 100;
  if (opts.compact) {
    if (Math.abs(value) >= 1e7) return `₹${(value / 1e7).toFixed(2)}Cr`;
    if (Math.abs(value) >= 1e5) return `₹${(value / 1e5).toFixed(1)}L`;
    if (Math.abs(value) >= 1e3) return `₹${(value / 1e3).toFixed(0)}k`;
    return `₹${value.toFixed(0)}`;
  }
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
}

export function hours(h: number): string {
  if (h === 0) return '0h';
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${Math.round(h * 10) / 10}h`;
}

export function days(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n}d` : `${Math.abs(n)}d ago`;
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalised = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function shortDate(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function dateTime(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relTime(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 1) return 'just now';
  if (Math.abs(mins) < 60) return mins > 0 ? `${mins}m ago` : `in ${-mins}m`;
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 24) return hrs > 0 ? `${hrs}h ago` : `in ${-hrs}h`;
  const dd = Math.round(hrs / 24);
  if (Math.abs(dd) < 30) return dd > 0 ? `${dd}d ago` : `in ${-dd}d`;
  return shortDate(value);
}

export function dueTone(value: string | null | undefined): 'none' | 'ok' | 'soon' | 'late' {
  const d = parseDate(value);
  if (!d) return 'none';
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'late';
  if (diff < 2 * 86400000) return 'soon';
  return 'ok';
}

export function daysBetween(a: string | Date, b: string | Date = new Date()): number {
  const da = typeof a === 'string' ? parseDate(a) : a;
  const db = typeof b === 'string' ? parseDate(b) : b;
  if (!da || !db) return 0;
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

export function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

export function clockLabel(h: number): string {
  if (h < 0) return `${Math.abs(h).toFixed(0)}h over`;
  if (h < 1) return `${Math.round(h * 60)}m left`;
  if (h < 48) return `${h.toFixed(0)}h left`;
  return `${(h / 24).toFixed(1)}d left`;
}

export const PHASE_LABEL: Record<string, string> = {
  origin: 'Origin',
  discovery: 'Discovery',
  proposal: 'Proposal',
  delivery: 'Delivery',
  growth: 'Growth',
};
