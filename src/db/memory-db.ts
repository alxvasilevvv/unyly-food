// An in-process Postgres for the public web demo (DEMO_DB=memory): PGlite, the real PostgreSQL compiled to
// WebAssembly, running inside this Node process with its data in memory. The demo data is disposable
// (fictional guests, gone after a restart), so it does not need the shared database and its network latency.
//
// The returned object implements the same Db interface as the pg-based one in db.ts and is meant to behave the
// same for the callers: parameters are converted with node-pg's own rules, results are parsed with node-pg's
// own type parsers (including the BIGINT-as-number override of db.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
// For its side effect too: db.ts registers the BIGINT parser this module relies on.
import './db.js';
import type { Db, Queryable } from './db.js';
import { migrate } from './migrate.js';

export interface MemoryDbOptions {
  /** Postgres shared_buffers in MB. The default of PGlite (128) roughly doubles the memory of the process. */
  sharedBuffersMb?: number;
  /** How long a caller waits for the single connection before failing (ms). */
  lockTimeoutMs?: number;
  log?: (m: string) => void;
}

export interface MemoryDb extends Db {
  /** Reclaims the space of deleted and updated rows (there is no autovacuum in an embedded Postgres). */
  maintain(): Promise<void>;
}

// The start parameters PGlite uses by default (PGlite.defaultStartParams); listed here because passing
// `startParams` replaces them. Checked against the installed version in createMemoryDb.
const BASE_START_PARAMS = [
  '--single', '-F', '-O', '-j', '-c', 'search_path=public', '-c', 'exit_on_error=false', '-c', 'log_checkpoints=false',
  '-c', 'max_worker_processes=0', '-c', 'max_parallel_workers=0', '-c', 'max_parallel_workers_per_gather=0',
  '-c', 'io_method=sync', '-c', 'max_parallel_maintenance_workers=0',
];

/** Parameter conversion exactly as node-pg does it (Date, arrays, objects, numbers, booleans), whatever the column type. */
function serialize(v: unknown): string {
  const out = (pg as any).utils.prepareValue(v);
  if (Buffer.isBuffer(out)) return `\\x${out.toString('hex')}`;
  return out as string;
}
// PGlite looks a serializer up by the parameter's type OID; every OID gets the same node-pg conversion.
const SERIALIZERS: Record<number, (v: any) => string> = new Proxy({}, { get: () => serialize });

/** Result parsing by node-pg's type parsers (looked up per call, so overrides registered later still apply). */
function buildParsers(): Record<number, (v: string) => any> {
  const oids = new Set<unknown>([...Object.values(pgliteTypes as unknown as Record<string, unknown>), ...Object.values(pg.types.builtins as unknown as Record<string, number>)]);
  const out: Record<number, (v: string) => any> = {};
  for (const oid of oids) {
    if (typeof oid === 'number') out[oid] = (v) => pg.types.getTypeParser(oid, 'text')(v);
  }
  return out;
}

/** FIFO lock for the single connection. A waiter that gives up (timeout) is skipped when its turn comes. */
class Mutex {
  private locked = false;
  private waiters: { grant: () => void; gone: boolean }[] = [];
  async acquire(timeoutMs: number): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const w = { grant: () => {}, gone: false };
      const timer = setTimeout(() => {
        w.gone = true;
        reject(Object.assign(new Error(`memory database busy for more than ${timeoutMs} ms`), { code: '55P03' }));
      }, timeoutMs);
      w.grant = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(w);
    });
  }
  release() {
    for (;;) {
      const next = this.waiters.shift();
      if (!next) {
        this.locked = false;
        return;
      }
      if (next.gone) continue;
      next.grant(); // ownership passes on; `locked` stays true
      return;
    }
  }
}

/**
 * One level of an open transaction: the transaction itself or a nested tx() running as a savepoint.
 * Statements issued in parallel at one level (Promise.all) are queued on `tail`, so savepoints never interleave.
 */
interface TxScope { root: { active: boolean; savepoints: number }; tail: Promise<unknown> }

