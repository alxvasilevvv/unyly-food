import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobsOnce } from '../src/jobs/worker.js';
import { DEMO_SIGNATURE_HEADER } from '../src/providers/demo/provider.js';
import { confirmOnWeb, demoUser, Harness, preparedCheckout, startHarness } from './helpers.js';

let h: Harness;
let u: Awaited<ReturnType<typeof demoUser>>;
beforeAll(async () => {
  h = await startHarness();
  u = await demoUser(h);
});
afterAll(async () => {
  await u.mcp.close();
  await h.close();
});
const simCount = async () => (await h.db.query('SELECT count(*)::int n FROM demo_sim_orders')).rows[0].n as number;

describe('Unknown submission outcomes', () => {
  it('timeout after the provider accepted: reconciled by idempotency key, never resent', async () => {
    const before = await simCount();
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { timeoutAfterAccept: true };
    const r = await confirmOnWeb(h, u, checkout.checkout_id);
    h.ctx.providers.demo.faults = {};
    expect(r.statusCode).toBe(302);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id });
    expect(st.result.submission.status).toBe('accepted');
    expect(st.result.order_id).toBeTruthy();
    expect(await simCount()).toBe(before + 1);
  });

  it('timeout + reconciliation also failing → SUBMISSION_UNKNOWN, then resolved by the background job', async () => {
    const before = await simCount();
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { timeoutAfterAccept: true, lookupUnavailable: true };
    await confirmOnWeb(h, u, checkout.checkout_id);
    let st = await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id });
    expect(st.result.submission.status).toBe('unknown');
    expect(st.result.submission.message).toMatch(/will not resend/);
    // Assistant retries submit: must not reach the provider again.
    const again = await u.mcp.call('submit_order', { checkout_id: checkout.checkout_id });
    expect(again.result.status).toBe('unknown');
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).toMatch(/не будет отправлять заказ повторно|will not resend/);
    h.ctx.providers.demo.faults = {};
    h.clock.advance(2 * 60_000);
    await runJobsOnce(h.ctx);
    st = await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id });
    expect(st.result.submission.status).toBe('accepted');
    expect(await simCount()).toBe(before + 1);
  });

  it('provider definitely unavailable: rejected, not ordered, no demo substitution', async () => {
    const before = await simCount();
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { unavailable: true };
    const r = await confirmOnWeb(h, u, checkout.checkout_id);
    const search = await u.mcp.call('search_restaurants', {});
    h.ctx.providers.demo.faults = {};
    expect(r.statusCode).toBe(409);
    expect(search.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(search.result).toBeUndefined();
    expect(await simCount()).toBe(before);
  });

  it('status read with provider down returns last known data with a notice', async () => {
    const orders = await u.mcp.call('list_orders');
    const id = orders.result.orders[0].order_id;
    h.ctx.providers.demo.faults = { unavailable: true };
    const r = await u.mcp.call('get_order_status', { order_id: id });
    h.ctx.providers.demo.faults = {};
    expect(r.ok).toBe(true);
    expect(r.notices.join(' ')).toMatch(/PROVIDER_UNAVAILABLE: showing the last known status/);
  });
});

