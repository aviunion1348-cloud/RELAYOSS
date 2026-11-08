/**
 * Test-fixture reset.
 *
 * Every suite that runs against PostgreSQL has to clear the demo data between
 * runs. That reset previously hard-coded its own list of tables to preserve, and
 * the lists drifted: a suite that predated `lifecycle_stages` truncated it, so a
 * later suite saw an empty stage catalogue and failed for a reason that had
 * nothing to do with the code under test.
 *
 * One list, in one place:
 *   - `schema_migrations` is the ledger
 *   - turnover/SLA/retention/lifecycle policy is seeded by migrations and is
 *     configuration the application depends on, not demo data
 */
const POLICY_TABLES = [
  'schema_migrations',
  'turnover_gates',
  'sla_clocks',
  'sla_policies',
  'retention_policies',
  'lifecycle_stages',
];

export const POLICY_TABLE_SET = new Set(POLICY_TABLES);

/** Wipe demo rows on PostgreSQL, keeping migration-seeded policy. */
export async function resetPostgres(db: any): Promise<void> {
  if (!db || db.dialect !== 'postgres') return;
  const tables = await db.all("SELECT tablename AS n FROM pg_tables WHERE schemaname='public'");
  const wipe = tables
    .map((r: { n: string }) => r.n)
    .filter((n: string) => !POLICY_TABLE_SET.has(n));
  if (wipe.length) {
    await db.exec(`TRUNCATE ${wipe.map((n: string) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
  // Re-assert SQL-seeded policy in case a previous run removed rows from it.
  const fs = await import('node:fs/promises');
  await db.exec(
    await fs.readFile(new URL('../../../../db/migrations/pg/0005_baseline_policy.sql', import.meta.url), 'utf8'),
  );
}
