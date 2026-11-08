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
import { recordSweep, setSweepRunning } from './lib/metrics.ts';
import { getDb, closeDb } from './db/index.ts';

const { app } = await buildApp();
const db = getDb();


// Background sweeper: every overdue clock becomes a missed record + activity row.
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);
let sweeping = false;
const sweeper = setInterval(() => {
  // Re-entrancy guard: a slow sweep must never overlap itself, otherwise two
  // workers could double-notify the same missed clock.
  if (sweeping) return;
  sweeping = true;
  setSweepRunning(true);
  void (async () => {
    try {
      const swept = await sweepTimers(db);
      recordSweep({ count: swept });
      if (swept) app.log.warn({ swept }, 'clocks swept');
    } catch (err) {
      recordSweep({ count: 0, failed: true });
      app.log.error({ err }, 'sweep failed');
    } finally {
      sweeping = false;
    }
  })();
}, SWEEP_MS);
sweeper.unref?.();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  await app.close();
  await closeDb();
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
