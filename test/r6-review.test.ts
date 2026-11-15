// Independent review of the round-6 confirmation path (approveAndSubmit, the combined statements, txLeading):
// real concurrency against Postgres with pauses injected between statements, crashes simulated by a database
// handle that stops answering, races with decline, cart updates, expiry and the web confirmation path.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, Config } from '../src/config.js';
import { createCtx, Ctx, OffsetClock } from '../src/context.js';
import { createDb, Db, Queryable } from '../src/db/db.js';
import { isDomainError } from '../src/domain/errors.js';
import { runJobsOnce } from '../src/jobs/worker.js';
import { WEB_DEMO_PARTNER } from '../src/partners/config.js';
import { confirmCheckout } from '../src/partners/core.js';
import { loadPartnerUser, partnerActor } from '../src/partners/users.js';
import { ariExamples } from '../src/partners/webdemo.js';
import { updateCart } from '../src/services/carts.js';
import { approveCheckout, declineCheckout, reconcileAttempt, submitOrder } from '../src/services/checkout.js';
import { resetDb, TEST_DB } from './helpers.js';

const EX = ariExamples('en');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Faults {
  /** Random pause (ms) before every statement, BEGIN and COMMIT. */
  jitter: number;
  /** Called before every statement; throwing simulates a process that died at that point (see `dead`). */
  before?: (sql: string, inTx: boolean) => void | Promise<void>;
}

/** A database handle with pauses between statements and a hook that can stop it. */
function faultyDb(db: Db, f: Faults): Db {
  const pause = () => (f.jitter > 0 ? sleep(Math.random() * f.jitter) : Promise.resolve());
  const gate = async (sql: string, inTx: boolean) => {
    await pause();
    await f.before?.(sql, inTx);
  };
  return {
    query: async (sql, params) => {
      await gate(sql, false);
      return db.query(sql, params);
    },
    tx: (fn, opts) => db.tx(async (q, lead) => {
      await pause();
      const w: Queryable = { query: async (sql, params) => { await gate(sql, true); return q.query(sql, params); } };
      const out = await fn(w, lead);
      await gate('COMMIT', true);
      return out;
    }, opts),
    close: () => db.close(),
    ping: () => db.ping(),
  };
}

interface Rig { app: FastifyInstance; ctx: Ctx; db: Db; raw: Db; clock: OffsetClock; faults: Faults; close(): Promise<void> }

async function rig(pool: number, cfg: Partial<Config> = {}, jitter = 0): Promise<Rig> {
  const conf = loadConfig({
    env: 'test', databaseUrl: TEST_DB, webOrigin: 'http://localhost:3000', mcpResourceUrl: 'http://localhost:3000/mcp', cookieSecure: false,
    devEchoLoginCode: true, providerTimeoutMs: 1500, demoTimeScale: 1, demoGuestSpeed: 12, runJobs: false, guestPerIpHourly: 100000, guestHourlyLimit: 100000, demoDb: 'shared', ...cfg,
  });
  const raw = createDb(conf.databaseUrl, pool);
  const faults: Faults = { jitter };
  const db = faultyDb(raw, faults);
  const clock = new OffsetClock();
  const ctx = createCtx(conf, db, clock);
  const app = await buildApp(ctx);
  await app.ready();
  return { app, ctx, db, raw, clock, faults, close: async () => { await app.close(); await raw.close(); } };
}

