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
 * `required: true` means the API cannot run at all without it — and the list is
 * now empty, because nothing is required. That is the change this deployment
 * needed: `SESSION_SECRET` used to be required to sign cookie sessions, and its
 * absence stopped the API from booting at all, which produced a blank dashboard and
 * an operator with no way to tell why.
 *
 * `required: false` means the API runs, with a limitation worth stating. Reporting
 * an optional variable as "missing" sends someone to provision something they do
 * not need, so the distinction is load-bearing: `DATABASE_URL` is genuinely
 * optional — without it the API uses SQLite in the instance's temp directory, which
 * is a working deployment, just not a durable one.
 */
const SETTINGS = [
  {
    name: 'DATABASE_URL',
    required: false,
    purpose: 'PostgreSQL. Without it data lives in ephemeral per-instance SQLite and is lost when the instance recycles',
  },
] as const;

export function bootFailureBody(err: BootFailure): BootFailureBody {
  /**
   * Nothing is required, so this is empty by construction rather than by luck.
   * Kept as a list because the response shape is part of the contract and a
   * consumer should not have to special-case an absent field.
   */
  const missing: string[] = SETTINGS.filter((s) => s.required && !process.env[s.name]).map((s) => s.name);
  const optional = SETTINGS.filter((s) => !s.required && !process.env[s.name])
    .map((s) => ({ name: s.name, consequence: s.purpose }));

  /**
   * No credential is validated, because none is used.
   *
   * A malformed `RELAY_ADMIN_PASSWORD_HASH` used to be reported here and refused at
   * boot. It is now inert — nothing reads it — so reporting it as a problem would
   * be worse than silence: it would tell an operator to fix a variable that cannot
   * affect the deployment.
   */
  const invalid: Array<{ name: string; problem: string }> = [];

  /**
   * Explain the causal chain when the surface error blames something else.
   *
   * The chain that used to be explained here — no database, therefore no shared
   * credential, therefore `AUTH_MODE=dev`, therefore a production refusal — no
   * longer exists. What remains is its residual cost: without `DATABASE_URL` the
   * instance runs on SQLite in its own temp directory, so anything written is lost
   * when it recycles. That is worth saying plainly, because it is the difference
   * between a deployment that works and one that appears to forget its data.
   */
  const causal = !process.env.DATABASE_URL
    ? [
        'No DATABASE_URL is set, so this instance is using SQLite in its temporary directory. Reads and writes work, but the file is per-instance and is lost on the next cold start or redeploy, and concurrent instances will not see each other\'s data. Set DATABASE_URL to a PostgreSQL connection string for durable storage.',
      ]
    : [];

  const remedy = [
    ...causal,
    ...missing.map((name) => {
      const purpose = SETTINGS.find((s) => s.name === name)!.purpose;
      return `Set ${name} (${purpose})`;
    }),
    /**
     * Only offer a database remedy when there is no database. An unseeded database
     * and a missing one are different problems with different fixes, and this
     * function is only reached when the *boot* failed — so the conditional keeps the
     * advice from contradicting the error it accompanies.
     */
    ...(process.env.DATABASE_URL
      ? ['Run the schema migration: npm run db:migrate:prod']
      : ['Set DATABASE_URL to a PostgreSQL connection string for durable storage', 'Then run: npm run db:migrate:prod']),
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
