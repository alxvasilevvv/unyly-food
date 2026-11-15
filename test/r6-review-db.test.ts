// Review of txLeading ("BEGIN; <lock SELECT>" in one message): what happens when the lead statement fails, when the
// callback fails, on retries, and that a connection never goes back to the pool inside an open transaction.
// With R6_POOLER_URL (a transaction-mode pooler in front of the test database) the same checks run through it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, Db, txLeading } from '../src/db/db.js';
import { UUID_RE } from '../src/domain/crypto.js';
import { TEST_DB } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e: any) => String(e?.code ?? e?.message));

function suite(name: string, url: string, leadEnv: string | undefined) {
  describe(name, () => {
    let admin: Db;
    const made: Db[] = [];
    const db = (max: number) => {
      const prev = process.env.DATABASE_TX_LEAD;
      if (leadEnv === undefined) delete process.env.DATABASE_TX_LEAD;
      else process.env.DATABASE_TX_LEAD = leadEnv;
      try {
        const d = createDb(url, max);
        made.push(d);
        return d;
      } finally {
        if (prev === undefined) delete process.env.DATABASE_TX_LEAD;
        else process.env.DATABASE_TX_LEAD = prev;
      }
    };
    /** Sessions of this database that sit in a transaction (open or failed) without running anything. */
    const idleInTx = async () => (await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
    )).rows[0].n as number;

    beforeAll(async () => {
      admin = createDb(TEST_DB, 2);
      await admin.query('CREATE TABLE IF NOT EXISTS r6_review_lock (id int PRIMARY KEY, n int NOT NULL DEFAULT 0)');
      await admin.query('INSERT INTO r6_review_lock (id) VALUES (1), (2) ON CONFLICT DO NOTHING');
    });
    afterAll(async () => {
      for (const d of made) await d.close().catch(() => {});
      await admin.close();
    });

    it('the lead statement and the callback run in one transaction; the lock is held until COMMIT', async () => {
      const d = db(3);
      const order: string[] = [];
      const first = txLeading(d, 'SELECT id, txid_current()::text AS x FROM r6_review_lock WHERE id = 1 FOR UPDATE', async (q, rows) => {
        expect(rows).toHaveLength(1);
        const mine = (await q.query('SELECT txid_current()::text AS x')).rows[0].x;
        expect(mine).toBe(rows[0].x);
        order.push('a-in');
        await sleep(150);
        await q.query('UPDATE r6_review_lock SET n = n + 1 WHERE id = 1');
        order.push('a-out');
      });
      await sleep(30);
      const second = txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 1 FOR UPDATE', async () => { order.push('b-in'); });
      await Promise.all([first, second]);
      expect(order).toEqual(['a-in', 'a-out', 'b-in']);
      expect(await idleInTx()).toBe(0);
    });

    it('a lead statement that fails: the error surfaces, the only connection comes back clean', async () => {
      const d = db(1);
      // Twice: the first failure may switch the one-message form off, the second takes whatever path is left.
      for (let i = 0; i < 2; i++) {
        expect(await code(txLeading(d, 'SELECT 1/0 AS boom', async () => 'unreachable'))).toBe('22012');
        expect(await idleInTx()).toBe(0);
        // The same (only) connection is usable and not inside a failed transaction.
        expect((await d.query('SELECT 41 + 1 AS n')).rows[0].n).toBe(42);
        expect(await d.tx(async (q) => (await q.query('SELECT 7 AS n')).rows[0].n)).toBe(7);
      }
      // A later transaction with a lead still locks and works.
      expect(await txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 2 FOR UPDATE', async (_q, rows) => rows.length)).toBe(1);
      expect(await idleInTx()).toBe(0);
    });

    it('a lock that cannot be taken (55P03) is reported as such and leaves nothing open', async () => {
      const d = db(2);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const holder = d.tx(async (q) => {
        await q.query('SELECT id FROM r6_review_lock WHERE id = 1 FOR UPDATE');
        await held;
      });
      await sleep(50);
      expect(await code(txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 1 FOR UPDATE NOWAIT', async () => 'no'))).toBe('55P03');
      release();
      await holder;
      expect(await idleInTx()).toBe(0);
      expect(await txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 1 FOR UPDATE NOWAIT', async (_q, rows) => rows.length)).toBe(1);
    });

    it('a callback that throws: everything is rolled back, the lock is released, the connection is clean', async () => {
      const d = db(1);
      const before = (await admin.query('SELECT n FROM r6_review_lock WHERE id = 2')).rows[0].n;
      const r = await code(txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 2 FOR UPDATE', async (q) => {
        await q.query('UPDATE r6_review_lock SET n = n + 100 WHERE id = 2');
        throw Object.assign(new Error('boom'), { code: 'APP' });
      }));
      expect(r).toBe('APP');
      expect((await admin.query('SELECT n FROM r6_review_lock WHERE id = 2')).rows[0].n).toBe(before);
      expect(await idleInTx()).toBe(0);
      // Not blocked: the row lock is gone.
      expect((await admin.query('SELECT id FROM r6_review_lock WHERE id = 2 FOR UPDATE NOWAIT')).rows).toHaveLength(1);
      expect((await d.query('SELECT 1 AS n')).rows[0].n).toBe(1);
    });

    it('a statement that fails inside the callback leaves no failed transaction on the connection', async () => {
      const d = db(1);
      const r = await code(txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 2 FOR UPDATE', async (q) => q.query('SELECT 1/0')));
      expect(r).toBe('22012');
      expect((await d.query('SELECT 1 AS n')).rows[0].n).toBe(1);
      expect(await idleInTx()).toBe(0);
    });

    it('serialization failures are retried from the lead statement on', async () => {
      const d = db(1);
      let runs = 0;
      const out = await txLeading(d, 'SELECT id FROM r6_review_lock WHERE id = 2 FOR UPDATE', async (q, rows) => {
        runs++;
        expect(rows).toHaveLength(1);
        await q.query('UPDATE r6_review_lock SET n = n + 1 WHERE id = 2');
        if (runs < 3) throw Object.assign(new Error('could not serialize'), { code: runs === 1 ? '40001' : '40P01' });
        return 'done';
      });
      expect(out).toBe('done');
      expect(runs).toBe(3);
      expect(await idleInTx()).toBe(0);
    });

    it('thirty transactions on two connections: every increment is kept, none is lost or doubled', async () => {
      const d = db(2);
      await admin.query('UPDATE r6_review_lock SET n = 0 WHERE id = 1');
      await Promise.all(Array.from({ length: 30 }, () => txLeading(d, 'SELECT n FROM r6_review_lock WHERE id = 1 FOR UPDATE', async (q, rows) => {
        await sleep(Math.random() * 5);
        // Read-modify-write from the locked row: only correct when the lock and the write share one transaction.
        await q.query('UPDATE r6_review_lock SET n = $1 WHERE id = 1', [rows[0].n + 1]);
      })));
      expect((await admin.query('SELECT n FROM r6_review_lock WHERE id = 1')).rows[0].n).toBe(30);
      expect(await idleInTx()).toBe(0);
    });
  });
}

suite('txLeading, default setting', TEST_DB, undefined);
suite('txLeading, switched on', TEST_DB, 'on');
suite('txLeading, switched off', TEST_DB, 'off');
if (process.env.R6_POOLER_URL) {
  suite('txLeading through a transaction-mode pooler, switched on', process.env.R6_POOLER_URL, 'on');
  suite('txLeading through a transaction-mode pooler, switched off', process.env.R6_POOLER_URL, 'off');
}

describe('ids that are inlined into a lead statement', () => {
  it('only a plain UUID passes the check', () => {
    expect(UUID_RE.test('00000000-0000-4000-8000-000000000000')).toBe(true);
    for (const bad of [
      "00000000-0000-4000-8000-000000000000'", "00000000-0000-4000-8000-000000000000\n", "\n00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000000' OR '1'='1", "00000000-0000-4000-8000-00000000000g", '', ' 00000000-0000-4000-8000-000000000000',
      "00000000-0000-4000-8000-000000000000\n'; DROP TABLE carts; --", '00000000000040008000000000000000', '{00000000-0000-4000-8000-000000000000}',
    ]) expect(UUID_RE.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('a pooler that drops the connection on "BEGIN; <statement>" in one message', () => {
  // The worst a pooler can do with the one-message form short of breaking transactions altogether: close the
  // client connection. The transaction has not started, so the request must still succeed the plain way.
  it('the request that finds out still succeeds, and later transactions use separate statements', async () => {
    const net = await import('node:net');
    const target = new URL(TEST_DB);
    let dropped = 0;
    const server = net.createServer((client) => {
      const up = net.connect(Number(target.port || 5432), target.hostname);
      client.on('data', (chunk: Buffer) => {
        if (chunk[0] === 0x51 && chunk.toString('latin1', 5, 11) === 'BEGIN;') {
          dropped++;
          client.destroy();
          up.destroy();
          return;
        }
        up.write(chunk);
      });
      up.on('data', (chunk: Buffer) => client.write(chunk));
      const end = () => { client.destroy(); up.destroy(); };
      client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const prev = process.env.DATABASE_TX_LEAD;
    delete process.env.DATABASE_TX_LEAD;
    const d = createDb(`postgres://${target.username}@127.0.0.1:${port}${target.pathname}`, 2);
    if (prev !== undefined) process.env.DATABASE_TX_LEAD = prev;
    const warn = console.warn;
    const errlog = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      const first = await txLeading(d, 'SELECT 5 AS n', async (q, rows) => rows[0].n + (await q.query('SELECT 1 AS n')).rows[0].n);
      expect(first).toBe(6);
      expect(dropped).toBe(1);
      for (let i = 0; i < 3; i++) expect(await txLeading(d, 'SELECT 5 AS n', async (_q, rows) => rows[0].n)).toBe(5);
      // Found out once, never tried again.
      expect(dropped).toBe(1);
    } finally {
      console.warn = warn;
      console.error = errlog;
      await d.close().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('a connection that dies while a transaction holds it', () => {
  it('the transaction fails with an error (no unhandled error event), the pool keeps working', async () => {
    const admin = createDb(TEST_DB, 1);
    const d = createDb(TEST_DB, 1);
    const errlog = console.error;
    console.error = () => {};
    try {
      for (const lead of [true, false]) {
        const run = async (q: { query: (sql: string) => Promise<{ rows: any[] }> }) => {
          const pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await admin.query('SELECT pg_terminate_backend($1)', [pid]);
          await sleep(100); // the server's goodbye arrives while no statement is running
          return q.query('SELECT 1 AS n');
        };
        const out = await (lead ? txLeading(d, 'SELECT 1 AS one', (q) => run(q)) : d.tx((q) => run(q))).then(() => 'OK', (e: any) => `failed: ${e?.message}`);
        expect(out).toMatch(/^failed: /);
        // The pool hands out a working connection afterwards (the dead one was not returned to it).
        expect((await d.query('SELECT 2 AS n')).rows[0].n).toBe(2);
        expect(await d.tx(async (q) => (await q.query('SELECT 3 AS n')).rows[0].n)).toBe(3);
      }
    } finally {
      console.error = errlog;
      await d.close().catch(() => {});
      await admin.close();
    }
  });
});
