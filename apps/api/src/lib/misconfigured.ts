/**
 * Boot verification, and the report a deployment shows when it cannot work.
 *
 * A deployment can be built perfectly and still be unusable, because its
 * environment was never provisioned: no `DATABASE_URL`, no `SESSION_SECRET`, no
 * shared credential. That is an operator mistake, not a bug — and the server
 * already knew about it at boot, because `assertStaticAuthConfiguration()` throws
 * before the first connection is opened.
 *
 * The problem this module solves is that the knowledge was unreachable. The throw
 * happened while lazily constructing a module-level promise, so *every* request
 * rejected with a bare 500 `internal_error`, whose text is deliberately withheld
 * in production. The browser could only report "the API is unreachable" — which
 * points at the wrong thing entirely. The API was reachable and had a specific,
 * actionable complaint that nobody could read.
 *
 * Two constraints are deliberate:
 *
 *   - **Names, never values.** The report is served by an unauthenticated
 *     endpoint, so "SESSION_SECRET is not set" must never become "here is your
 *     SESSION_SECRET".
 *   - **Recorded, not re-thrown.** A serverless instance that re-throws on every
 *     request would turn one deployment mistake into a log flood.
 */
import { looksLikeArgon2id } from '../auth/index.ts';

interface BootFailure {
  /** Boot stage that failed. Ordered: nothing after it could have run. */
  stage: 'configuration' | 'database';
  /** The original error, kept for the server log. Never serialised to a client. */
  error: Error;
}

let failure: BootFailure | null = null;

/** Record a boot failure. The first one wins — later stages never ran. */
export function recordBootFailure(stage: BootFailure['stage'], error: unknown): void {
  if (failure) return;
  failure = { stage, error: error instanceof Error ? error : new Error(String(error)) };
}

export function bootFailure(): BootFailure | null {
  return failure;
}

/** Clear the recorded failure. Tests boot the same process repeatedly. */
export function resetBootFailure(): void {
  failure = null;
}

/**
 * The public shape of a boot failure.
 *
 * `summary` is the error's own message. It contains variable *names* and remedy
 * commands by construction (see `assertAuthConfiguration`), never a value, so it
 * is safe to show. It is shown because it is the single most useful sentence an
 * operator can be given.
 */
export interface BootFailureBody {
  code: 'misconfigured';
  /** Which stage refused to start. */
  stage: 'configuration' | 'database';
  /** Human-readable, names-only explanation from the boot check itself. */
  summary: string;
  /** Required variables that are absent. Names only. */
  missing: string[];
  /** Optional variables that are absent, with what their absence costs. */
  optional: Array<{ name: string; consequence: string }>;
  /** Variables present but unusable. Names plus the problem, never the value. */
  invalid: Array<{ name: string; problem: string }>;
  /** What to do, in order. */
  remedy: string[];
}

/**
 * Variables and what they cost when absent.
 *
 * `required: true` means the API cannot run at all without it.
 * `required: false` means it runs, but with a limitation worth stating — the
 * distinction matters because reporting a genuinely optional variable as "missing"
 * sends an operator to provision something they do not need. `DATABASE_URL` is the
 * case in point: without it the API falls back to SQLite in the instance's temp
 * directory, which is a working deployment (and enough to sign in and evaluate),
 * just not a durable one.
 */
const SETTINGS = [
  {
    name: 'SESSION_SECRET',
    required: true,
    purpose: 'signs CSRF tokens and session cookies',
  },
  {
    name: 'DATABASE_URL',
    required: false,
    purpose: 'PostgreSQL. Without it data lives in ephemeral per-instance SQLite and is lost when the instance recycles',
  },
] as const;

export function bootFailureBody(err: BootFailure): BootFailureBody {
  const missing = SETTINGS.filter((s) => s.required && !process.env[s.name]).map((s) => s.name);
  const optional = SETTINGS.filter((s) => !s.required && !process.env[s.name])
    .map((s) => ({ name: s.name, consequence: s.purpose }));

  const invalid: Array<{ name: string; problem: string }> = [];
  const hash = process.env.RELAY_ADMIN_PASSWORD_HASH ?? '';
  if (hash && !looksLikeArgon2id(hash)) {
    invalid.push({
      name: 'RELAY_ADMIN_PASSWORD_HASH',
      problem: 'not a complete Argon2id PHC hash — likely truncated on paste or expanded by the shell; single-quote it',
    });
  }

  /**
   * Explain the causal chain when the surface error blames something else.
   *
   * With no `DATABASE_URL` the boot falls back to local SQLite, which starts
   * empty — so no shared credential exists, so `AUTH_MODE=auto` resolves to `dev`,
   * so the production guard refuses. The *first* thing to fix is therefore the
   * database, but the message an operator sees is about authentication. Stating the
   * chain is the difference between "why is it complaining about auth?" and knowing
   * that one variable is responsible for both symptoms.
   */
  const causal =
    /AUTH_MODE=dev is refused/.test(err.error.message)
      ? [
          'No shared login credential is provisioned, so AUTH_MODE=auto resolved to `dev`, which a production deployment refuses. Fix it either way: set DATABASE_URL (durable storage, then run the migration and assign-login commands below) OR set RELAY_LOGIN_USERNAME and RELAY_ADMIN_PASSWORD_HASH (the credential is written on boot, and SQLite in the instance temp directory is used until you add a database).',
        ]
      : [];

  const remedy = [
    ...causal,
    ...missing.map((name) => {
      const purpose = SETTINGS.find((s) => s.name === name)!.purpose;
      return name === 'SESSION_SECRET'
        ? 'Set SESSION_SECRET to 32+ random bytes: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
        : `Set DATABASE_URL to your provider's pooled PostgreSQL connection string (${purpose})`;
    }),
    'Run the schema migration: DATABASE_URL=… npm run db:migrate:prod',
    'Provision the shared login: npm run set-password, then npm run db:pg:assign-login',
    'Redeploy and confirm GET /api/ready returns 200',
  ];

  return {
    code: 'misconfigured',
    stage: err.stage,
    summary: err.error.message,
    missing,
    optional,
    invalid,
    remedy,
  };
}
