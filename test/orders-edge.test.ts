import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMajor, formatMinor } from '../src/domain/money.js';
import { runJobsOnce } from '../src/jobs/worker.js';
import { addAddress } from '../src/services/users.js';
import { confirmOnWeb, demoUser, Harness, mcpClient, oauthToken, preparedCheckout, startHarness, webLogin } from './helpers.js';

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

describe('Menu and cart validation', () => {
  it('required modifier missing → MODIFIERS_INVALID with the required groups', async () => {
    const r = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-krapao', quantity: 1 }] });
    expect(r.error.code).toBe('MODIFIERS_INVALID');
    expect(r.error.details.required_groups[0].group_id).toBe('spice');
  });
  it('out of stock item → OUT_OF_STOCK', async () => {
    const r = await u.mcp.call('create_cart', { store_id: 'demo-r2', items: [{ item_id: 'r2-coconut', quantity: 1 }] });
    expect(r.error.code).toBe('OUT_OF_STOCK');
  });
  it('item going out of stock after carting is caught at quote', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    h.ctx.providers.demo.faults = { outOfStockItemIds: ['r1-greencurry'] };
    const q = await u.mcp.call('quote_cart', { cart_id: cart.result.cart_id });
    h.ctx.providers.demo.faults = {};
    expect(q.result.checkout_allowed).toBe(false);
    expect(q.result.issues[0].code).toBe('OUT_OF_STOCK');
    const p = await u.mcp.call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: q.result.quote_id });
    expect(p.error.code).toBe('OUT_OF_STOCK');
  });
  it('minimum order not met blocks checkout', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r2', items: [{ item_id: 'r2-springroll', quantity: 1 }] });
    const q = await u.mcp.call('quote_cart', { cart_id: cart.result.cart_id });
    expect(q.result.issues.map((i: any) => i.code)).toContain('MINIMUM_ORDER_NOT_MET');
    const p = await u.mcp.call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: q.result.quote_id });
    expect(p.error.code).toBe('MINIMUM_ORDER_NOT_MET');
  });
  it('closed restaurant and delivery outside zone are reported', async () => {
    const c1 = await u.mcp.call('create_cart', { store_id: 'demo-r4', items: [{ item_id: 'r4-burger', quantity: 1 }] });
    const q1 = await u.mcp.call('quote_cart', { cart_id: c1.result.cart_id });
    expect(q1.result.issues[0].code).toBe('RESTAURANT_CLOSED');
    const c2 = await u.mcp.call('create_cart', { store_id: 'demo-r5', items: [{ item_id: 'r5-chicken', quantity: 1 }] });
    const q2 = await u.mcp.call('quote_cart', { cart_id: c2.result.cart_id });
    expect(q2.result.issues.map((i: any) => i.code)).toContain('DELIVERY_UNAVAILABLE');
  });
  it('fees: small-order fee and promo discount are itemised', async () => {
    const small = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-rice', quantity: 1 }] });
    const qs = await u.mcp.call('quote_cart', { cart_id: small.result.cart_id });
    expect(qs.result.breakdown.small_order_fee.amount_minor).toBe(1000);
    const big = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-tomyum', quantity: 2, modifiers: [{ group_id: 'spice', option_ids: ['hot'] }] }] });
    const qb = await u.mcp.call('quote_cart', { cart_id: big.result.cart_id });
    expect(qb.result.breakdown.discount.amount_minor).toBe(-3200); // 10% of 320
    expect(qb.result.breakdown.total.amount_minor).toBe(32000 + 2500 + 1000 - 3200);
  });
  it('ambiguous address is rejected with the fields to fix', async () => {
    await expect(addAddress(h.ctx, u.userId, { label: 'X', line1: 'Sukhumvit', district: '', city: 'Bangkok', country: 'TH' }, false)).rejects.toMatchObject({ code: 'ADDRESS_AMBIGUOUS' });
    const r = await h.app.inject({ method: 'POST', url: '/app/addresses', headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, label: 'Work', line1: 'near the mall', district: 'x', city: 'Bangkok', country: 'TH' } });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/line1/);
  });
});

