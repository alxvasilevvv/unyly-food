// Wall-clock depth of the /ari demo steps against a remote database. Production reaches Postgres through a
// pooler on another continent (about 235 ms per round trip), so what a visitor waits for is the LONGEST
// SEQUENTIAL CHAIN of round trips in a request, not their number: statements sent side by side cost one.
// Here every statement, BEGIN and COMMIT is delayed by a fixed time; the same step is timed with and without
// the delay, and the difference divided by the delay is the sequential depth.
import type { FastifyInstance } from 'fastify';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createCtx, OffsetClock } from '../src/context.js';
import { createDb, Db, Queryable, txLeading } from '../src/db/db.js';
import { countingDb, QueryCounter, resetDb, TEST_DB } from './helpers.js';

const DELAY_MS = 100;
const PROD_MS = 235;
let delay = 0;
const pause = () => (delay > 0 ? new Promise<void>((r) => setTimeout(r, delay)) : Promise.resolve());

/** Every round trip takes `delay` longer: a statement, BEGIN (with its lead statement when they travel together) and COMMIT. */
function slowDb(db: Db): Db {
  return {
    query: async (sql, params) => {
      await pause();
      return db.query(sql, params);
    },
    tx: (fn, opts) => db.tx(async (q, lead) => {
      await pause(); // BEGIN
      if (opts?.lead && !lead) await pause(); // the lock statement on its own when the database could not take it with BEGIN
      const slow: Queryable = {
        query: async (sql, params) => {
          await pause();
          return q.query(sql, params);
        },
      };
      // A lead the wrapped database did not run itself is run by fn through `slow`; its pause above is then counted twice, so skip one.
      const out = await fn(opts?.lead && !lead ? { query: (sql, params) => (sql === opts.lead ? q.query(sql, params) : slow.query(sql, params)) } : slow, lead);
      await pause(); // COMMIT
      return out;
    }, opts),
    close: () => db.close(),
    ping: () => db.ping(),
  };
}

let app: FastifyInstance;
let db: Db;
let counter: QueryCounter;
let clock: OffsetClock;

