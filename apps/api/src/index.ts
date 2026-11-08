/**
 * Relay OSS API entrypoint.
 *
 * Bootstrap: build the app graph (app.ts) → listen → start the clock sweeper.
 * In production the same process serves the built SPA, so the browser talks to
 * a single origin and there is no localhost or CORS surface in client code.
 */
import { config } from './config.ts';
import { buildApp } from './app.ts';
import { sweepTimers } from './services/clocks.ts';
import { getDb } from './db/index.ts';

const { app } = await buildApp();
const db = getDb();

// Background sweeper: every overdue clock becomes a missed record + activity row.
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);
const sweeper = setInterval(() => {
  try {
    const swept = sweepTimers(db);
    if (swept) app.log.warn({ swept }, 'clocks swept');
  } catch (err) {
    app.log.error({ err }, 'sweep failed');
  }
}, SWEEP_MS);
sweeper.unref?.();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Relay API ready on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app };
