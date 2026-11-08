/** Tiny id + date helpers (ULID-ish, sortable, no dependency). */
import { toDate } from './dates.ts';
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function id(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  let rand = '';
  for (let i = 0; i < 8; i++) rand += ALPHABET[Math.floor(Math.random() * 32)];
  return `${prefix}_${ts}${rand}`;
}

export function nowIso(): string {
  return nowIsoAt(Date.now());
}

/**
 * The same storage format for an arbitrary instant.
 *
 * Exists so nothing has to hand-roll it: every timestamp column in this schema is
 * `YYYY-MM-DD HH:MM:SS` UTC, and mixing in an ISO string with a `T` silently breaks
 * any string comparison — `' '` sorts before `'T'`, so an ISO value compares as
 * earlier than a storage value from the same second.
 */
export function nowIsoAt(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(base: Date | string, days: number): Date {
  const d = toDate(base) ?? new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Fractional ordering between two positions (Figma/Linear style). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1000;
  if (before === null) return (after as number) - 1000;
  if (after === null) return before + 1000;
  return (before + after) / 2;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