let sessions = 0;
class Visitor {
  cookie = '';
  private ip = `10.7.${Math.floor(++sessions / 250)}.${(sessions % 250) + 1}`;
  constructor(private r: Rig) {}
  private headers(post: boolean) {
    return { 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie: this.cookie, ...(post ? { 'content-type': 'application/json' } : {}) };
  }
  async post(path: string, body: unknown = {}) {
    const res = await this.r.app.inject({ method: 'POST', url: path, headers: this.headers(true), payload: JSON.stringify(body), remoteAddress: this.ip });
    const sc = res.headers['set-cookie'];
    if (sc) this.cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c: string) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.json() as any };
  }
  async get(path: string) {
    const res = await this.r.app.inject({ method: 'GET', url: path, headers: this.headers(false), remoteAddress: this.ip });
    return { status: res.statusCode, body: res.json() as any };
  }
  async start() {
    const s = await this.post('/ari/api/session');
    if (s.status !== 200) throw new Error(`session ${s.status} ${JSON.stringify(s.body)}`);
    return this;
  }
  /** A sentence to Ari, then the first option when Ari offers a choice. Returns the checkout card. */
  async checkout(text = EX[1]) {
    const m = await this.post('/ari/api/message', { text });
    let card = m.body.card;
    if (card?.type === 'options') {
      const opt = card.options.find((o: any) => o.action);
      card = (await this.post('/ari/api/action', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments })).body.card;
    }
    if (card?.type !== 'checkout') throw new Error(`no checkout card: ${JSON.stringify(m.body).slice(0, 400)}`);
    return card as { id: string; actions: any[] };
  }
  hashOf(card: { actions: any[] }) {
    return card.actions.find((x: any) => x.kind === 'confirm')?.endpoint.body.confirm_hash as string;
  }
  confirm(card: { id: string; actions: any[] }) {
    return this.post('/ari/api/confirm', { checkout_id: card.id, confirm_hash: this.hashOf(card) });
  }
}

/** Everything a confirmation may leave behind for one checkout. */
async function facts(db: Db, checkoutId: string) {
  const r = await db.query(
    `SELECT c.status, c.invalid_reason, c.user_id, c.cart_id, c.cart_version, k.status AS cart_status, k.version AS cart_now,
            (SELECT count(*)::int FROM submission_attempts a WHERE a.checkout_id = c.id) AS attempts,
            (SELECT a.status FROM submission_attempts a WHERE a.checkout_id = c.id) AS attempt_status,
            (SELECT count(*)::int FROM orders o WHERE o.checkout_id = c.id) AS orders,
            (SELECT count(*)::int FROM demo_sim_orders d WHERE d.idempotency_key = 'unyly-' || c.id::text) AS provider_orders,
            (SELECT count(*)::int FROM partner_webhooks w WHERE w.event_type = 'order.created' AND w.payload #>> '{data,checkout_id}' = c.id::text) AS created_events,
            (SELECT count(*)::int FROM partner_webhooks w WHERE w.event_type = 'checkout.confirmed' AND w.payload #>> '{data,checkout_id}' = c.id::text) AS confirmed_events,
            (SELECT count(*)::int FROM partner_confirmations p WHERE p.entity = 'checkout' AND p.entity_id = c.id) AS taps,
            (SELECT COALESCE(array_agg(l.action ORDER BY l.id), '{}') FROM audit_log l
              WHERE l.action <> 'checkout.prepared' AND ((l.entity = 'checkout' AND l.entity_id = c.id::text)
                 OR (l.entity = 'order' AND l.entity_id IN (SELECT o.id::text FROM orders o WHERE o.checkout_id = c.id))
                 OR (l.entity = 'submission' AND l.entity_id IN (SELECT a.id::text FROM submission_attempts a WHERE a.checkout_id = c.id)))) AS audit
       FROM checkouts c JOIN carts k ON k.id = c.cart_id WHERE c.id = $1`,
    [checkoutId],
  );
  return r.rows[0] as {
    status: string; invalid_reason: string | null; user_id: string; cart_id: string; cart_version: number; cart_status: string; cart_now: number;
    attempts: number; attempt_status: string | null; orders: number; provider_orders: number; created_events: number; confirmed_events: number; taps: number; audit: string[];
  };
}