export async function createMemoryDb(opts: MemoryDbOptions = {}): Promise<MemoryDb> {
  const sharedBuffersMb = opts.sharedBuffersMb ?? 16;
  const lockTimeoutMs = opts.lockTimeoutMs ?? 20_000;
  const defaults: unknown = (PGlite as any).defaultStartParams;
  const base = Array.isArray(defaults) && defaults.every((x) => typeof x === 'string') ? (defaults as string[]) : BASE_START_PARAMS;
  const lite = new PGlite({
    // No dataDir: everything lives in memory and is gone when the process exits.
    relaxedDurability: true,
    startParams: [...base, '-c', `shared_buffers=${sharedBuffersMb}MB`],
    parsers: buildParsers(),
  });
  await lite.waitReady;
  // PGlite installs its own parsers for array types at start-up. node-pg's are used instead (for example
  // bigint[] stays an array of strings there), and array types node-pg does not know stay raw strings, as in pg.
  const arrays = await lite.query<{ typarray: number }>('SELECT typarray FROM pg_type WHERE typarray <> 0');
  for (const { typarray } of arrays.rows) {
    const oid = Number(typarray);
    lite.parsers[oid] = (v: string) => pg.types.getTypeParser(oid, 'text')(v);
  }

  const mutex = new Mutex();
  const scope = new AsyncLocalStorage<TxScope>();
  let closed = false;

  /** One statement on the connection. The caller holds the mutex (directly or through its transaction). */
  const run = async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> => {
    if (closed) throw new Error('memory database is closed');
    if (params && params.length) {
      const r = await lite.query<T>(sql, params as any[], { serializers: SERIALIZERS });
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    }
    // No parameters: the simple protocol, as node-pg does. It also accepts several statements in one string
    // (migrations); the result of the last one is returned.
    const all = await lite.exec(sql);
    const r = all[all.length - 1];
    return { rows: (r?.rows ?? []) as T[], rowCount: r?.rowCount ?? r?.rows.length ?? 0 };
  };

  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    await mutex.acquire(lockTimeoutMs);
    try {
      return await fn();
    } finally {
      mutex.release();
    }
  };

  /** Queues fn behind the other statements of the same transaction level. */
  const inLevel = <T>(s: TxScope, fn: () => Promise<T>): Promise<T> => {
    const out = s.tail.then(fn, fn);
    s.tail = out.catch(() => {});
    return out;
  };

  /** Runs fn between SAVEPOINT and RELEASE; an error rolls back to the savepoint and leaves the outer transaction usable. */
  const inSavepoint = <T>(s: TxScope, fn: () => Promise<T>): Promise<T> => inLevel(s, async () => {
    const name = `m${++s.root.savepoints}`;
    await run(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      await run(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await run(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`).catch(() => {});
      throw e;
    }
  });

  /** The innermost transaction level this async context is running in, if the transaction is still open. */
  const current = (): TxScope | undefined => {
    const s = scope.getStore();
    return s?.root.active ? s : undefined;
  };

  // Re-entrancy. PGlite has exactly one connection. Code that calls db.query() or db.tx() from inside a tx()
  // callback gets a second pooled connection on real Postgres; here that would wait forever for the mutex its own
  // transaction holds. So a call made from inside an open memory-db transaction (tracked per async context) runs
  // on the same connection, in a savepoint. Semantic difference to the pooled database: such nested work JOINS
  // the outer transaction. It sees the outer transaction's uncommitted rows, and it is rolled back together with
  // the outer transaction if that fails later (on real Postgres it would have committed on its own).
  const query = async <T>(sql: string, params: unknown[] = []) => {
    const s = current();
    // In a savepoint, so that a failing statement does not abort the surrounding transaction (as with a second connection).
    if (s) return inSavepoint(s, () => run<T>(sql, params));
    return withLock(() => run<T>(sql, params));
  };

  /** The handle given to a tx() callback: plain statements on the transaction's connection. */
  const handle = (root: TxScope['root']): Queryable => ({
    query: async <R>(sql: string, params: unknown[] = []) => {
      if (!root.active) throw new Error('memory database: this transaction handle is used after its transaction ended');
      const s = current();
      // Normally queued on the level the caller runs in. A caller that lost the async context still owns the connection.
      return s && s.root === root ? inLevel(s, () => run<R>(sql, params)) : run<R>(sql, params);
    },
  });

  const tx = async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
    const outer = current();
    if (outer) {
      // Nested tx(): a savepoint of the outer transaction, with its own level for the statements inside.
      return inSavepoint(outer, () => scope.run({ root: outer.root, tail: Promise.resolve() }, () => fn(handle(outer.root))));
    }
    return withLock(async () => {
      const root = { active: true, savepoints: 0 };
      await run('BEGIN');
      try {
        const out = await scope.run({ root, tail: Promise.resolve() }, () => fn(handle(root)));
        await run('COMMIT');
        return out;
      } catch (e) {
        await run('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        // Work started inside the callback but still running afterwards must queue like everyone else.
        root.active = false;
      }
    });
  };

  const db: MemoryDb = {
    query,
    tx,
    async close() {
      if (closed) return;
      await withLock(async () => {
        closed = true;
        await lite.close();
      }).catch(async () => {
        closed = true;
        await lite.close().catch(() => {});
      });
    },
    async ping() {
      try {
        await query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async maintain() {
      // VACUUM cannot run inside a transaction block; each statement goes on its own.
      await query('VACUUM');
      await query('CHECKPOINT');
    },
  };

  try {
    await migrate(db, opts.log);
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  return db;
}
