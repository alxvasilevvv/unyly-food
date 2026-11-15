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

/** Never print a connection string or its password: error texts of drivers and URL parsers can quote their input. */
export function redactDbUrls(text: string, ...urls: (string | undefined)[]): string {
  let out = text;
  for (const u of urls) {
    if (!u) continue;
    for (const part of u.split('|').map((x) => x.trim()).filter(Boolean)) {
      out = out.split(part).join('[database url]');
      const pw = /^[a-z][a-z0-9+.-]*:\/\/[^:/?#@]*:([^@/?#]+)@/i.exec(part)?.[1];
      if (pw && pw.length >= 3) out = out.split(pw).join('***').split(decodeURIComponentSafe(pw)).join('***');
    }
  }
  return out.replace(/\b(postgres(?:ql)?:\/\/)[^\s"'<>]+/gi, '$1[redacted]');
}
function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Host, port and database of a connection string, for telling two of them apart. Null when it cannot be parsed. */
function dbTarget(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${decodeURIComponentSafe(u.pathname.replace(/^\//, '')) || u.username}`;
  } catch {
    return null;
  }
}

/** True for errors that say the database cannot be reached (as opposed to a statement that failed). */
export function isConnectionError(e: any): boolean {
  const code = String(e?.code ?? '');
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|CONNECTION_CLOSED|CONNECT_TIMEOUT)$/.test(code)) return true;
  // SQLSTATE class 08 (connection exception), 57P01..03 (shutdown, crash, cannot connect now), 53300 (too many connections).
  if (/^(08...|57P0[123]|53300)$/.test(code)) return true;
  return /timeout exceeded when trying to connect|connection terminated|connection (was |is )?(closed|ended)|client has encountered a connection error|the database system is (starting up|shutting down)/i.test(String(e?.message ?? ''));
}

export interface FailoverDb extends Db {
  /** Which database the next statement goes to. */
  active(): 'primary' | 'fallback';
  /** Stops the background checks (the databases themselves are closed by their owners). */
  stop(): void;
  /** Resolves when the check of the primary that is in progress (if any) has finished. For start-up and tests. */
  settled(): Promise<void>;
}

/**
 * A database that uses `primary` while it is ready and reachable, and `fallback` otherwise.
 *
 * `prepare` makes the primary usable (reach it, migrate it); it runs in the background and is repeated every
 * `retryMs` until it succeeds, so a primary that is slow or down at start never blocks anything. When a statement
 * on the primary fails because the database cannot be reached, that request fails once and the following ones go
 * to the fallback at once (no waiting for a connect timeout per request); the primary is used again as soon as
 * `prepare` succeeds. `prepare` may return false to give the primary up for good (it is not ours to use).
 *
 * The two databases do not share rows. For the web demo that is fine: a visitor whose session row is in the
 * other database gets "session ended" and the page quietly starts a new one.
 */
export function failoverDb(
  primary: Db, fallback: Db,
  o: { prepare: () => Promise<boolean | void>; retryMs?: number; stallMs?: number; log?: (m: string) => void; ready?: boolean },
): FailoverDb {
  const retryMs = o.retryMs ?? 15_000;
  // Longer than any statement may run (the pool sets statement_timeout to 15 s): a call that is still pending
  // after this is a connection that died without saying so.
  const stallMs = o.stallMs ?? 20_000;
  const log = o.log ?? (() => {});
  let up = o.ready === true;
  let gaveUp = false;
  let stopped = false;
  let checking: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (stopped || gaveUp || up || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, retryMs);
    timer.unref?.();
  };
  const check = (): Promise<void> => {
    if (stopped || gaveUp || up) return Promise.resolve();
    checking ??= (async () => {
      try {
        const r = await o.prepare();
        if (r === false) gaveUp = true;
        else if (!stopped) {
          up = true;
          log('[demo-db] separate demo database in use; the web demo does not use the shared database');
        }
      } catch {
        // Still not usable: try again later.
      } finally {
        checking = null;
        schedule();
      }
    })();
    return checking;
  };
  const goDown = () => {
    if (!up) return;
    up = false;
    log('[demo-db] separate demo database is not reachable; the web demo uses the shared database until it is back');
    schedule();
  };
  let verifying = false;
  const failed = (e: unknown) => {
    if (!up) return;
    if (isConnectionError(e)) return goDown();
    // Any other error is most likely the statement's own (a conflict, a refusal raised inside a transaction).
    // Error codes do not cover every way a server can be gone, so ask the database itself, once at a time.
    if (verifying) return;
    verifying = true;
    Promise.race([primary.ping().catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref?.())])
      .then((ok) => {
        if (!ok) goDown();
      })
      .finally(() => {
        verifying = false;
      });
  };
  const run = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
    if (!up) return fn(fallback);
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = fn(primary);
      const stalled = new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(Object.assign(new Error('demo database did not answer'), { code: 'ETIMEDOUT' })), stallMs);
        t.unref?.();
      });
      // The abandoned call may still fail later: that must not become an unhandled rejection.
      work.catch(() => {});
      return await Promise.race([work, stalled]);
    } catch (e) {
      failed(e);
      throw e;
    } finally {
      clearTimeout(t);
    }
  };
  if (!up) void check();
  return {
    query: (sql, params) => run((db) => db.query(sql, params)),
    tx: (fn) => run((db) => db.tx(fn)),
    ping: () => (up ? primary : fallback).ping(),
    close: async () => {},
    active: () => (up ? 'primary' : 'fallback'),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    settled: () => checking ?? Promise.resolve(),
  };
}

const demoDbWords = new WeakMap<Ctx, () => 'shared' | 'memory' | 'separate'>();

