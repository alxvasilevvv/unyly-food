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
  /** Run fn inside a transaction. Serialization failures are retried a few times. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

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

export function createDb(connectionString: string, max = Number(process.env.DATABASE_POOL_MAX || 10)): Db {
  const ssl = sslConfig();
  // When TLS is configured here, drop sslmode from the URL so it does not override the explicit settings.
  const cs = ssl ? connectionString.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '') : connectionString;
  // Transaction-mode poolers (e.g. Supabase Supavisor :6543) may not forward startup parameters;
  // there, set statement_timeout on the database role instead (see docs/operations.md).
  const pooled = process.env.DATABASE_POOLER === 'transaction';
  const pool = new pg.Pool({ connectionString: cs, max, ssl, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, ...(pooled ? {} : { statement_timeout: 15000 }) });
  pool.on('error', (err) => {
    // Idle client errors must not crash the process.
    console.error('[db] idle client error', err.message);
  });
  const query = async <T>(sql: string, params: unknown[] = []) => {
    const r = await pool.query(sql, params as any[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  };
  return {
    query,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const q: Queryable = {
            query: async <R>(sql: string, params: unknown[] = []) => {
              const r = await client.query(sql, params as any[]);
              return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
            },
          };
          const out = await fn(q);
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
