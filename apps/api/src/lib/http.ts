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
