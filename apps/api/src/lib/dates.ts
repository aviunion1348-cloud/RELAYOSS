/**
 * Date handling.
 *
 * The database stores three shapes: `YYYY-MM-DD` (calendar dates),
 * `YYYY-MM-DD HH:MM:SS` (SQLite datetimes, UTC) and full ISO strings.
 * Naively doing `replace(' ', 'T') + 'Z'` corrupts the third shape and yields
 * Invalid Date, which silently disables overdue/SLA comparisons — a bug that
 * hides breaches. Everything goes through `toDate` instead.
 */

export function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();

  // Calendar date only → UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Already has an explicit zone / offset (…Z, +05:30).
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // SQLite datetime or ISO without a zone → treat as UTC.
  const d = new Date(raw.includes('T') ? `${raw}Z` : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function hoursBetween(a: string | Date | null | undefined, b: string | Date | null | undefined): number | null {
  const da = toDate(a);
  const dbb = toDate(b);
  if (!da || !dbb) return null;
  return (dbb.getTime() - da.getTime()) / 3_600_000;
}

export function daysLeft(value: string | Date | null | undefined, now: Date = new Date()): number | null {
  const d = toDate(value);
  if (!d) return null;
  return (d.getTime() - now.getTime()) / 86_400_000;
}

/** SQLite-friendly UTC timestamp. */
export function sqlNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}
