/**
 * An in-process OIDC provider, for testing the real redirect flow.
 *
 * This is a genuine provider, not a stub that short-circuits verification: it
 * holds an RSA keypair, publishes a JWKS, issues a signed ID token with a
 * nonce, and requires the PKCE verifier to match the challenge it was given.
 * The application's flow is therefore exercised all the way through — state,
 * nonce, S256 PKCE, JWKS lookup, signature verification, iss/aud/exp — and a
 * real production IdP differs only in being somewhere else on the network.
 *
 * What it deliberately does NOT do is trust anything the caller says. The tests
 * that matter are the ones where the provider or the application is lied to.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export interface TestIdpOptions {
  issuer?: string;
  audience?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface TestIdp {
  issuer: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  jwksUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Issue a code for a subject, binding the PKCE challenge and nonce. */
  issueCode(input: { challenge: string; nonce: string; redirectUri: string; subject: string; email?: string; role?: string }): string;
  /** Force the next token exchange to return a specific error. */
  failNext(error: string): void;
  /** Last exchange error, for asserting a rejection happened for the right reason. */
  lastError(): string;
  requests(): Array<{ url: string; method: string; body: string }>;
  close(): Promise<void>;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startTestIdp(opts: TestIdpOptions = {}): Promise<TestIdp> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-idp-key-1';
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' };

  const issuer = opts.issuer ?? 'https://idp.test.example';
  const audience = opts.audience ?? 'relay-test';
  const clientId = opts.clientId ?? 'relay-test-client';
  const clientSecret = opts.clientSecret ?? 'relay-test-secret';

  // Outstanding authorization codes, keyed by code. Each carries exactly what
  // the provider must check when the code comes back.
  const codes = new Map<string, {
    subject: string; email: string; role: string; nonce: string;
    challenge: string; redirectUri: string; used: boolean; expiresAt: number;
  }>();
  const log: Array<{ url: string; method: string; body: string }> = [];
  let forcedError = '';
  let lastError = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    let body = '';
    for await (const chunk of req) body += chunk;
    log.push({ url: url.pathname + url.search, method: req.method ?? 'GET', body });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/.well-known/jwks.json') {
      return json(200, { keys: [jwk] });
    }

    if (url.pathname === '/oauth2/authorize') {
      // Record the request; the test issues the code itself so it controls the
      // subject and can tamper with the nonce or challenge.
      return json(200, {
        authorize: true,
        state: url.searchParams.get('state'),
        nonce: url.searchParams.get('nonce'),
        codeChallenge: url.searchParams.get('code_challenge'),
        codeChallengeMethod: url.searchParams.get('code_challenge_method'),
        redirectUri: url.searchParams.get('redirect_uri'),
        clientId: url.searchParams.get('client_id'),
        scope: url.searchParams.get('scope'),
      });
    }

    if (url.pathname === '/oauth2/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (forcedError) {
        const err = forcedError;
        forcedError = '';
        lastError = err;
        return json(400, { error: 'invalid_grant', error_description: err });
      }

      // Client authentication, basic or post.
      const auth = req.headers.authorization ?? '';
      let authed = false;
      if (auth.startsWith('Basic ')) {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        authed = decoded === `${clientId}:${clientSecret}`;
      } else if (form.get('client_secret')) {
        authed = form.get('client_secret') === clientSecret;
      }
      if (!authed) {
        lastError = 'client authentication failed';
        return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      }

      const code = form.get('code') ?? '';
      const record = codes.get(code);
      if (!record) {
        lastError = 'unknown code';
        return json(400, { error: 'invalid_grant', error_description: 'Unknown authorization code' });
      }
      if (record.used) {
        lastError = 'code replayed';
        return json(400, { error: 'invalid_grant', error_description: 'Authorization code already used' });
      }
      if (Date.now() > record.expiresAt) {
        lastError = 'code expired';
        return json(400, { error: 'invalid_grant', error_description: 'Authorization code expired' });
      }
      // PKCE: the verifier must hash to the challenge the code was issued with.
      const verifier = form.get('code_verifier') ?? '';
      const computed = b64url(crypto.createHash('sha256').update(verifier).digest());
      if (!verifier || computed !== record.challenge) {
        lastError = 'PKCE verifier mismatch';
        return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      if (form.get('redirect_uri') !== record.redirectUri) {
        lastError = 'redirect_uri mismatch';
        return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }

      record.used = true;
      lastError = '';

      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
      const claims = {
        iss: issuer,
        aud: audience,
        sub: record.subject,
        email: record.email,
        name: record.email.split('@')[0],
        role: record.role,
        nonce: record.nonce,
        iat: now,
        exp: now + 600,
      };
      const signingInput = `${header}.${b64url(JSON.stringify(claims))}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey);
      const idToken = `${signingInput}.${b64url(signature)}`;

      return json(200, {
        access_token: b64url(crypto.randomBytes(24)),
        token_type: 'Bearer',
        expires_in: 600,
        id_token: idToken,
      });
    }

    if (url.pathname === '/oauth2/userinfo') {
      return json(200, { ok: true });
    }

    return json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  return {
    issuer,
    audience,
    clientId,
    clientSecret,
    jwksUri: `${base}/.well-known/jwks.json`,
    authorizeUrl: `${base}/oauth2/authorize`,
    tokenUrl: `${base}/oauth2/token`,
    issueCode(input) {
      const code = b64url(crypto.randomBytes(18));
      codes.set(code, {
        subject: input.subject,
        email: input.email ?? `${input.subject}@example.com`,
        role: input.role ?? 'member',
        nonce: input.nonce,
        challenge: input.challenge,
        redirectUri: input.redirectUri,
        used: false,
        expiresAt: Date.now() + 60_000,
      });
      return code;
    },
    failNext(error) { forcedError = error; },
    lastError() { return lastError; },
    requests() { return log; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
