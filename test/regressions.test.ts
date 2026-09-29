// Regression tests for defects found in the independent review (see docs/testing.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestLoginCode, verifyLoginCode } from '../src/auth/session.js';
import { runJobsOnce } from '../src/jobs/worker.js';
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

describe('Review regressions', () => {
  it('login code attempts are counted and the code dies after 5 wrong guesses', async () => {
    const { devCode } = await requestLoginCode(h.ctx, 'victim@example.com', 'en');
    const wrong = devCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) await expect(verifyLoginCode(h.ctx, 'victim@example.com', wrong, 'en')).rejects.toThrow(/Wrong code/);
    const a = (await h.db.query(`SELECT attempts FROM login_codes WHERE email='victim@example.com'`)).rows[0].attempts;
    expect(a).toBe(5);
    await expect(verifyLoginCode(h.ctx, 'victim@example.com', devCode!, 'en')).rejects.toThrow(/too many attempts/);
  });

  it('no second checkout for a cart while an earlier submission is unknown', async () => {
    const before = await simCount();
    const { cart, quote, checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { timeoutAfterAccept: true, lookupUnavailable: true };
    await confirmOnWeb(h, u, checkout.checkout_id);
    h.ctx.providers.demo.faults = {};
    expect((await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id })).result.submission.status).toBe('unknown');
    const co2 = await u.mcp.call('prepare_checkout', { cart_id: cart.cart_id, quote_id: quote.quote_id });
    expect(co2.error.code).toBe('SUBMISSION_UNKNOWN');
    h.clock.advance(3 * 60_000);
    await runJobsOnce(h.ctx);
    expect((await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id })).result.submission.status).toBe('accepted');
    const co3 = await u.mcp.call('prepare_checkout', { cart_id: cart.cart_id, quote_id: quote.quote_id });
    expect(co3.error.code).toBe('CART_NOT_OPEN');
    expect((await simCount()) - before).toBe(1);
  });

  it('a cancellation interrupted by a crash is completed by the worker with the approved fee cap', async () => {
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const orderId = (await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id })).result.order_id;
    const p1 = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    // Approved and claimed, then the process died before calling the provider.
    await h.db.query(`UPDATE cancellation_requests SET status='executing', approved_at=$2, executing_at=$2 WHERE id=$1`, [p1.result.cancellation_id, h.clock.now()]);
    h.clock.advance(60_000); // still within free cancellation (demo: preparing after 2 min)
    await runJobsOnce(h.ctx);
    const s = (await h.db.query('SELECT status FROM cancellation_requests WHERE id=$1', [p1.result.cancellation_id])).rows[0].status;
    expect(s).toBe('executed');
    const sim = (await h.db.query(`SELECT s.status FROM demo_sim_orders s JOIN orders o ON o.provider_order_ref=s.ref WHERE o.id=$1`, [orderId])).rows[0].status;
    expect(sim).toBe('cancelled');
  });

  it('never cancels with a higher fee than the user approved; the request leaves the active set', async () => {
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const orderId = (await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id })).result.order_id;
    const p1 = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    expect(p1.result.fee.amount_minor).toBe(0);
    await h.db.query(`UPDATE cancellation_requests SET status='executing', approved_at=$2, executing_at=$2 WHERE id=$1`, [p1.result.cancellation_id, h.clock.now()]);
    h.clock.advance(3 * 60_000); // now preparing: 50% fee
    await runJobsOnce(h.ctx);
    const row = (await h.db.query('SELECT status, error_code FROM cancellation_requests WHERE id=$1', [p1.result.cancellation_id])).rows[0];
    expect(row).toEqual({ status: 'invalidated', error_code: 'FEE_CHANGED' });
    const p2 = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    expect(p2.ok).toBe(true);
    expect(p2.result.fee.amount_minor).toBeGreaterThan(0);
  });

  it('"not found" is not counted while the original call could still be running; late orders are discovered', async () => {
    const before = await simCount();
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.ctx.providers.demo.faults = { hangBeforeAccept: true };
    h.ctx.cfg.providerTimeoutMs = 300;
    const r = await confirmOnWeb(h, u, checkout.checkout_id);
    h.ctx.providers.demo.faults = {};
    h.ctx.cfg.providerTimeoutMs = 1500;
    expect(r.statusCode).toBe(302);
    let a = (await h.db.query('SELECT * FROM submission_attempts WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(a.status).toBe('unknown');
    expect(a.reconcile_attempts).toBe(0); // immediate lookup did not count
    for (let i = 0; i < 4; i++) {
      h.clock.advance(40 * 60_000);
      await runJobsOnce(h.ctx);
    }
    a = (await h.db.query('SELECT * FROM submission_attempts WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(a.error_code).toBe('NOT_RECEIVED_BY_PROVIDER');
    // The provider creates the order late (e.g. a delayed request finally processed).
    await h.db.query(`INSERT INTO demo_sim_orders (ref, idempotency_key, payload, total_minor, status) VALUES ('DEMO-LATE1', $1, '{"lines":[]}', $2, 'accepted')`, [a.idempotency_key, checkout.total.amount_minor]);
    h.clock.advance(11 * 60_000);
    await runJobsOnce(h.ctx);
    a = (await h.db.query('SELECT * FROM submission_attempts WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(a.status).toBe('accepted');
    expect((await h.db.query('SELECT count(*)::int n FROM orders WHERE checkout_id=$1', [checkout.checkout_id])).rows[0].n).toBe(1);
    expect((await simCount()) - before).toBe(1);
  });

  it('CSRF origin check is exact, not a prefix match', async () => {
    const { checkout } = await preparedCheckout(u.mcp.call);
    const r = await h.app.inject({ method: 'POST', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie, origin: 'http://localhost:3000.evil.example' }, payload: { _csrf: u.csrf, total_minor: String(checkout.total.amount_minor) } });
    expect(r.statusCode).toBe(401);
  });

  it('pending events for unknown orders do not block newer events', async () => {
    for (let i = 0; i < 120; i++) {
      await h.db.query(`INSERT INTO provider_events (provider, event_id, order_ref, sequence, type, payload, occurred_at) VALUES ('demo', $1, 'NOPE', 1, 'order.status_changed', $2, now())`,
        [`junk:${i}`, JSON.stringify({ event_id: `junk:${i}`, order_ref: 'NOPE', sequence: 1, status: 'accepted', payment_status: 'unknown', occurred_at: new Date().toISOString() })]);
    }
    await runJobsOnce(h.ctx); // parks the junk with backoff
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    h.clock.advance(3 * 60_000);
    await runJobsOnce(h.ctx);
    const o = (await h.db.query('SELECT fulfillment_status FROM orders WHERE checkout_id=$1', [checkout.checkout_id])).rows[0];
    expect(o.fulfillment_status).toBe('preparing');
  });
});
