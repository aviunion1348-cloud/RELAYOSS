/**
 * First-run bootstrap: one operator, nothing else.
 *
 * The API cannot serve an empty database. Every attribution column (`created_by`,
 * `updated_by`, `actor_id`) is a foreign key to `users`, so with no users there is
 * nobody to attribute a write to and the first request fails with
 * "No users exist in the database".
 *
 * The previous answer to that was to run the **demo seed** on boot: twelve invented
 * people, six projects, 89 tasks, deals, invoices, a fictional studio called Northwind.
 * That made a fresh deployment look populated — and made it impossible to tell real
 * data from invented data, because there was no difference in kind between them. A
 * dashboard showing numbers you did not enter is not a demonstration of the product;
 * it is a claim about your business that is false.
 *
 * So boot creates exactly one row: the operator this single-tenant deployment acts as.
 * Name and address come from configuration, because they are facts only the operator
 * knows:
 *
 *   OPERATOR_NAME   display name          default "Owner"
 *   OPERATOR_EMAIL  email                 default "owner@localhost"
 *   OPERATOR_USER_ID id the API resolves as default "usr_owner"
 *
 * Everything else the product shows — clients, projects, tasks, deals, invoices — is
 * entered through the application, or imported from a file the operator supplies.
 * Nothing is invented at boot.
 *
 * This is idempotent: an existing installation is never touched, and an empty `users`
 * table is the only state it acts on.
 */
import type { Db } from './index.ts';
import { ensureScaffolding } from './scaffolding.ts';

export type BootstrapResult = {
  /** True when this call created the operator; false when one already existed. */
  created: boolean;
  userId: string;
  name: string;
  email: string;
  /** True when this call created the default board (an installation with none). */
  boardCreated: boolean;
};

/** What the operator is called, as configured. Split out so tests can read it. */
export function operatorIdentityFromEnv(): { userId: string; name: string; email: string } {
  const userId = (process.env.OPERATOR_USER_ID ?? process.env.DEMO_USER_ID ?? 'usr_owner').trim() || 'usr_owner';
  const name = (process.env.OPERATOR_NAME ?? '').trim() || 'Owner';
  const email = (process.env.OPERATOR_EMAIL ?? '').trim() || 'owner@localhost';
  return { userId, name, email };
}

/** Initials for an avatar, derived rather than invented. */
function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'OW';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase() || 'OW';
}

/**
 * Ensure exactly one operator exists.
 *
 * Deliberately not gated on `NODE_ENV`: an empty database is unusable everywhere, and
 * a deployment that cannot answer its first request is not safer for being production.
 * What is gated is *invention* — this function adds one row that names a real person
 * from configuration, and nothing else.
 */
export async function ensureOperator(db: Db): Promise<BootstrapResult> {
  const existing = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  if (Number(existing?.c ?? 0) > 0) {
    const identity = operatorIdentityFromEnv();
    return {
      created: false, userId: identity.userId, name: identity.name, email: identity.email,
      boardCreated: (await ensureScaffolding(db)).boardCreated,
    };
  }

  const { userId, name, email } = operatorIdentityFromEnv();

  /*
   * An email collision is possible in a database that has rows we did not expect —
   * the guard above makes it unlikely, but the insert must not throw for it. Failing
   * here would turn "someone already exists" into a boot crash.
   */
  const taken = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  const finalEmail = taken ? `owner+${Date.now()}@localhost` : email;

  await db.run(
    `INSERT INTO users (id,email,full_name,title,role,avatar_color,initials,capacity_hours_week,cost_rate_cents,bill_rate_cents,skills_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, finalEmail, name, '', 'admin', '#6366f1', initialsOf(name), 32, 0, 0, '[]'],
  );

  return { created: true, userId, name, email: finalEmail, boardCreated: (await ensureScaffolding(db)).boardCreated };
}

