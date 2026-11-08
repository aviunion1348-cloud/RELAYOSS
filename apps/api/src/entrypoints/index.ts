/**
 * Framework-preset entrypoint.
 *
 * Vercel's Fastify preset looks for `src/index.{ts,js}`, `src/app.*`, `src/server.*`
 * or the same three names at the service root. `apps/api/src/index.ts` — the
 * long-lived container entry — matches that list, so a service rooted at `apps/api`
 * with `framework: "fastify"` can be resolved to a file that calls `app.listen()`
 * and starts a `setInterval`. Neither works in a function invocation: the listen
 * fails, and the interval never fires, so the deployment appears healthy while
 * every deadline sweep is silently lost.
 *
 * This module exists so the preset resolves to the serverless handler instead. It
 * re-exports rather than re-implements, so there is exactly one serverless entry
 * (`entrypoints/vercel.ts`) and one container entry (`src/index.ts`), and the
 * framework's entrypoint discovery cannot pick the wrong one.
 *
 * Nothing else imports this file. It is not part of the application graph, and it
 * holds no logic of its own.
 */
export { default, getApp, maybeSweep } from './vercel.ts';