/** One word for /readyz: where the web demo keeps its data right now. */
export function demoDbWord(ctx: Ctx): 'shared' | 'memory' | 'separate' {
  return ctx.demoCtx ? demoDbWords.get(ctx.demoCtx)?.() ?? (ctx.cfg.demoDb === 'memory' ? 'memory' : 'separate') : 'shared';
}

/** How long start-up waits for the separate demo database before going on without it (it joins later, in the background). */
const REMOTE_START_WAIT_MS = 5000;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
};

/**
 * DEMO_DATABASE_URL: the web demo on its own Postgres, placed next to the application host (the main database may
 * be an ocean away, and every statement of an order then costs a round trip over that distance). Holds only the
 * disposable guest data of /ari.
 *
 * `shared` is the main database: the demo uses it whenever the separate one is not usable, at start and later
 * (see failoverDb). Start-up waits for the separate database for a few seconds at most. Null when the variable is
 * not set or names the main database itself; never throws, and the connection string is never written to the log.
 */
export async function createRemoteDemoCtx(
  cfg: Config, clock: Clock, shared: Db, log: (m: string) => void = (m) => console.log(m),
  o: { startWaitMs?: number; retryMs?: number } = {},
): Promise<DemoCtxHandle | null> {
  const url = cfg.demoDatabaseUrl;
  if (!url) return null;
  const say = (m: string) => log(redactDbUrls(m, url, cfg.databaseUrl));
  // The cleanup below deletes guests, audit rows and events by age. On the main database that would be data loss.
  const target = dbTarget(url);
  if (!target) {
    say('[demo-db] DEMO_DATABASE_URL is not a valid connection string; the web demo uses the shared database');
    return null;
  }
  if (cfg.databaseUrl.split('|').some((c) => dbTarget(c.trim()) === target)) {
    say('[demo-db] DEMO_DATABASE_URL names the main database; it is ignored and the web demo uses the shared database');
    return null;
  }
  let remote: Db;
  try {
    const { createDb } = await import('./db/db.js');
    remote = createDb(url, 8);
  } catch (e: any) {
    say(`[demo-db] separate demo database unavailable (${String(e?.message ?? e).slice(0, 200)}); the web demo uses the shared database`);
    return null;
  }
  let lastReason = '';
  const prepare = async (): Promise<boolean> => {
    try {
      const t0 = Date.now();
      const { migrate } = await import('./db/migrate.js');
      // pg gives up on a connection after 10 s; a statement that hangs is cut off here.
      if (!(await withTimeout(remote.ping(), 12_000, 'connecting'))) throw new Error('not reachable');
      await withTimeout(migrate(remote, (m) => say(`[demo-db] ${m}`)), 60_000, 'migrating');
      // Only disposable guests may live there: anything else means this is somebody's real database.
      const real = (await remote.query<{ n: number }>('SELECT count(*)::int n FROM users WHERE NOT is_guest')).rows[0]?.n ?? 0;
      if (real > 0) {
        say(`[demo-db] the database of DEMO_DATABASE_URL holds ${real} account(s) that are not demo guests; it is not used and nothing in it is deleted. The web demo uses the shared database`);
        return false;
      }
      const t1 = Date.now();
      await remote.query('SELECT 1');
      say(`[demo-db] separate demo database ready in ${Date.now() - t0} ms (one statement: ${Date.now() - t1} ms)`);
      return true;
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 200);
      // One line per distinct reason, not one every retry.
      if (reason !== lastReason) say(`[demo-db] separate demo database unavailable (${reason}); the web demo uses the shared database and keeps checking`);
      lastReason = reason;
      throw e;
    }
  };
  const db = failoverDb(remote, shared, { prepare, retryMs: o.retryMs, log: say });
  // The usual case: ready within a second or two, so the first visitor is already on the separate database.
  await Promise.race([db.settled(), new Promise((r) => setTimeout(r, o.startWaitMs ?? REMOTE_START_WAIT_MS).unref?.())]);
  const handle = demoHandle(cfg, clock, db, say, {
    // Cleanup deletes by age: only ever on the separate database, and only while it is the one in use.
    cleanupDb: remote,
    canClean: () => db.active() === 'primary',
    onStop: async () => {
      db.stop();
      // Not awaited for long: closing a pool whose server is gone can take as long as a connect timeout.
      await Promise.race([remote.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref?.())]);
    },
  });
  demoDbWords.set(handle.ctx, () => (db.active() === 'primary' ? 'separate' : 'shared'));
  return handle;
}

function demoHandle(
  cfg: Config, clock: Clock, demoDb: Db & { maintain?: () => Promise<void> }, log: (m: string) => void,
  o: { cleanupDb?: Db; canClean?: () => boolean; onStop?: () => Promise<void> } = {},
): DemoCtxHandle {
  const ctx = createCtx(cfg, demoDb, clock);
  /** What the cleanup deletes from: never the shared database. */
  const memoryDb: Db & { maintain?: () => Promise<void> } = o.cleanupDb ?? demoDb;
  // At most this many guests are kept, whatever their age (GUEST_HOURLY_LIMIT already caps how fast they are created).
  const maxGuests = Math.max(cfg.guestHourlyLimit, 100);

  const cleanup = async (maxAgeMs = MEMORY_GUEST_MAX_AGE_MS): Promise<number> => {
    if (o.canClean && !o.canClean()) return 0;
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
      .catch((e: any) => log(`[demo-db] cleanup failed: ${String(e?.message ?? e).slice(0, 200)}`))
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
      if (o.onStop) await o.onStop();
      else await memoryDb.close();
    },
  };
}