const code = (e: unknown) => (isDomainError(e) ? e.code : `THROWN:${(e as any)?.code ?? ''}:${(e as any)?.message ?? e}`);
const settle = async <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, code: code(e) }));
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer within ${ms} ms (deadlock?)`)), ms).unref())]);

beforeAll(async () => {
  await resetDb();
});

describe('exactly once', () => {
  for (const pool of [1, 2, 10]) {
    it(`eight parallel confirmations of one checkout, pool of ${pool}, pauses between statements`, async () => {
      const r = await rig(pool, {}, 12);
      try {
        for (const text of [EX[0], EX[1]]) {
          const v = await new Visitor(r).start();
          const card = await v.checkout(text);
          const out = await within(Promise.all(Array.from({ length: 8 }, () => v.confirm(card))), 25_000, 'parallel confirm');
          expect(out.map((o) => o.status)).toEqual(Array(8).fill(200));
          const ids = new Set(out.map((o) => o.body.order_id));
          expect(ids.size).toBe(1);
          expect([...ids][0]).toBeTruthy();
          const f = await facts(r.raw, card.id);
          expect(f).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'accepted', orders: 1, provider_orders: 1, created_events: 1, confirmed_events: 1, taps: 1, cart_status: 'ordered' });
          // The audit trail of the flow as before the rewrite: approved, sent, accepted, each once and in this order.
          expect(f.audit).toEqual(['checkout.approved', 'submission.started', 'order.accepted']);
          // order.created is stored before checkout.confirmed, and the confirmed event names the order.
          const ev = (await r.raw.query(`SELECT event_type, payload #>> '{data,order_id}' AS order_id FROM partner_webhooks WHERE user_id = $1 AND event_type IN ('order.created','checkout.confirmed') ORDER BY id`, [f.user_id])).rows;
          expect(ev.map((e: any) => e.event_type)).toEqual(['order.created', 'checkout.confirmed']);
          expect(ev[1].order_id).toBe([...ids][0]);
        }
      } finally {
        await r.close();
      }
    }, 60_000);
  }

  it('the partner Confirm racing the web path (approveCheckout, submitOrder) and a bare submitOrder', async () => {
    const r = await rig(10, {}, 10);
    try {
      for (let i = 0; i < 6; i++) {
        const v = await new Visitor(r).start();
        const card = await v.checkout(i % 2 ? EX[0] : EX[1]);
        const userId = (await r.raw.query('SELECT user_id FROM checkouts WHERE id = $1', [card.id])).rows[0].user_id as string;
        const web = async () => {
          await approveCheckout(r.ctx, userId, card.id, { partnerVerification: 'tap' });
          return submitOrder(r.ctx, { userId, via: 'web' }, card.id);
        };
        const out = await within(Promise.all([
          v.confirm(card), settle(web()), v.confirm(card), settle(web()),
          settle(submitOrder(r.ctx, { userId, via: 'mcp', clientId: 'x' }, card.id)), v.confirm(card),
        ]), 25_000, 'mixed confirm');
        for (const o of out) {
          if ('status' in o) expect(o.status).toBe(200);
          // The bare submitOrder may arrive before any approval; nothing else may fail.
          else if (!o.ok) expect(o.code).toBe('CONFIRMATION_REQUIRED');
        }
        const f = await facts(r.raw, card.id);
        expect(f, JSON.stringify(f)).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'accepted', orders: 1, provider_orders: 1, created_events: 1, cart_status: 'ordered' });
        expect(f.confirmed_events).toBe(1);
        expect(f.audit.filter((a) => a === 'checkout.approved')).toHaveLength(1);
        expect(f.audit.filter((a) => a === 'submission.started')).toHaveLength(1);
        expect(f.audit.filter((a) => a === 'order.accepted')).toHaveLength(1);
      }
    } finally {
      await r.close();
    }
  }, 90_000);

  it('confirm racing decline: either declined with nothing sent, or one order', async () => {
    const r = await rig(10, {}, 8);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 14; i++) {
        const v = await new Visitor(r).start();
        const card = await v.checkout(EX[0]);
        const userId = (await r.raw.query('SELECT user_id FROM checkouts WHERE id = $1', [card.id])).rows[0].user_id as string;
        const out = await within(Promise.all([
          i % 2 ? v.confirm(card) : sleep(Math.random() * 10).then(() => v.confirm(card)),
          sleep(Math.random() * 20).then(() => v.post('/ari/api/decline', { checkout_id: card.id })),
          sleep(Math.random() * 20).then(() => settle(declineCheckout(r.ctx, userId, card.id))),
          v.confirm(card),
        ]), 25_000, 'confirm/decline');
        const f = await facts(r.raw, card.id);
        seen.add(f.status);
        if (f.status === 'declined') {
          expect(f, JSON.stringify(f)).toMatchObject({ attempts: 0, orders: 0, provider_orders: 0, created_events: 0, cart_status: 'open' });
          expect(f.audit).not.toContain('submission.started');
        } else {
          expect(f, JSON.stringify({ f, out })).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'accepted', orders: 1, provider_orders: 1, created_events: 1, confirmed_events: 1 });
          expect(f.audit).not.toContain('checkout.declined');
        }
        for (const o of out) if (o && 'status' in o) expect(o.status, JSON.stringify(o.body)).toBeLessThan(500);
      }
      expect(seen.size).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  }, 90_000);

  it('confirm racing a cart update: an order only for the cart version the user saw', async () => {
    const r = await rig(10, {}, 8);
    const outcomes = new Set<string>();
    try {
      for (let i = 0; i < 12; i++) {
        const v = await new Visitor(r).start();
        const card = await v.checkout(EX[1]);
        const c = (await r.raw.query('SELECT c.user_id, c.cart_id, c.cart_version, v.items FROM checkouts c JOIN cart_versions v ON v.cart_id = c.cart_id AND v.version = c.cart_version WHERE c.id = $1', [card.id])).rows[0];
        const line = c.items[0];
        const upd = settle(sleep(i % 2 ? 0 : Math.random() * 25).then(() => updateCart(r.ctx, partnerActor(WEB_DEMO_PARTNER, c.user_id), c.cart_id, c.cart_version, [{ op: 'set_quantity', line_id: line.line_id, quantity: line.quantity + 1 }])));
        const [a, b, u] = await within(Promise.all([sleep(Math.random() * 25).then(() => v.confirm(card)), sleep(i % 2 ? 5 + Math.random() * 30 : 0).then(() => v.confirm(card)), upd]), 25_000, 'confirm/update');
        outcomes.add(u.ok ? 'update' : 'order');
        const f = await facts(r.raw, card.id);
        expect(a.status).toBeLessThan(500);
        expect(b.status).toBeLessThan(500);
        if (f.orders) {
          // Ordered: the cart never moved past the approved version, and the update was refused.
          expect(f, JSON.stringify(f)).toMatchObject({ status: 'consumed', attempts: 1, orders: 1, provider_orders: 1, cart_status: 'ordered' });
          expect(f.cart_now).toBe(f.cart_version);
          expect(u.ok).toBe(false);
        } else {
          // The update won: nothing was sent for the old version.
          expect(u.ok, JSON.stringify(u)).toBe(true);
          expect(f, JSON.stringify(f)).toMatchObject({ attempts: 0, orders: 0, provider_orders: 0, created_events: 0, cart_status: 'open' });
          expect(f.cart_now).toBe(f.cart_version + 1);
          expect(['invalidated', 'awaiting_user']).toContain(f.status);
          expect(a.status).not.toBe(200);
        }
      }
      // Both orders of arrival happened in this run.
      expect([...outcomes].sort()).toEqual(['order', 'update']);
    } finally {
      await r.close();
    }
  }, 90_000);

  it('confirm racing expiry (the job statement) never leaves an expired checkout with a submission', async () => {
    const r = await rig(10, {}, 8);
    try {
      for (let i = 0; i < 12; i++) {
        const v = await new Visitor(r).start();
        const card = await v.checkout(EX[0]);
        const expire = () => r.db.query(`UPDATE checkouts SET status='expired', invalid_reason='EXPIRED' WHERE status IN ('awaiting_user','approved') AND id = $1`, [card.id]);
        const out = await within(Promise.all([v.confirm(card), sleep(Math.random() * 20).then(expire), v.confirm(card)]), 25_000, 'confirm/expiry');
        const f = await facts(r.raw, card.id);
        if (f.status === 'expired') expect(f, JSON.stringify(f)).toMatchObject({ attempts: 0, orders: 0, provider_orders: 0, created_events: 0 });
        else expect(f, JSON.stringify(f)).toMatchObject({ status: 'consumed', attempts: 1, orders: 1, provider_orders: 1, created_events: 1 });
        expect((out[0] as any).status).toBeLessThan(500);
        expect((out[2] as any).status).toBeLessThan(500);
      }
      // A card that is past its time when Confirm arrives: refused, marked expired, nothing sent.
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[0]);
      r.clock.advance(16 * 60_000);
      const [a, b] = await Promise.all([v.confirm(card), v.confirm(card)]);
      expect([a.status, b.status].every((s) => s >= 400 && s < 500)).toBe(true);
      expect(await facts(r.raw, card.id)).toMatchObject({ status: 'expired', attempts: 0, orders: 0, provider_orders: 0, taps: 1 });
    } finally {
      await r.close();
    }
  }, 90_000);

  it('confirm replays racing a cancellation of the order they created', async () => {
    const r = await rig(10, {}, 6);
    try {
      for (let i = 0; i < 5; i++) {
        const v = await new Visitor(r).start();
        const card = await v.checkout(EX[1]);
        const first = await v.confirm(card);
        expect(first.status).toBe(200);
        const k = await v.post('/ari/api/cancel', { order_id: first.body.order_id });
        const kc = k.body.card.actions.find((x: any) => x.kind === 'confirm');
        const out = await within(Promise.all([
          v.confirm(card), v.post('/ari/api/cancel/confirm', { cancellation_id: k.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash }),
          v.confirm(card), v.post('/ari/api/cancel/confirm', { cancellation_id: k.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash }),
        ]), 25_000, 'confirm/cancel');
        for (const o of out) expect(o.status, JSON.stringify(o.body)).toBe(200);
        expect(out[0].body.order_id).toBe(first.body.order_id);
        const f = await facts(r.raw, card.id);
        expect(f).toMatchObject({ status: 'consumed', attempts: 1, orders: 1, provider_orders: 1, created_events: 1, confirmed_events: 1 });
        const o = (await r.raw.query('SELECT fulfillment_status FROM orders WHERE id = $1', [first.body.order_id])).rows[0];
        expect(o.fulfillment_status).toBe('cancelled');
        const cx = (await r.raw.query(`SELECT count(*) FILTER (WHERE status = 'executed')::int AS executed, count(*)::int AS n FROM cancellation_requests WHERE order_id = $1`, [first.body.order_id])).rows[0];
        expect(cx).toEqual({ executed: 1, n: 1 });
        const audits = (await r.raw.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'order.cancelled' AND entity_id = $1`, [first.body.order_id])).rows[0];
        expect(audits.n).toBe(1);
      }
    } finally {
      await r.close();
    }
  }, 90_000);
});

describe('a process that dies in the middle', () => {
  class Dead extends Error {}
  /** From the first statement matching `at` on, this "process" gets no answer from the database any more. */
  const dieAt = (r: Rig, at: (sql: string) => boolean) => {
    let dead = false;
    r.faults.before = (sql) => {
      if (!dead && at(sql)) dead = true;
      if (dead) throw new Dead('process died');
    };
    return () => { r.faults.before = undefined; };
  };

  it('after the attempt is committed, before the provider was reached: in_flight, then reconciled as not received', async () => {
    const r = await rig(5);
    try {
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[1]);
      // The provider's first statement of the submission never runs.
      const revive = dieAt(r, (sql) => /demo_sim_orders/.test(sql));
      const res = await v.confirm(card);
      revive();
      expect(res.status).toBe(500);
      let f = await facts(r.raw, card.id);
      // What the old three-transaction path left at this point: confirmation consumed, tap recorded, attempt in flight, no order.
      expect(f).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'in_flight', orders: 0, provider_orders: 0, taps: 1, cart_status: 'open' });
      expect(f.audit).toEqual(['checkout.approved', 'submission.started']);
      // The user taps again: no second submission, the answer says it is still being checked.
      const again = await v.confirm(card);
      expect(again.status).toBe(200);
      expect(again.body.order_id ?? null).toBeNull();
      expect((await facts(r.raw, card.id)).attempts).toBe(1);
      // A new cart cannot be ordered around it... the same cart stays blocked until the outcome is known.
      const a = (await r.raw.query('SELECT id, next_reconcile_at FROM submission_attempts WHERE checkout_id = $1', [card.id])).rows[0];
      expect(a.next_reconcile_at).toBeTruthy();
      // Reconciliation: the provider has no order for the key; after the settling time it is closed as not received.
      for (let i = 0; i < 6; i++) {
        r.clock.advance(31 * 60_000);
        await runJobsOnce(r.ctx);
      }
      f = await facts(r.raw, card.id);
      expect(f).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'rejected', orders: 0, provider_orders: 0 });
    } finally {
      await r.close();
    }
  }, 60_000);

  it('after the provider accepted, before the order is stored: reconciliation stores exactly one order', async () => {
    const r = await rig(5);
    try {
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[1]);
      const revive = dieAt(r, (sql) => /INSERT INTO orders/.test(sql));
      const res = await v.confirm(card);
      revive();
      expect(res.status).toBe(500);
      let f = await facts(r.raw, card.id);
      expect(f).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'in_flight', orders: 0, provider_orders: 1, created_events: 0, confirmed_events: 0, taps: 1, cart_status: 'open' });
      // Reconciliation and three impatient taps at the same time.
      r.clock.advance(60_000);
      const a = (await r.raw.query('SELECT id FROM submission_attempts WHERE checkout_id = $1', [card.id])).rows[0];
      const out = await Promise.all([v.confirm(card), reconcileAttempt(r.ctx, a.id), runJobsOnce(r.ctx), v.confirm(card), reconcileAttempt(r.ctx, a.id), v.confirm(card)]);
      f = await facts(r.raw, card.id);
      expect(f, JSON.stringify(f)).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'accepted', orders: 1, provider_orders: 1, created_events: 1, cart_status: 'ordered' });
      expect(f.audit.filter((x) => x === 'order.accepted')).toHaveLength(1);
      const last = await v.confirm(card);
      expect(last.status).toBe(200);
      expect(last.body.order_id).toBeTruthy();
      expect((out[0] as any).status).toBe(200);
    } finally {
      await r.close();
    }
  }, 60_000);

  it('at COMMIT of the confirmation transaction: nothing is recorded, the next tap goes through', async () => {
    const r = await rig(5);
    try {
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[0]);
      const revive = dieAt(r, (sql) => sql === 'COMMIT');
      const res = await v.confirm(card);
      revive();
      expect(res.status).toBe(500);
      // Never a consumed confirmation with nothing recorded: the whole step rolled back, including the tap.
      expect(await facts(r.raw, card.id)).toMatchObject({ status: 'awaiting_user', attempts: 0, orders: 0, provider_orders: 0, taps: 0, audit: [] });
      const again = await v.confirm(card);
      expect(again.status).toBe(200);
      expect(await facts(r.raw, card.id)).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'accepted', orders: 1, provider_orders: 1, created_events: 1, confirmed_events: 1, taps: 1 });
    } finally {
      await r.close();
    }
  }, 60_000);

  it('a submission the provider refused in the meantime is never turned into an order by the accept statement', async () => {
    const r = await rig(5);
    try {
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[1]);
      // Just before the accept statement runs, the attempt is closed as refused (as a provider webhook or an operator would).
      r.faults.before = async (sql) => {
        if (/INSERT INTO orders/.test(sql)) {
          await r.raw.query(`UPDATE submission_attempts SET status='rejected', error_code='PROVIDER_REJECTED', finished_at=now(), next_reconcile_at=NULL WHERE checkout_id = $1`, [card.id]);
        }
      };
      const res = await v.confirm(card);
      r.faults.before = undefined;
      expect(res.status).toBeLessThan(500);
      const f = await facts(r.raw, card.id);
      expect(f, JSON.stringify(f)).toMatchObject({ attempts: 1, attempt_status: 'rejected', orders: 0, created_events: 0, cart_status: 'open' });
      expect(f.audit).not.toContain('order.accepted');
    } finally {
      await r.close();
    }
  }, 60_000);
});

describe('pool: no request waits for a connection while holding one', () => {
  const flow = async (r: Rig, i: number) => {
    const v = await new Visitor(r).start();
    const card = await v.checkout(EX[i % 7]);
    const c = await v.confirm(card);
    if (c.status !== 200) throw new Error(`confirm ${c.status} ${JSON.stringify(c.body)}`);
    await v.get(`/ari/api/orders/${c.body.order_id}?after=0`);
    await v.get('/ari/api/events?after=0');
    const k = await v.post('/ari/api/cancel', { order_id: c.body.order_id });
    const kc = k.body.card?.actions.find((x: any) => x.kind === 'confirm');
    if (kc) await v.post('/ari/api/cancel/confirm', { cancellation_id: k.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash });
    const o = await v.get(`/ari/api/orders/${c.body.order_id}`);
    return o.body.card?.status?.code as string;
  };
  for (const pool of [1, 2, 3]) {
    it(`ten visitors side by side on a pool of ${pool}${pool > 1 ? ', with the background jobs running' : ''}`, async () => {
      const r = await rig(pool, {}, 4);
      let stop = false;
      // The job runner holds one connection per step while the step uses another, so it needs a pool of two.
      const jobs = pool > 1 ? (async () => { while (!stop) { await runJobsOnce(r.ctx); await sleep(20); } })() : Promise.resolve();
      try {
        const out = await within(Promise.all(Array.from({ length: 10 }, (_, i) => flow(r, i))), 45_000, `10 flows, pool ${pool}`);
        expect(out).toHaveLength(10);
        for (const s of out) expect(['cancelled', 'accepted', 'preparing', 'picked_up', 'delivered']).toContain(s);
      } finally {
        stop = true;
        await within(jobs, 20_000, 'jobs').catch(() => {});
        await r.close();
      }
    }, 90_000);
  }
});

describe('authorization', () => {
  it('another demo session can neither confirm, decline, read nor cancel', async () => {
    const r = await rig(5);
    try {
      const a = await new Visitor(r).start();
      const b = await new Visitor(r).start();
      const card = await a.checkout(EX[1]);
      const hash = a.hashOf(card);
      const x1 = await b.post('/ari/api/confirm', { checkout_id: card.id, confirm_hash: hash });
      expect(x1.status).toBe(404);
      const x2 = await b.post('/ari/api/decline', { checkout_id: card.id });
      expect(x2.status).toBe(404);
      expect(await facts(r.raw, card.id)).toMatchObject({ status: 'awaiting_user', attempts: 0, orders: 0, taps: 0, audit: [] });
      const ok = await a.confirm(card);
      expect(ok.status).toBe(200);
      for (const path of [`/ari/api/orders/${ok.body.order_id}`, `/ari/api/orders/${ok.body.order_id}?after=0`]) {
        const g = await b.get(path);
        expect(g.status).toBe(404);
        expect(JSON.stringify(g.body)).not.toContain(ok.body.order_id);
        expect(g.body.card).toBeUndefined();
        expect(g.body.events).toBeUndefined();
      }
      // B's own events never carry A's order.
      const evB = await b.get('/ari/api/events?after=0');
      expect(JSON.stringify(evB.body)).not.toContain(ok.body.order_id);
      const k = await b.post('/ari/api/cancel', { order_id: ok.body.order_id });
      expect(k.status).toBe(404);
      const ka = await a.post('/ari/api/cancel', { order_id: ok.body.order_id });
      const kc = ka.body.card.actions.find((x: any) => x.kind === 'confirm');
      const kb = await b.post('/ari/api/cancel/confirm', { cancellation_id: ka.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash });
      expect(kb.status).toBe(404);
      expect((await r.raw.query('SELECT fulfillment_status FROM orders WHERE id = $1', [ok.body.order_id])).rows[0].fulfillment_status).not.toBe('cancelled');
      // Without a session nothing about the id is revealed, valid or not; the changed order of checks leaks nothing.
      const anon = new Visitor(r);
      for (const id of [card.id, 'not-a-uuid']) {
        const n1 = await anon.post('/ari/api/confirm', { checkout_id: id, confirm_hash: hash });
        expect(n1.status).toBe(401);
        const n2 = await anon.get(`/ari/api/orders/${id === card.id ? ok.body.order_id : id}`);
        expect(n2.status).toBe(401);
      }
    } finally {
      await r.close();
    }
  }, 60_000);

  it('the service layer refuses a checkout of another partner user, also when the caller hands in the row', async () => {
    const r = await rig(5);
    try {
      const a = await new Visitor(r).start();
      const b = await new Visitor(r).start();
      const card = await a.checkout(EX[0]);
      const rowA = (await r.raw.query('SELECT c.*, (SELECT expires_at FROM quotes WHERE id = c.quote_id) AS quote_expires_at FROM checkouts c WHERE c.id = $1', [card.id])).rows[0];
      const extB = (await r.raw.query(`SELECT pu.external_user_id FROM partner_users pu WHERE pu.user_id <> $1 ORDER BY pu.created_at DESC LIMIT 1`, [rowA.user_id])).rows[0].external_user_id;
      const uB = await loadPartnerUser(r.ctx, WEB_DEMO_PARTNER, extB);
      expect(uB.user_id).not.toBe(rowA.user_id);
      const body = { confirm_hash: a.hashOf(card), user_verification: 'biometric', confirmed_at: r.clock.now().toISOString() };
      expect(await settle(confirmCheckout(r.ctx, WEB_DEMO_PARTNER, uB, card.id, body))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await settle(confirmCheckout(r.ctx, WEB_DEMO_PARTNER, uB, card.id, body, { pre: rowA }))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await settle(submitOrder(r.ctx, partnerActor(WEB_DEMO_PARTNER, uB.user_id), card.id, { pre: rowA }))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await settle(declineCheckout(r.ctx, uB.user_id, card.id))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await facts(r.raw, card.id)).toMatchObject({ status: 'awaiting_user', attempts: 0, orders: 0, taps: 0, audit: [] });
      void b;
    } finally {
      await r.close();
    }
  }, 60_000);
});

describe('guards before anything is approved', () => {
  it('a wrong hash, paused submissions and a second tap after the pause', async () => {
    const r = await rig(5);
    try {
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[1]);
      const bad = await v.post('/ari/api/confirm', { checkout_id: card.id, confirm_hash: 'x'.repeat(40) });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(await facts(r.raw, card.id)).toMatchObject({ status: 'awaiting_user', attempts: 0, taps: 0, audit: [] });
      // New orders paused: the approval is stored (as approveCheckout did before submitOrder refused), nothing is sent.
      const before = (await r.raw.query(`SELECT value FROM settings WHERE key = 'submissions'`)).rows[0]?.value;
      await r.raw.query(`INSERT INTO settings (key, value) VALUES ('submissions', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...(before ?? {}), demo: false })]);
      const paused = await v.confirm(card);
      expect(paused.status).toBeGreaterThanOrEqual(400);
      expect(paused.body.error.code).toBe('SUBMISSIONS_PAUSED');
      let f = await facts(r.raw, card.id);
      expect(f).toMatchObject({ status: 'approved', attempts: 0, orders: 0, provider_orders: 0, taps: 1 });
      expect(f.audit).toEqual(['checkout.approved']);
      await r.raw.query(`UPDATE settings SET value = $1 WHERE key = 'submissions'`, [JSON.stringify({ ...(before ?? {}), demo: true })]);
      const [a, b] = await Promise.all([v.confirm(card), v.confirm(card)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      f = await facts(r.raw, card.id);
      expect(f).toMatchObject({ status: 'consumed', attempts: 1, attempt_status: 'accepted', orders: 1, provider_orders: 1, created_events: 1, taps: 1 });
      expect(f.audit).toEqual(['checkout.approved', 'submission.started', 'order.accepted']);
    } finally {
      await r.close();
    }
  }, 60_000);
});

