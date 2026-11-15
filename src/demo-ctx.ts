// DEMO_DB=memory: the public web demo (/ari) runs on an embedded in-process Postgres (src/db/memory-db.ts)
// instead of the shared database. This file builds the second context for it and keeps its memory bounded.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { type Clock, createCtx, type Ctx } from './context.js';

const CLEANUP_EVERY_MS = 10 * 60_000;
/** Demo guests of the embedded database live this long (the cookie may live longer; the page then starts a new session). */
export const MEMORY_GUEST_MAX_AGE_MS = 6 * 3600_000;

export interface DemoCtxHandle {
  ctx: Ctx;
  /** One cleanup run now. Returns how many guest users were deleted. */
  cleanup(maxAgeMs?: number): Promise<number>;
  /** Stops the cleanup timer and closes the embedded database. */
  stop(): Promise<void>;
}

/** One full garbage collection, if this Node build allows asking for it. Best effort. */
function collectGarbage() {
  try {
    const exposed = (globalThis as any).gc;
    if (typeof exposed === 'function') return void exposed();
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    setFlagsFromString('--no-expose-gc');
    if (typeof gc === 'function') gc();
  } catch {
    // The memory is collected later on its own.
  }
}

const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));

/** The memory limit of the container in MB, or null when there is none (or the platform does not report one). */
export function memoryLimitMb(): number | null {
  try {
    const n = Number((process as any).constrainedMemory?.() ?? 0);
    // No limit is reported as 0 or as a number close to 2^63.
    return n > 0 && n < 2 ** 50 ? Math.round(n / (1024 * 1024)) : null;
  } catch {
    return null;
  }
}

/** What the embedded database needs on top of the running process while it starts (measured peak: about 250 MB from the build snapshot, 600 MB without). */
const MEMORY_DB_HEADROOM_MB = 650;

/**
 * The context of the web demo on an embedded database, or null when it cannot be used (PGlite fails to start,
 * or the process is above DEMO_DB_MAX_RSS_MB afterwards). Null means: use the shared database; never throws.
 */
export async function createMemoryDemoCtx(cfg: Config, clock: Clock, log: (m: string) => void = (m) => console.log(m)): Promise<DemoCtxHandle | null> {
  // A container with too little memory would be killed by the host while the database starts, before the
  // check further down could run. Decide from the container limit first.
  const limit = memoryLimitMb();
  if (limit !== null && limit - rssMb() < MEMORY_DB_HEADROOM_MB) {
    log(`[demo-db] embedded database not started: the container has ${limit} MB, ${rssMb()} MB in use, and the database needs ${MEMORY_DB_HEADROOM_MB} MB of headroom; the web demo uses the shared database`);
    return null;
  }
  let db;
  try {
    const t0 = Date.now();
    // Loaded on demand: without DEMO_DB=memory the WebAssembly build of Postgres is never read.
    const { createMemoryDb } = await import('./db/memory-db.js');
    db = await createMemoryDb();
    // Start-up leaves a few hundred MB of garbage behind (a second WebAssembly instance that initialised the data
    // directory). Collect it now, so the reading below and the host's memory reflect what the database keeps.
    // Twice with a pause: the buffers of the discarded instance are only released after its finalizers ran.
    collectGarbage();
    await new Promise((r) => setTimeout(r, 50));
    collectGarbage();
    const rss = rssMb();
    if (rss > cfg.demoDbMaxRssMb) {
      await db.close().catch(() => {});
      db = undefined;
      // Give the memory back now; the reading in the log line is the one that triggered the fallback.
      await new Promise((r) => setTimeout(r, 50));
      collectGarbage();
      setTimeout(collectGarbage, 3000).unref();
      log(`[demo-db] embedded database closed: process memory ${rss} MB is above DEMO_DB_MAX_RSS_MB=${cfg.demoDbMaxRssMb}; the web demo uses the shared database`);
      return null;
    }
    log(`[demo-db] embedded database ready in ${Date.now() - t0} ms${db.fromSnapshot ? ' from the build snapshot' : ''} (process memory ${rss} MB); the web demo does not use the shared database`);
  } catch (e: any) {
    await db?.close().catch(() => {});
    log(`[demo-db] embedded database unavailable (${String(e?.message ?? e).slice(0, 200)}); the web demo uses the shared database`);
    return null;
  }
  return demoHandle(cfg, clock, db, log);
}

