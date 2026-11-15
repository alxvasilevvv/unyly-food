import pg from 'pg';

// Return BIGINT/NUMERIC as JS numbers where safe. Money is stored as BIGINT minor units;
// amounts for food orders fit comfortably within Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint out of safe range');
  return n;
});

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /**
   * Run fn inside a transaction. Serialization failures are retried a few times.
   * `opts.lead`: a parameter-free SELECT (a row lock) that is the first statement of the transaction. A
   * database that can send it in the same round trip as BEGIN does so and hands its rows to fn as `lead`;
   * otherwise `lead` is undefined and fn runs the statement itself (see txLeading).
   */
  tx<T>(fn: (q: Queryable, lead?: any[]) => Promise<T>, opts?: { lead?: string }): Promise<T>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

/**
 * A transaction whose first statement is `sql` (no parameters: a row lock by ids that were checked to be UUIDs).
 * With a remote database BEGIN and that statement travel together, one round trip less per transaction.
 */
export function txLeading<T>(db: Db, sql: string, fn: (q: Queryable, rows: any[]) => Promise<T>): Promise<T> {
  return db.tx(async (q, lead) => fn(q, lead ?? (await q.query(sql)).rows), { lead: sql });
}

/** Errors of a lock statement that say nothing about whether "BEGIN; <statement>" works here: they are retried or reported as usual. */
const LEAD_ORDINARY_ERRORS = new Set(['40001', '40P01', '55P03', '57014']);

/**
 * TLS to Postgres. DATABASE_SSL_CA (PEM) = encrypted + verified (recommended).
 * DATABASE_SSL=no-verify = encrypted without CA verification (only when the provider CA is not available).
 * Otherwise the connection string's own sslmode applies.
 */