describe('polls as single guarded statements', () => {
  it('parallel polls, the events job and a clock that moves: every status is written once, in order', async () => {
    const r = await rig(10, {}, 6);
    try {
      const v = await new Visitor(r).start();
      const card = await v.checkout(EX[1]);
      const c = await v.confirm(card);
      expect(c.status).toBe(200);
      const id = c.body.order_id as string;
      for (let step = 0; step < 30; step++) {
        const out = await within(Promise.all([
          ...Array.from({ length: 6 }, (_, i) => v.get(`/ari/api/orders/${id}${i % 2 ? '?after=0' : ''}`)),
          runJobsOnce(r.ctx),
        ]), 25_000, 'parallel polls');
        for (const o of out.slice(0, 6) as any[]) expect(o.status).toBe(200);
        if ((out[0] as any).body.card.status.is_final) break;
        r.clock.advance(20_000);
      }
      const o = (await r.raw.query('SELECT fulfillment_status, status_version FROM orders WHERE id = $1', [id])).rows[0];
      expect(o.fulfillment_status).toBe('delivered');
      const audit = (await r.raw.query(`SELECT details ->> 'status' AS s FROM audit_log WHERE action = 'order.status_changed' AND entity_id = $1 ORDER BY id`, [id])).rows.map((x: any) => x.s);
      // The first poll stores the provider's sequence for "accepted" (an audit row, no event: the status did not change).
      expect(audit).toEqual(['accepted', 'preparing', 'picked_up', 'delivered']);
      const ev = (await r.raw.query(`SELECT payload #>> '{data,status}' AS s FROM partner_webhooks WHERE event_type = 'order.status_changed' AND payload #>> '{data,order_id}' = $1 ORDER BY id`, [id])).rows.map((x: any) => x.s);
      expect(ev).toEqual(['preparing', 'picked_up', 'delivered']);
    } finally {
      await r.close();
    }
  }, 90_000);
});
