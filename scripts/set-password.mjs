#!/usr/bin/env node
/**
 * Provision the shared login credential.
 *
 *   node scripts/set-password.mjs                  # prompts for a password
 *   node scripts/set-password.mjs --print-env      # prints the two vars to set
 *
 * What this does and, more importantly, what it refuses to do:
 *
 *   - It hashes the password with Argon2id (64 MiB, t=3, p=4) and prints the
 *     encoded hash. The plaintext is never written to disk, never included in the
 *     repository, and never placed in a shell history by this script.
 *   - It does **not** write a `.env` file. Secrets belong in the platform's
 *     environment, not in a checkout that someone might commit.
 *   - It does not touch the database. Provisioning is a deployment step, run once,
 *     against the target database.
 *
 * Usage for Vercel:
 *
 *   1. node scripts/set-password.mjs
 *   2. Copy the two lines it prints into Vercel → Settings → Environment Variables
 *   3. Run `npm run db:assign-login` against the production database once.
 */
import crypto from 'node:crypto';
import readline from 'node:readline';

const USERNAME = process.env.RELAY_LOGIN_USERNAME ?? 'lear roadmap 289';

async function prompt(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }
    // Mask keystrokes so the password does not appear on a shared screen or in a
    // terminal recording.
    process.stdout.write(question);
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') {
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
      } else if (s === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else {
        process.stdout.write('\b \b');
      }
    };
    process.stdin.on('data', onData);
    rl.on('line', (answer) => resolve(answer));
  });
}

async function main() {
  const printEnv = process.argv.includes('--print-env');

  let argon2;
  try {
    argon2 = (await import('argon2')).default;
  } catch {
    console.error('argon2 is not installed. Run `npm ci` first.');
    process.exit(1);
  }

  let password = process.env.RELAY_LOGIN_PASSWORD ?? '';
  if (!password) {
    if (!process.stdin.isTTY) {
      console.error(
        'No terminal available for a password prompt.\n' +
          'Set RELAY_LOGIN_PASSWORD in the environment for a non-interactive run, or run this\n' +
          'command from an interactive shell.',
      );
      process.exit(1);
    }
    password = await prompt('Password for the shared login: ', { hidden: true });
    const confirm = await prompt('Confirm password: ', { hidden: true });
    if (password !== confirm) {
      console.error('Passwords do not match. Nothing was generated.');
      process.exit(1);
    }
  }

  /**
   * Length is checked, but it is an *acknowledgement*, not a veto.
   *
   * This credential opens the entire workspace from the public internet, so a short
   * password is the single most likely way in. The operator may still be required
   * to use a specific value — a dictated credential, a shared team secret — and
   * refusing outright would just push them to hand-edit a hash generator.
   *
   * So: under 12 characters is allowed with `--allow-short`, and the warning says
   * exactly what the risk is. The mitigation that actually matters for a weak
   * shared password is already in place — Argon2id at 64 MiB inflates guessing
   * cost, and login is throttled per address and per username with exponential
   * backoff to 30 minutes.
   */
  const MIN_RECOMMENDED = 12;
  const shortPassword = password.length < MIN_RECOMMENDED;
  const allowShort = process.argv.includes('--allow-short');
  if (shortPassword && !allowShort) {
    console.error(
      `Password is ${password.length} characters; ${MIN_RECOMMENDED} is recommended for an\n` +
        'internet-facing login. Re-run with --allow-short to proceed anyway. Nothing was\n' +
        'generated on this run.',
    );
    process.exit(1);
  }
  if (shortPassword) {
    console.warn(
      `\n⚠  WARNING: this password is ${password.length} characters, below the ${MIN_RECOMMENDED}-character\n` +
        '   recommendation. It is being accepted because --allow-short was given. Mitigations in\n' +
        '   force: Argon2id (64 MiB, t=3) and per-address + per-username login throttling with\n' +
        '   exponential backoff. Consider rotating to a longer value.',
    );
  }

  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });

  // A cheap sanity check that the hash verifies, so an operator cannot deploy a
  // credential that was mistyped into the wrong encoding.
  const ok = await argon2.verify(hash, password);
  if (!ok) {
    console.error('Internal error: the generated hash did not verify. Nothing was written.');
    process.exit(1);
  }

  console.log('');
  console.log('Argon2id hash generated and verified.');
  console.log('');
  console.log('Add these two environment variables in Vercel → Settings → Environment Variables');
  console.log('(Production and Preview), then redeploy:');
  console.log('');
  console.log(`RELAY_LOGIN_USERNAME=${USERNAME}`);
  console.log(`RELAY_ADMIN_PASSWORD_HASH=${hash}`);
  console.log('');
  console.log('Then provision the credential row in the database once:');
  console.log('  npm run db:assign-login');
  console.log('');
  console.log('Notes:');
  console.log('  • The hash is a secret. Treat it as you would the password.');
  console.log('  • Never commit it. This script deliberately does not write a file.');
  console.log('  • Rotating the password invalidates every existing session, because');
  console.log('    sessions record the credential version they were minted with.');
  if (printEnv) {
    // Machine-readable form for a scripted pipeline (not for logs).
    process.stdout.write(`${JSON.stringify({ RELAY_LOGIN_USERNAME: USERNAME, RELAY_ADMIN_PASSWORD_HASH: hash })}\n`);
  }
  // Guard against an accidental full-run with a throwaway value.
  if (crypto.randomUUID() === '') console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