/**
 * DEMO_DATABASE_URL: the web demo on its own Postgres, placed next to the application host (the main database may
 * be an ocean away, and every statement of an order then costs a round trip over that distance). Holds only the
 * disposable guest data of /ari. Null when it is not set, cannot be reached within a few seconds or cannot be
 * migrated: the demo then uses the shared database; never throws.
 */
export async function createRemoteDemoCtx(cfg: Config, clock: Clock, log: (m: string) => void = (m) => console.log(m)): Promise<DemoCtxHandle | null> {
  if (!cfg.demoDatabaseUrl) return null;
  let db: Db | undefined;
  try {
    const t0 = Date.now();
    const { createDb } = await import('./db/db.js');
    const { migrate } = await import('./db/migrate.js');
    db = createDb(cfg.demoDatabaseUrl, 8);
    const ok = await Promise.race([db.ping(), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
    if (!ok) throw new Error('not reachable');
    await migrate(db, (m) => log(`[demo-db] ${m}`));
    const t1 = Date.now();
    await db.query('SELECT 1');
    log(`[demo-db] separate demo database ready in ${Date.now() - t0} ms (one statement: ${Date.now() - t1} ms); the web demo does not use the shared database`);
  } catch (e: any) {
    await db?.close().catch(() => {});
    log(`[demo-db] separate demo database unavailable (${String(e?.message ?? e).slice(0, 200)}); the web demo uses the shared database`);
    return null;
  }
  return demoHandle(cfg, clock, db, log);
}

function demoHandle(cfg: Config, clock: Clock, memoryDb: Db & { maintain?: () => Promise<void> }, log: (m: string) => void): DemoCtxHandle {
  const ctx = createCtx(cfg, memoryDb, clock);
  // At most this many guests are kept, whatever their age (GUEST_HOURLY_LIMIT already caps how fast they are created).
  const maxGuests = Math.max(cfg.guestHourlyLimit, 100);

  const cleanup = async (maxAgeMs = MEMORY_GUEST_MAX_AGE_MS): Promise<number> => {
    const secs = Math.max(0, Math.round(maxAgeMs / 1000));
    // Everything a guest owns (addresses, carts, checkouts, orders, events) goes with the users row (ON DELETE CASCADE).
    const old = await memoryDb.query(`DELETE FROM users WHERE is_guest AND created_at < now() - make_interval(secs => $1)`, [secs]);
    const extra = await memoryDb.query(`DELETE FROM users WHERE id IN (SELECT id FROM users WHERE is_guest ORDER BY created_at DESC OFFSET $1)`, [maxGuests]);
    // Rows that are not tied to a user row.
    await memoryDb.query(`DELETE FROM partner_webhooks WHERE created_at < now() - make_interval(secs => $1)`, [secs]);
    await memoryDb.query(`DELETE FROM audit_log WHERE created_at < now() - make_interval(secs => $1)`, [secs]);
    await memoryDb.query(`DELETE FROM provider_events WHERE received_at < now() - make_interval(secs => $1)`, [secs]);
    await memoryDb.query(`DELETE FROM demo_sim_orders d WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.provider = 'demo' AND o.provider_order_ref = d.ref) AND d.accepted_at < now() - interval '10 minutes'`);
    await memoryDb.maintain?.();
    return old.rowCount + extra.rowCount;
  };

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    cleanup()
      .then(() => {
        const rss = rssMb();
        if (rss > cfg.demoDbMaxRssMb) log(`[demo-db] process memory ${rss} MB is above DEMO_DB_MAX_RSS_MB=${cfg.demoDbMaxRssMb}`);
      })
      .catch((e: any) => console.error('[demo-db] cleanup failed:', e?.message ?? e))
      .finally(() => {
        running = false;
      });
  }, CLEANUP_EVERY_MS);
  timer.unref();

  return {
    ctx,
    cleanup,
    async stop() {
      clearInterval(timer);
      await memoryDb.close();
    },
  };
}