describe('Cancellation', () => {
  it('free before preparation; fee after; both require web confirmation', async () => {
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const orderId = (await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id })).result.order_id;
    h.clock.advance(3 * 60_000); // demo: preparing after 2 min
    await runJobsOnce(h.ctx);
    const prep = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    expect(prep.ok).toBe(true);
    expect(prep.result.fee.amount_minor).toBeGreaterThan(0);
    const early = await u.mcp.call('cancel_order', { cancellation_id: prep.result.cancellation_id });
    expect(early.error.code).toBe('CONFIRMATION_REQUIRED');
    const page = await h.app.inject({ url: `/confirm-cancel/${prep.result.cancellation_id}`, headers: { cookie: u.cookie } });
    expect(page.body).toContain(`name="fee_minor" value="${prep.result.fee.amount_minor}"`);
    const post = await h.app.inject({ method: 'POST', url: `/confirm-cancel/${prep.result.cancellation_id}`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, fee_minor: String(prep.result.fee.amount_minor) } });
    expect(post.statusCode).toBe(302);
    const after = await u.mcp.call('cancel_order', { cancellation_id: prep.result.cancellation_id });
    expect(after.result.status).toBe('executed');
    const st = await u.mcp.call('get_order_status', { order_id: orderId });
    expect(st.result.fulfillment_status).toBe('cancelled');
    const again = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    expect(again.error.code).toBe('CANCELLATION_NOT_ALLOWED');
  });

  it('cannot cancel once picked up', async () => {
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const orderId = (await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id })).result.order_id;
    h.clock.advance(16 * 60_000);
    const r = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    expect(r.error.code).toBe('CANCELLATION_NOT_ALLOWED');
  });
});

describe('Handoff and Live modes', () => {
  it('handoff: no search, free-text cart, verified link, no order created', async () => {
    const s = await webLogin(h, 'handoff@example.com');
    const modeRes = await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'handoff' } });
    expect(modeRes.statusCode).toBe(302);
    const tok = await oauthToken(h, s);
    const m = await mcpClient(h, tok.access_token);
    const caps = await m.call('get_capabilities');
    expect(caps.mode).toBe('handoff');
    expect(caps.result.current.capabilities.search_restaurants.available).toBe(false);
    const search = await m.call('search_stores', { query: 'thai' });
    expect(search.error.code).toBe('CAPABILITY_UNAVAILABLE');
    const cart = await m.call('create_cart', { store_name: 'My favourite Thai place', items: [{ name: 'Pad thai', quantity: 2 }, { name: 'Green curry', quantity: 1, note: 'not spicy' }] });
    expect(cart.ok).toBe(true);
    expect((await m.call('quote_cart', { cart_id: cart.result.cart_id })).error.code).toBe('CAPABILITY_UNAVAILABLE');
    const ho = await m.call('create_handoff', { cart_id: cart.result.cart_id });
    expect(ho.result.open_url).toBe('https://food.grab.com/th/en/');
    expect(ho.result.order_created).toBe(false);
    expect(ho.result.checklist).toHaveLength(2);
    expect((await m.call('list_orders')).result.orders).toHaveLength(0);
    await m.close();
  });

  it('live mode cannot be selected and every live capability is unavailable with a reason', async () => {
    const s = await webLogin(h, 'live@example.com');
    const r = await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'live' } });
    expect(r.statusCode).toBe(400);
    const caps = h.ctx.providers.live.capabilities();
    for (const c of Object.values(caps)) expect(c.available).toBe(false);
    expect(caps.submit_order.reason).toMatch(/partner agreement/);
  });
});

describe('Money', () => {
  it('parses and formats minor units without float drift', () => {
    expect(parseMajor('600', 'THB')).toBe(60000);
    expect(parseMajor('0.1', 'THB')).toBe(10);
    expect(parseMajor('19.99', 'THB')).toBe(1999);
    expect(() => parseMajor('1.999', 'THB')).toThrow();
    expect(formatMinor(26500, 'THB', 'en').replace(/\s/g, ' ')).toBe('฿265.00');
  });
});