function sslConfig(): pg.PoolConfig['ssl'] {
  if (process.env.DATABASE_SSL_CA) return { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  if (process.env.DATABASE_SSL === 'no-verify') return { rejectUnauthorized: false };
  return undefined;
}

/** DATABASE_POOL_MAX as a usable pool size: a whole number of at least 2 (a transaction holds one connection while reads beside it need another); anything else is 10. */
function poolMax(): number {
  const n = Number(process.env.DATABASE_POOL_MAX || 10);
  return Number.isInteger(n) && n >= 2 ? n : 10;
}

export function createDb(connectionString: string, max = poolMax()): Db {
  const ssl = sslConfig();
  // When TLS is configured here, drop sslmode from the URL so it does not override the explicit settings.
  const cs = ssl ? connectionString.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '') : connectionString;
  // Transaction-mode poolers (e.g. Supabase Supavisor :6543) may not forward startup parameters;
  // there, set statement_timeout on the database role instead (see docs/operations.md).
  const pooled = process.env.DATABASE_POOLER === 'transaction';
  // Opening a connection to a remote database costs several round trips (TCP, TLS, authentication), far more
  // than a query. Idle connections are therefore kept for 5 minutes (DATABASE_POOL_IDLE_MS) instead of 30 s, so
  // a visitor who pauses between two steps of an order does not pay for a new connection on the next one, and
  // TCP keep-alive stops NAT gateways and poolers from silently dropping them in the meantime.
  const idleMs = Number(process.env.DATABASE_POOL_IDLE_MS || 300_000);
  const pool = new pg.Pool({
    connectionString: cs, max, ssl, connectionTimeoutMillis: 10000, idleTimeoutMillis: Number.isFinite(idleMs) && idleMs >= 1000 ? idleMs : 300_000,
    keepAlive: true, keepAliveInitialDelayMillis: 30_000,
    ...(pooled ? {} : { statement_timeout: 15000 }),
  });
  pool.on('error', (err) => {
    // Idle client errors must not crash the process.
    console.error('[db] idle client error', err.message);
  });
  // Keep-warm (production only, DATABASE_KEEPWARM_MS, default one minute, 0 switches it off): two connections
  // are opened at start-up and each answers one `SELECT 1` per interval, so neither the pool's idle timeout nor
  // a pooler or NAT gateway in between closes them, and a visitor's first request after a quiet period does not
  // pay for TCP, TLS and authentication to a remote database. Two, because a request runs at most two
  // statements side by side. The timer never keeps the process alive.
  const warmMs = process.env.NODE_ENV === 'production' ? Number(process.env.DATABASE_KEEPWARM_MS ?? 60_000) : 0;
  let warmTimer: NodeJS.Timeout | undefined;
  if (Number.isFinite(warmMs) && warmMs > 0) {
    const ping = () => {
      // Sent together, so they use two different connections.
      for (let i = 0; i < Math.min(2, max); i++) pool.query('SELECT 1').catch(() => {});
    };
    ping();
    warmTimer = setInterval(ping, Math.max(warmMs, 5_000));
    warmTimer.unref();
  }
  // "BEGIN; <lock statement>" in one message (DATABASE_TX_LEAD=off switches it off). If the database or a pooler
  // in between does not take it, the transaction is rolled back, started the plain way, and the form is not used again.
  let leadOk = process.env.DATABASE_TX_LEAD !== 'off';
  const query = async <T>(sql: string, params: unknown[] = []) => {
    const r = await pool.query(sql, params as any[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  };
  return {
    query,
    async tx<T>(fn: (q: Queryable, lead?: any[]) => Promise<T>, opts: { lead?: string } = {}): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        try {
          let lead: any[] | undefined;
          if (opts.lead && leadOk) {
            try {
              // No parameters, so this is one simple-protocol message with two statements: two results come back.
              const res = (await client.query(`BEGIN; ${opts.lead}`)) as unknown;
              const last = Array.isArray(res) && res.length === 2 ? (res[1] as pg.QueryResult) : undefined;
              if (!last || !Array.isArray(last.rows) || (client as any).getTransactionStatus?.() !== 'T') throw new Error('unexpected answer to a two-statement message');
              lead = last.rows;
            } catch (e: any) {
              if (LEAD_ORDINARY_ERRORS.has(e?.code)) throw e;
              // Nothing was written (the statement is a SELECT): start again the plain way, for good.
              leadOk = false;
              console.warn('[db] "BEGIN; <lock>" in one message is not available here, using separate statements:', e?.message ?? e);
              await client.query('ROLLBACK').catch(() => {});
              await client.query('BEGIN');
            }
          } else {
            await client.query('BEGIN');
          }
          const q: Queryable = {
            query: async <R>(sql: string, params: unknown[] = []) => {
              const r = await client.query(sql, params as any[]);
              return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
            },
          };
          const out = await fn(q, lead);
          await client.query('COMMIT');
          return out;
        } catch (e: any) {
          await client.query('ROLLBACK').catch(() => {});
          // 40001 serialization_failure, 40P01 deadlock_detected
          if ((e?.code === '40001' || e?.code === '40P01') && attempt < 3) continue;
          throw e;
        } finally {
          client.release();
        }
      }
    },
    async close() {
      if (warmTimer) clearInterval(warmTimer);
      await pool.end();
    },
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * DATABASE_URL may list several candidates separated by "|" (e.g. two pooler hosts); the first
 * reachable one is used. With a single candidate this is just createDb (no ping, so startup errors
 * surface from the first real query as before).
 */
export async function createDbFromCandidates(
  databaseUrl: string,
  max?: number,
  warn: (m: string) => void = (m) => console.warn(m),
): Promise<Db> {
  const candidates = databaseUrl.split('|').map((s) => s.trim()).filter(Boolean);
  if (!candidates.length) throw new Error('DATABASE_URL is empty');
  let db = createDb(candidates[0], max);
  for (let i = 0; i < candidates.length - 1 && !(await db.ping()); i++) {
    await db.close().catch(() => {});
    warn(`[db] candidate ${i + 1} unreachable, trying next`);
    db = createDb(candidates[i + 1], max);
  }
  return db;
}
