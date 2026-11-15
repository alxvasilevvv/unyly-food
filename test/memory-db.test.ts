// The embedded database (DEMO_DB=memory) must answer like the pg-based one: same value types, same row counts,
// same error codes. Every case here runs on both and the answers are compared.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, Db } from '../src/db/db.js';
import { createMemoryDb, MemoryDb } from '../src/db/memory-db.js';
import { resetDb, TEST_DB } from './helpers.js';

let shared: Db;
let memory: MemoryDb;

beforeAll(async () => {
  await resetDb();
  shared = createDb(TEST_DB, 4);
  memory = await createMemoryDb();
  for (const db of [shared, memory]) {
    await db.query(`CREATE TABLE compat (id int PRIMARY KEY, name text UNIQUE, big bigint, amount numeric(12,2), at timestamptz, doc jsonb, tags text[], flag boolean, ref uuid)`);
  }
});
afterAll(async () => {
  await shared.close();
  await memory.close();
});

/** Runs the same statement on both databases. */
async function both<T = any>(sql: string, params?: unknown[]) {
  return { s: await shared.query<T>(sql, params), m: await memory.query<T>(sql, params) };
}

describe('Embedded database: same answers as Postgres over pg', () => {
  it('has the whole schema (same migrations, same bookkeeping)', async () => {
    const { s, m } = await both(`SELECT name FROM schema_migrations ORDER BY name`);
    expect(m.rows).toEqual(s.rows);
    const t = await both(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`);
    expect(t.m.rows).toEqual(t.s.rows);
  });

  it('returns the same JavaScript types', async () => {
    const sql = `SELECT 5::int4 AS i4, 9007199254740991::int8 AS i8, count(*) AS cnt, count(*)::int AS cnt4, 12.50::numeric AS num, 1.5::float8 AS f8,
      'x'::text AS t, true AS b, NULL::text AS nul, '2026-03-04T05:06:07.089Z'::timestamptz AS ts, '{"a":[1,{"b":null}]}'::jsonb AS jb, '[1,"2"]'::json AS js,
      ARRAY['a','b c','d"e',NULL]::text[] AS ta, ARRAY[1,2]::int[] AS ia, ARRAY[3,4]::bigint[] AS ba, '{}'::text[] AS empty,
      '7c9e6679-7425-40de-944b-e07fc1f90ae7'::uuid AS u, ARRAY['7c9e6679-7425-40de-944b-e07fc1f90ae7']::uuid[] AS ua,
      '\\xdeadbeef'::bytea AS by, sum(3::int8) AS sm, extract(epoch FROM interval '90 seconds') AS ep, 'a'::varchar(5) AS vc, 3::int2 AS i2`;
    const { s, m } = await both(sql);
    expect(m.rows).toEqual(s.rows);
    const r = m.rows[0];
    expect(r.i8).toBe(9007199254740991);
    expect(r.cnt).toBe(1);
    expect(r.num).toBe('12.50');
    expect(r.ts).toBeInstanceOf(Date);
    expect(r.ts.toISOString()).toBe('2026-03-04T05:06:07.089Z');
    expect(r.jb).toEqual({ a: [1, { b: null }] });
    expect(r.ta).toEqual(['a', 'b c', 'd"e', null]);
    expect(Buffer.isBuffer(r.by)).toBe(true);
    expect(m.rowCount).toBe(s.rowCount);
  });

  it('accepts parameters the way node-pg does', async () => {
    const at = new Date('2026-05-06T07:08:09.123Z');
    const ins = `INSERT INTO compat (id, name, big, amount, at, doc, tags, flag, ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`;
    const p1 = [1, 'one', 1234567890123, 10.5, at, JSON.stringify({ k: [1, 2], s: 'it\'s "q"' }), ['x', 'y, z', 'q"r', '{b}'], true, '7c9e6679-7425-40de-944b-e07fc1f90ae7'];
    const a = await both(ins, p1);
    expect(a.m).toEqual(a.s);
    expect(a.m.rows[0].at.getTime()).toBe(at.getTime());
    expect(a.m.rows[0].tags).toEqual(['x', 'y, z', 'q"r', '{b}']);
    // null, a number for a text column, an object for jsonb, a numeric string, an empty array.
    const b = await both(ins, [2, 42, null, '7.25', null, { direct: true }, [], false, null]);
    expect(b.m).toEqual(b.s);
    expect(b.m.rows[0].name).toBe('42');
    // = ANY($1) with JS arrays of ints, texts and uuids; casts on parameters; interval arithmetic with a parameter.
    for (const [sql, params] of [
      ['SELECT id FROM compat WHERE id = ANY($1) ORDER BY id', [[1, 2, 3]]],
      ['SELECT id FROM compat WHERE name = ANY($1::text[]) ORDER BY id', [['one', '42']]],
      ['SELECT id FROM compat WHERE ref = ANY($1) ORDER BY id', [['7c9e6679-7425-40de-944b-e07fc1f90ae7']]],
      ['SELECT id FROM compat WHERE ref = ANY($1::uuid[]) ORDER BY id', [[]]],
      ['SELECT $1::text AS a, $2::int + 1 AS b, $3::jsonb -> \'x\' AS c, $4::timestamptz AS d, $5::boolean AS e, $6::numeric AS f', ['t', '4', '{"x":5}', at.toISOString(), 'true', 3]],
      ['SELECT id FROM compat WHERE at > $1::timestamptz - make_interval(secs => $2) ORDER BY id', [at, 60]],
      ['SELECT COALESCE($1, \'dflt\') AS a, $2::text IS NULL AS b', [null, undefined]],
      ['SELECT jsonb_build_object(\'t\', $1::text, \'d\', $2::jsonb) AS o', ['x', JSON.stringify({ n: 1 })]],
      ['SELECT id FROM compat WHERE doc @> $1::jsonb', [JSON.stringify({ k: [1] })]],
      ['SELECT id FROM compat WHERE at <= $1 AND flag = $2 LIMIT $3', [at, true, 10]],
    ] as [string, unknown[]][]) {
      const r = await both(sql, params);
      expect(r.m, sql).toEqual(r.s);
    }
  });

  it('reports the same row counts', async () => {
    for (const [sql, params] of [
      ['UPDATE compat SET flag = NOT flag WHERE id = ANY($1)', [[1, 2, 99]]],
      ['UPDATE compat SET flag = flag WHERE id = 99', undefined],
      ['SELECT * FROM compat', undefined],
      ['SELECT * FROM compat WHERE id > $1', [1]],
      ['INSERT INTO compat (id, name) VALUES (10, \'ten\'), (11, \'eleven\') ON CONFLICT DO NOTHING', undefined],
      ['INSERT INTO compat (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [10, 'ten']],
      ['WITH d AS (DELETE FROM compat WHERE id = 10 RETURNING id) SELECT count(*)::int AS n FROM d', undefined],
      ['WITH u AS (UPDATE compat SET big = 1 WHERE id IN (1, 2) RETURNING id) INSERT INTO compat (id, name) SELECT id + 100, \'c\' || id FROM u', undefined],
      ['DELETE FROM compat WHERE id >= $1', [100]],
      ['DELETE FROM compat WHERE id = 11 RETURNING id, name', undefined],
      ['SELECT pg_advisory_xact_lock(hashtext($1))', ['k']],
    ] as [string, unknown[] | undefined][]) {
      const r = await both(sql, params);
      expect(r.m, sql).toEqual(r.s);
    }
  });

  it('fails with the same error codes and stays usable', async () => {
    const codes = async (sql: string, params?: unknown[]) => {
      const one = async (db: Db) => db.query(sql, params).then(() => null, (e: any) => ({ code: e.code, constraint: e.constraint ?? null }));
      return { s: await one(shared), m: await one(memory) };
    };
    for (const [sql, params] of [
      ['INSERT INTO compat (id, name) VALUES ($1, $2)', [1, 'dup']],
      ['INSERT INTO compat (id, name) VALUES ($1, $2)', [50, 'one']],
      ['INSERT INTO compat (id) VALUES (NULL)', undefined],
      ['SELECT * FROM no_such_table', undefined],
      ['SELECT $1::int', ['abc']],
      ['SELEC 1', undefined],
      ['INSERT INTO addresses (user_id, label, line1, city, country) VALUES ($1, \'a\', \'b\', \'c\', \'TH\')', ['7c9e6679-7425-40de-944b-e07fc1f90ae7']],
    ] as [string, unknown[] | undefined][]) {
      const r = await codes(sql, params);
      expect(r.m, sql).toEqual(r.s);
      expect(r.m?.code, sql).toMatch(/^[0-9A-Z]{5}$/);
    }
    expect((await memory.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    expect(await memory.ping()).toBe(true);
  });

  it('runs several statements in one string without parameters (migrations)', async () => {
    await memory.query(`CREATE TABLE multi_a (id int); INSERT INTO multi_a VALUES (1), (2); CREATE TABLE multi_b (id int);`);
    expect((await memory.query('SELECT count(*) AS n FROM multi_a')).rows[0].n).toBe(2);
  });

  it('commits and rolls back transactions like the pooled database', async () => {
    for (const db of [shared, memory]) {
      await db.query('DELETE FROM compat');
      const out = await db.tx(async (q) => {
        await q.query('INSERT INTO compat (id, name) VALUES (1, $1)', ['a']);
        return (await q.query('SELECT count(*) AS n FROM compat')).rows[0].n;
      });
      expect(out).toBe(1);
      await expect(db.tx(async (q) => {
        await q.query('INSERT INTO compat (id, name) VALUES (2, $1)', ['b']);
        throw new Error('boom');
      })).rejects.toThrow('boom');
      // A failing statement aborts the transaction; the error reaches the caller and nothing is left behind.
      await expect(db.tx(async (q) => {
        await q.query('INSERT INTO compat (id, name) VALUES (3, $1)', ['c']);
        await q.query('INSERT INTO compat (id, name) VALUES (1, $1)', ['dup']);
      })).rejects.toMatchObject({ code: '23505' });
      expect((await db.query('SELECT id FROM compat ORDER BY id')).rows).toEqual([{ id: 1 }]);
    }
  });

  it('serializes concurrent transactions on its single connection', async () => {
    await memory.query('DELETE FROM compat');
    await memory.query('INSERT INTO compat (id, big) VALUES (1, 0)');
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2
      ? memory.tx(async (q) => {
        const v = (await q.query('SELECT big FROM compat WHERE id = 1')).rows[0].big;
        await new Promise((r) => setTimeout(r, 1));
        await q.query('UPDATE compat SET big = $1 WHERE id = 1', [v + 1]);
      })
      : memory.query('UPDATE compat SET big = big + 1 WHERE id = 1'))));
    expect((await memory.query('SELECT big FROM compat WHERE id = 1')).rows[0].big).toBe(40);
  });

  it('db.query and db.tx called inside a transaction run on the same connection instead of deadlocking', async () => {
    await memory.query('DELETE FROM compat');
    const seen = await memory.tx(async (q) => {
      await q.query('INSERT INTO compat (id, name) VALUES (1, $1)', ['outer']);
      // On the pooled database this would be a second connection; here it joins the transaction and sees its rows.
      const inner = (await memory.query('SELECT count(*) AS n FROM compat')).rows[0].n;
      // A failing re-entrant statement must not abort the outer transaction.
      await expect(memory.query('INSERT INTO compat (id, name) VALUES (1, $1)', ['dup'])).rejects.toMatchObject({ code: '23505' });
      // Nested tx: a savepoint. Its rollback keeps the outer work.
      await expect(memory.tx(async (q2) => {
        await q2.query('INSERT INTO compat (id, name) VALUES (2, $1)', ['nested']);
        throw new Error('nested boom');
      })).rejects.toThrow('nested boom');
      await memory.tx(async (q2) => {
        await q2.query('INSERT INTO compat (id, name) VALUES (3, $1)', ['nested ok']);
        // Two levels down, with the outer handle and the plain db in parallel.
        await Promise.all([memory.query('SELECT 1'), q.query('SELECT 2'), q2.query('SELECT 3'), memory.tx((q3) => q3.query('INSERT INTO compat (id, name) VALUES (4, $1)', ['deep']))]);
      });
      // Parallel re-entrant statements, one of them failing.
      const par = await Promise.allSettled([memory.query('SELECT 1 AS a'), memory.query('SELECT nope'), memory.query('INSERT INTO compat (id, name) VALUES (5, $1)', ['par'])]);
      expect(par.map((x) => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      return inner;
    });
    expect(seen).toBe(1);
    expect((await memory.query('SELECT id FROM compat ORDER BY id')).rows.map((r) => r.id)).toEqual([1, 3, 4, 5]);
    // The nested work is rolled back with the outer transaction.
    await expect(memory.tx(async () => {
      await memory.query('INSERT INTO compat (id, name) VALUES (6, $1)', ['gone']);
      throw new Error('outer boom');
    })).rejects.toThrow('outer boom');
    expect((await memory.query('SELECT count(*) AS n FROM compat WHERE id = 6')).rows[0].n).toBe(0);
    // A statement started inside a transaction but running after it ended queues like any other.
    let late: Promise<unknown> = Promise.resolve();
    await memory.tx(async () => {
      late = new Promise((r) => setTimeout(r, 20)).then(() => memory.query('SELECT 7 AS v'));
    });
    expect(((await late) as any).rows).toEqual([{ v: 7 }]);
  });

  it('starts from a snapshot of its data directory, and ignores a broken one', async () => {
    await memory.query('DELETE FROM compat');
    await memory.query('INSERT INTO compat (id, name, doc) VALUES (1, $1, $2)', ['kept', JSON.stringify({ a: 1 })]);
    const dir = mkdtempSync(join(tmpdir(), 'unyly-snap-'));
    try {
      const file = join(dir, 'demo-db.tgz');
      writeFileSync(file, await memory.snapshot());
      const copy = await createMemoryDb({ snapshot: file });
      expect(copy.fromSnapshot).toBe(true);
      expect((await copy.query('SELECT id, name, doc FROM compat')).rows).toEqual([{ id: 1, name: 'kept', doc: { a: 1 } }]);
      expect((await copy.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n).toBe((await memory.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n);
      await copy.query('INSERT INTO compat (id, name) VALUES (2, $1)', ['new']);
      await copy.close();
      // The source keeps working after a snapshot was taken.
      expect((await memory.query('SELECT count(*) AS n FROM compat')).rows[0].n).toBe(1);
      writeFileSync(file, 'not a tarball');
      const notes: string[] = [];
      const empty = await createMemoryDb({ snapshot: file, log: (m) => notes.push(m) });
      expect(empty.fromSnapshot).toBe(false);
      expect(notes.some((m) => m.includes('not usable'))).toBe(true);
      expect((await empty.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe(0);
      await empty.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims space and refuses work after close', async () => {
    await memory.maintain();
    const tmp = await createMemoryDb();
    await tmp.close();
    await tmp.close();
    expect(await tmp.ping()).toBe(false);
  });
});
