/**
 * The identity type, and nothing else.
 *
 * This file used to be the authentication system: JWT signing and verification, an
 * HMAC-signed cookie session store, CSRF token issuance and validation, the auth
 * mode state machine, the production guard, and the boot-time configuration
 * asserts. All of it is gone — see `docs/AUTH-REMOVAL.md` for what each piece did
 * and why removing it was safe, and `operator-middleware.ts` for what replaced the
 * parts that were still needed.
 *
 * What remains is a type, because `Identity` still describes something real: the
 * person a request is attributed to. It flows into `created_by`, the audit trail,
 * the lifecycle transition log and the read-scope predicates. Keeping the type —
 * rather than inlining it — is what let the database schema, the service layer and
 * the scope logic stay untouched through this change.
 */

/**
 * The identity a request acts as.
 *
 * Every field is still populated, because every field is still read: the id is a
 * foreign key on a dozen tables, the role drives scope resolution, and the email and
 * name appear in the interface.
 */
export interface Identity {
  userId: string;
  email: string;
  role: 'admin' | 'lead' | 'member' | 'client' | 'bot';
  name: string;
  /**
   * How this request was authenticated — audited with every mutation.
   *
   * `operator` is the single-tenant, unauthenticated deployment: the request was
   * **not** authenticated by anything, and is attributed to the configured
   * workspace operator. It is distinct from the three session-based values so that
   * an audit row can never claim a request was verified when it was not. The other
   * three are retained only so that historical rows remain readable.
   */
  method: 'oidc' | 'dev' | 'password' | 'operator';
  /** The session backing this request, when there is one. Always absent now. */
  sessionId?: string;
  /** Token/session expiry (epoch ms). */
  expiresAt: number;
  /** Scopes/claims relevant to authorisation decisions. */
  claims: Record<string, unknown>;
}