beforeAll(async () => {
  await resetDb();
  const cfg = loadConfig({
    env: 'test', databaseUrl: TEST_DB, webOrigin: 'http://localhost:3000', mcpResourceUrl: 'http://localhost:3000/mcp', cookieSecure: false,
    devEchoLoginCode: true, providerTimeoutMs: 1500, demoTimeScale: 1, demoGuestSpeed: 12, runJobs: false, guestPerIpHourly: 100, demoDb: 'shared',
  });
  const counted = countingDb(slowDb(createDb(cfg.databaseUrl, 10)));
  db = counted.db;
  counter = counted.counter;
  clock = new OffsetClock();
  app = await buildApp(createCtx(cfg, db, clock));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

interface Measure { trips: number; wall: number }
type Steps = Record<string, Measure>;

/** One visitor from the first page load to a delivered ride, each step measured. */
async function visitor(lang: string, text: string): Promise<Steps> {
  let cookie = '';
  const out: Steps = {};
  const call = async (name: string, method: 'GET' | 'POST', url: string, body?: unknown) => {
    counter.reset();
    const t0 = performance.now();
    const r = await app.inject({
      method, url, headers: { 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      payload: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    out[name] = { trips: counter.roundTrips, wall: performance.now() - t0 };
    const sc = r.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
    expect(r.statusCode, `${name}: ${r.body}`).toBeLessThan(300);
    return r.json() as any;
  };
  await call('session (new visitor)', 'POST', `/ari/api/session?lang=${lang}`);
  await call('session (returning)', 'POST', `/ari/api/session?lang=${lang}`);
  const m = await call('message', 'POST', `/ari/api/message?lang=${lang}`, { text });
  let card = m.card;
  if (card.type === 'options') {
    const opt = card.options.find((o: any) => o.action);
    card = (await call('action', 'POST', `/ari/api/action?lang=${lang}`, { tool: opt.action.tool.name, arguments: opt.action.tool.arguments })).card;
  }
  expect(card.type).toBe('checkout');
  const cf = card.actions.find((x: any) => x.kind === 'confirm');
  const c = await call('confirm', 'POST', `/ari/api/confirm?lang=${lang}`, { checkout_id: card.id, confirm_hash: cf.endpoint.body.confirm_hash });
  expect(c.card.type).toBe('order');
  const first = await call('order poll (first: provider sequence stored)', 'GET', `/ari/api/orders/${c.order_id}?lang=${lang}`);
  await call('order poll (no news)', 'GET', `/ari/api/orders/${c.order_id}?lang=${lang}`);
  const ev = await call('events poll', 'GET', `/ari/api/events?after=0&lang=${lang}`);
  expect(ev.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['order.created', 'checkout.confirmed']));
  const both = await call('order + events in one poll (?after=)', 'GET', `/ari/api/orders/${c.order_id}?lang=${lang}&after=${ev.events.at(-1).seq}`);
  expect(both.events).toEqual([]);
  clock.advance(6_000); // 2.4 simulated minutes at the demo speed: the next status, still cancellable (with a fee)
  const moved = await call('order poll (status changed)', 'GET', `/ari/api/orders/${c.order_id}?lang=${lang}&after=${ev.events.at(-1).seq}`);
  expect(moved.card.status.code).not.toBe(first.card.status.code);
  // The poll that picked the change up also returns its event.
  expect(moved.events.map((e: any) => e.type)).toContain('order.status_changed');
  const k = await call('cancel: terms card', 'POST', `/ari/api/cancel?lang=${lang}`, { order_id: c.order_id });
  if (k.card?.type === 'cancellation') {
    const kc = k.card.actions.find((x: any) => x.kind === 'confirm');
    const done = await call('cancel: confirm', 'POST', `/ari/api/cancel/confirm?lang=${lang}`, { cancellation_id: k.card.id, confirm_hash: kc.endpoint.body.confirm_hash });
    expect(done.card.status.code).toBe('cancelled');
  }
  const m2 = await call('message (2nd order)', 'POST', `/ari/api/message?lang=${lang}`, { text });
  const opt2 = m2.card.options.find((o: any) => o.action);
  const card2 = (await call('action (2nd order)', 'POST', `/ari/api/action?lang=${lang}`, { tool: opt2.action.tool.name, arguments: opt2.action.tool.arguments })).card;
  await call('decline', 'POST', `/ari/api/decline?lang=${lang}`, { checkout_id: card2.id });
  return out;
}

// Sequential round trips per step before this round, counted on the previous build with the same flows
// (everything ran one after another, apart from the two reads of a returning session that ran side by side).
const BEFORE: Record<string, Record<string, number>> = {
  ride: {
    'session (new visitor)': 7, 'session (returning)': 2, message: 2, action: 13, confirm: 37, 'order poll (first: provider sequence stored)': 8,
    'order poll (no news)': 3, 'events poll': 1, 'order poll (status changed)': 10, 'cancel: terms card': 9, 'cancel: confirm': 36, decline: 8,
  },
  food: {
    'session (new visitor)': 7, 'session (returning)': 2, message: 3, action: 16, confirm: 40, 'order poll (first: provider sequence stored)': 8,
    'order poll (no news)': 3, 'events poll': 1, 'order poll (status changed)': 10, 'cancel: terms card': 9, 'cancel: confirm': 36, decline: 8,
  },
};
// Sequential round trips allowed per step now. A change that adds a round trip to the chain of a step fails here.
const BUDGET: Record<string, Record<string, number>> = {
  ride: {
    'session (new visitor)': 5, 'session (returning)': 1, message: 1, action: 8, confirm: 7, 'order poll (first: provider sequence stored)': 2,
    'order poll (no news)': 1, 'events poll': 1, 'order + events in one poll (?after=)': 1, 'order poll (status changed)': 4, 'cancel: terms card': 2, 'cancel: confirm': 11, decline: 3,
  },
  food: {
    'session (new visitor)': 5, 'session (returning)': 1, message: 2, action: 9, confirm: 7, 'order poll (first: provider sequence stored)': 2,
    'order poll (no news)': 1, 'events poll': 1, 'order + events in one poll (?after=)': 1, 'order poll (status changed)': 4, 'cancel: terms card': 2, 'cancel: confirm': 11, decline: 3,
  },
};

describe('wall-clock depth of the demo steps with a slow database', () => {
  for (const [service, lang, text] of [
    ['ride', 'ru', 'Такси от Сиам Парагона до аэропорта Суварнабхуми'],
    ['food', 'en', 'Order tom yum'],
  ] as const) {
    it(`${service}: every step stays within its sequential round-trip budget`, async () => {
      delay = 0;
      await visitor(lang, text); // warm-up: modules, tool catalog, connections
      const fast = await visitor(lang, text);
      delay = DELAY_MS;
      const slow = await visitor(lang, text);
      delay = 0;
      const lines = [`\n${service} (${lang}), ${DELAY_MS} ms per round trip:`, 'step | round trips | sequential now | sequential before | est. production now | before'];
      const depths: Record<string, number> = {};
      for (const name of Object.keys(slow)) {
        const key = name.replace(' (2nd order)', '');
        // Local overhead (the same step without the delay) is taken off; what remains is delay x depth.
        // A chain cannot be longer than the number of round trips, which caps a reading inflated by a slow moment of the machine.
        const depth = Math.min(slow[name].trips, Math.max(0, Math.round((slow[name].wall - (fast[name]?.wall ?? 0)) / DELAY_MS)));
        const before = BEFORE[service][key];
        lines.push(`${name} | ${slow[name].trips} | ${depth} | ${before ?? '-'} | ${depth * PROD_MS} ms | ${before === undefined ? '-' : `${before * PROD_MS} ms`}`);
        if (!name.includes('2nd order')) depths[name] = depth;
      }
      if (process.env.R6_PERF_REPORT) appendFileSync(process.env.R6_PERF_REPORT, `${lines.join('\n')}\n`);
      for (const [name, depth] of Object.entries(depths)) {
        const budget = BUDGET[service][name];
        expect(budget, `no budget for "${name}"`).toBeDefined();
        expect(depth, `${name}: ${slow[name].trips} round trips, ${Math.round(slow[name].wall)} ms`).toBeLessThanOrEqual(budget);
        // Never more round trips in total than the sequential chain plus the one that may run beside it.
        expect(slow[name].trips, name).toBeLessThanOrEqual(budget + 1);
      }
    }, 120_000);
  }
});

describe('BEGIN together with the lock statement', () => {
  it('runs the lock inside the transaction, rolls back with it, and falls back to separate statements for good when the form is refused', async () => {
    const raw = createDb(TEST_DB, 4);
    try {
      await raw.query('CREATE TEMP TABLE IF NOT EXISTS r6_none (id int)'); // any statement: the pool is up
      await raw.query('CREATE TABLE IF NOT EXISTS r6_lead (id int PRIMARY KEY, v int NOT NULL)');
      await raw.query('INSERT INTO r6_lead (id, v) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET v = 0');
      // The rows of the lead come back, and the row lock it took is held by this transaction until COMMIT.
      const locked = await txLeading(raw, 'SELECT * FROM r6_lead WHERE id = 1 FOR UPDATE', async (q, rows) => {
        expect(rows).toEqual([{ id: 1, v: 0 }]);
        const other = await raw.query('SELECT id FROM r6_lead WHERE id = 1 FOR UPDATE SKIP LOCKED');
        await q.query('UPDATE r6_lead SET v = 1 WHERE id = 1');
        return other.rows.length;
      });
      expect(locked).toBe(0); // another connection could not take the lock
      expect((await raw.query('SELECT v FROM r6_lead WHERE id = 1')).rows[0].v).toBe(1);
      // An error inside rolls everything back.
      await expect(txLeading(raw, 'SELECT * FROM r6_lead WHERE id = 1 FOR UPDATE', async (q) => {
        await q.query('UPDATE r6_lead SET v = 2 WHERE id = 1');
        throw new Error('stop');
      })).rejects.toThrow('stop');
      expect((await raw.query('SELECT v FROM r6_lead WHERE id = 1')).rows[0].v).toBe(1);
      // Parallel transactions on the same row are serialized by the lead lock: no update is lost (each sees the row as the previous one left it).
      await Promise.all([1, 2, 3, 4, 5, 6].map(() => txLeading(raw, 'SELECT * FROM r6_lead WHERE id = 1 FOR UPDATE', async (q, rows) => {
        await q.query('UPDATE r6_lead SET v = $1 WHERE id = 1', [rows[0].v + 1]);
      })));
      expect((await raw.query('SELECT v FROM r6_lead WHERE id = 1')).rows[0].v).toBe(7);
      // A lead the server refuses: the transaction starts again the plain way (the statement then fails on its own
      // and is reported), and later transactions use separate statements and still work.
      await expect(txLeading(raw, 'SELECT 1 / 0 AS n', async () => 'unreachable')).rejects.toThrow(/division by zero/);
      const after = await txLeading(raw, 'SELECT * FROM r6_lead WHERE id = 1 FOR UPDATE', async (q, rows) => {
        await q.query('UPDATE r6_lead SET v = v + 10 WHERE id = 1');
        return rows[0].v;
      });
      expect(after).toBe(7);
      expect((await raw.query('SELECT v FROM r6_lead WHERE id = 1')).rows[0].v).toBe(17);
    } finally {
      await raw.query('DROP TABLE IF EXISTS r6_lead').catch(() => {});
      await raw.close();
    }
  });
});