describe('Crash / restart recovery', () => {
  it('crash after provider accepted: a restarted instance reconciles to one order', async () => {
    const before = await simCount();
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { hangAfterAccept: true };
    h.ctx.cfg.providerTimeoutMs = 60_000;
    // The "old process" hangs mid-request (never answers).
    confirmOnWeb(h, u, checkout.checkout_id).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    const attempt = (await h.db.query('SELECT status FROM submission_attempts WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(attempt.status).toBe('in_flight');
    // "New process": fresh app/ctx on the same database, no faults.
    const h2 = await startHarness({ fresh: false });
    h2.clock.offsetMs = h.clock.offsetMs + 2 * 60_000;
    await runJobsOnce(h2.ctx);
    const a2 = (await h2.db.query('SELECT status FROM submission_attempts WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(a2.status).toBe('accepted');
    expect(await simCount()).toBe(before + 1);
    expect((await h2.db.query('SELECT count(*)::int n FROM orders WHERE checkout_id=$1', [checkout.checkout_id])).rows[0].n).toBe(1);
    await h2.close();
    h.ctx.providers.demo.faults = {};
    h.ctx.cfg.providerTimeoutMs = 1500;
  });

  it('crash before the provider received it: closed as NOT_RECEIVED after repeated checks, never auto-resent', async () => {
    const before = await simCount();
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { hangBeforeAccept: true };
    h.ctx.cfg.providerTimeoutMs = 60_000;
    confirmOnWeb(h, u, checkout.checkout_id).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    const h2 = await startHarness({ fresh: false });
    h2.clock.offsetMs = h.clock.offsetMs;
    for (let i = 0; i < 4; i++) {
      h2.clock.advance(40 * 60_000);
      await runJobsOnce(h2.ctx);
    }
    const a = (await h2.db.query('SELECT status, error_code FROM submission_attempts WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(a.status).toBe('rejected');
    expect(a.error_code).toBe('NOT_RECEIVED_BY_PROVIDER');
    expect(await simCount()).toBe(before);
    await h2.close();
    h.ctx.providers.demo.faults = {};
    h.ctx.cfg.providerTimeoutMs = 1500;
    h.clock.offsetMs = h2.clock.offsetMs;
  });
});

describe('Webhooks', () => {
  const post = (raw: string, sig?: string) =>
    h.app.inject({ method: 'POST', url: '/webhooks/demo', headers: { 'content-type': 'application/json', ...(sig ? { [DEMO_SIGNATURE_HEADER]: sig } : {}) }, payload: raw });

  it('rejects missing or wrong signatures', async () => {
    const raw = JSON.stringify({ events: [] });
    expect((await post(raw)).statusCode).toBe(401);
    expect((await post(raw, 't=1,v1=' + '0'.repeat(64))).statusCode).toBe(401);
    const stale = h.ctx.providers.demo.sign(raw, Math.floor(h.clock.now().getTime() / 1000) - 3600);
    expect((await post(raw, stale)).statusCode).toBe(401);
  });

  it('deduplicates repeats and ignores late (out-of-order) events', async () => {
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const order = (await h.db.query('SELECT * FROM orders WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    const ev = (seq: number, status: string) => ({ event_id: `${order.provider_order_ref}:x${seq}`, order_ref: order.provider_order_ref, sequence: seq, status, payment_status: 'not_charged_demo', occurred_at: h.clock.now().toISOString() });
    const send = async (events: any[]) => {
      const raw = JSON.stringify({ events });
      return (await post(raw, h.ctx.providers.demo.sign(raw))).json();
    };
    const r1 = await send([ev(3, 'picked_up')]);
    expect(r1.new).toBe(1);
    const dup = await send([ev(3, 'picked_up')]);
    expect(dup.duplicates).toBe(1);
    await send([ev(2, 'preparing')]); // late
    let o = (await h.db.query('SELECT fulfillment_status, status_version FROM orders WHERE id=$1', [order.id])).rows[0];
    expect(o.fulfillment_status).toBe('picked_up');
    expect(o.status_version).toBe(3);
    await send([ev(4, 'delivered')]);
    await send([ev(5, 'preparing')]); // bogus regression after terminal state
    o = (await h.db.query('SELECT fulfillment_status FROM orders WHERE id=$1', [order.id])).rows[0];
    expect(o.fulfillment_status).toBe('delivered');
  });

  it('an event that arrives before the order exists is kept and applied later', async () => {
    const raw = JSON.stringify({ events: [{ event_id: 'early:1', order_ref: 'DEMO-NOT-YET', sequence: 2, status: 'preparing', occurred_at: h.clock.now().toISOString() }] });
    const r = (await post(raw, h.ctx.providers.demo.sign(raw))).json();
    expect(r.new).toBe(1);
    const ev = (await h.db.query(`SELECT processed_at FROM provider_events WHERE event_id='early:1'`)).rows[0];
    expect(ev.processed_at).toBeNull();
  });
});
