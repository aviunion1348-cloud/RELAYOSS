/** Typed API error + async handler wrappers (Fastify-compatible). */
import type { FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, 'bad_request', m, d);
export const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
export const conflict = (m: string, d?: unknown) => new HttpError(409, 'conflict', m, d);
export const forbidden = (m = 'Not allowed') => new HttpError(403, 'forbidden', m);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, 'unauthorized', m);
export const tooMany = (m = 'Too many requests', retryAfterSec = 60) => {
  const err = new HttpError(429, 'rate_limited', m, { retryAfterSec });
  return err;
};
export const unavailable = (m = 'Service unavailable') => new HttpError(503, 'unavailable', m);
/**
 * A 503 that says *what* is misconfigured.
 *
 * `/api/ready` has always reported `{ stage, summary }` for a broken deployment;
 * request handlers had no equivalent and could only return a bare message. This
 * lets an identity failure name its cause and its remedy, instead of surfacing as
 * "unauthorized" — which is what the blank dashboard used to hide behind.
 */
export const serviceUnavailable = (m: string, details?: unknown) => new HttpError(503, 'misconfigured', m, details);
export const unprocessable = (m: string, d?: unknown) => new HttpError(422, 'unprocessable', m, d);

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

export function ok<T>(data: T) {
  return { data };
}

export function page<T>(items: T[], meta: { total: number; limit: number; offset: number }) {
  return { data: items, meta: { ...meta, hasMore: meta.offset + items.length < meta.total } };
}

export function queryInt(req: FastifyRequest, key: string, fallback: number): number {
  const raw = (req.query as Record<string, unknown>)?.[key];
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isNaN(n) ? fallback : n;
}

export function queryStr(req: FastifyRequest, key: string): string | undefined {
  const raw = (req.query as Record<string, unknown>)?.[key];
  if (raw === undefined || raw === '' || raw === 'null') return undefined;
  return String(raw);
}

export function queryList(req: FastifyRequest, key: string): string[] {
  const raw = (req.query as Record<string, unknown>)?.[key];
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Type guards for request bodies.
 *
 * A request body is untrusted input with no schema by default, so `body.title`
 * may be an array, an object, a number or absent. Calling `.trim()` on it throws
 * a TypeError, which surfaces as a 500 — the caller learns nothing and the server
 * looks broken. Each of these returns a 400 that names the field instead.
 *
 * These exist because the same crash appeared independently in every module that
 * added a handler: the fix belongs in one place, not in nine.
 */
export function requireString(value: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) {
    throw badRequest(`${field} must be at least ${opts.min} character${opts.min === 1 ? '' : 's'}`);
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw badRequest(`${field} must be at most ${opts.max} characters`);
  }
  return trimmed;
}

/** Optional string: absent and undefined pass through as undefined, anything else must be a string. */
export function optionalString(value: unknown, field: string, opts: { max?: number } = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  if (opts.max !== undefined && value.length > opts.max) throw badRequest(`${field} must be at most ${opts.max} characters`);
  return value;
}

/** A value that will be bound as a SQL parameter must be scalar. */
export function requireScalar(value: unknown, field: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw badRequest(`${field} must be a single value`);
}

export function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}
