import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('Demo: full vertical flow over real MCP + OAuth', () => {
  it('lists the 14 tools with annotations and strict schemas', async () => {
    const { tools } = await u.mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_order', 'create_cart', 'create_handoff', 'get_capabilities', 'get_checkout_status', 'get_menu', 'get_order_status',
      'list_orders', 'prepare_cancellation', 'prepare_checkout', 'quote_cart', 'search_restaurants', 'submit_order', 'update_cart',
    ]);
    const submit = tools.find((t) => t.name === 'submit_order')!;
    expect(submit.annotations?.destructiveHint).toBe(true);
    expect(submit.inputSchema.additionalProperties).toBe(false);
    expect(tools.find((t) => t.name === 'get_menu')!.annotations?.readOnlyHint).toBe(true);
  });

  it('get_capabilities reports demo mode honestly', async () => {
    const r = await u.mcp.call('get_capabilities');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('demo');
    expect(r.notices[0]).toMatch(/DEMO MODE/);
    expect(r.result.current.capabilities.submit_order.available).toBe(true);
    expect(r.result.delivery_address).toEqual({ address_id: expect.any(String), label: 'Home', area: 'Watthana, Bangkok' });
  });

  it('search: dinner for two under 600 THB, no nuts', async () => {
    const r = await u.mcp.call('search_restaurants', { party_size: 2, budget_total_major: 600, exclude_allergens: ['peanut', 'tree_nut'], limit: 3 });
    expect(r.ok).toBe(true);
    expect(r.result.restaurants.length).toBe(3);
    expect(r.result.allergen_disclaimer).toMatch(/never marks a dish as safe/);
    for (const x of r.result.restaurants) {
      if (!x.suggestion) continue;
      expect(x.suggestion.within_budget).toBe(true);
      for (const it of x.suggestion.items) {
        expect(it.allergen_check.status).not.toBe('contains_excluded');
        expect(['unknown', 'none_declared']).toContain(it.allergen_check.status);
      }
    }
    // Closed restaurant and out-of-zone restaurant are never suggested as orderable.
    const names = r.result.restaurants.map((x: any) => x.restaurant.name);
    expect(names).not.toContain('Night Owl Burgers (Demo)');
  });

  it('order: cart → quote → checkout → user confirms on web → accepted → delivered via signed webhooks', async () => {
    const { cart, quote, checkout } = await preparedCheckout(u.mcp.call, [{ item_id: 'r1-krapao', quantity: 2, modifiers: [{ group_id: 'spice', option_ids: ['mild'] }] }, { item_id: 'r1-rice', quantity: 2 }]);
    // 2×95 + 2×20 = 230; delivery 25; service 10; no small-order fee (>=100), no promo (<300)
    expect(quote.breakdown.items_subtotal.amount_minor).toBe(23000);
    expect(quote.breakdown.delivery_fee.amount_minor).toBe(2500);
    expect(quote.breakdown.service_fee.amount_minor).toBe(1000);
    expect(quote.breakdown.total.amount_minor).toBe(26500);
    expect(checkout.confirm_url).toBe(`http://localhost:3000/confirm/${checkout.checkout_id}`);

    const early = await u.mcp.call('submit_order', { checkout_id: checkout.checkout_id });
    expect(early.isError).toBe(true);
    expect(early.error.code).toBe('CONFIRMATION_REQUIRED');

    const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Pad Kra Pao chicken with rice');
    expect(page.body).toContain('Spice level: Mild');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const post = await confirmOnWeb(h, u, checkout.checkout_id);
    expect(post.statusCode).toBe(302);

    const st = await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id });
    expect(st.result.status).toBe('consumed');
    expect(st.result.submission.status).toBe('accepted');
    const orderId = st.result.order_id;
    expect(orderId).toBeTruthy();

    // The assistant calling submit_order afterwards is an idempotent replay, not a second order.
    const replay = await u.mcp.call('submit_order', { checkout_id: checkout.checkout_id });
    expect(replay.ok).toBe(true);
    expect(replay.result.status).toBe('accepted');
    expect((await h.db.query('SELECT count(*)::int n FROM demo_sim_orders')).rows[0].n).toBe(1);

    let os = await u.mcp.call('get_order_status', { order_id: orderId });
    expect(os.result.fulfillment_status).toBe('accepted');
    expect(os.result.payment_status).toBe('not_charged_demo');

    // Move demo time forward; the simulator emits signed webhooks through the real ingestion path.
    h.clock.advance(3 * 60_000);
    await runJobsOnce(h.ctx);
    let o = (await h.db.query('SELECT fulfillment_status FROM orders WHERE id=$1', [orderId])).rows[0];
    expect(o.fulfillment_status).toBe('preparing');
    h.clock.advance(40 * 60_000);
    await runJobsOnce(h.ctx);
    o = (await h.db.query('SELECT fulfillment_status FROM orders WHERE id=$1', [orderId])).rows[0];
    expect(o.fulfillment_status).toBe('delivered');
    os = await u.mcp.call('get_order_status', { order_id: orderId });
    expect(os.result.is_final).toBe(true);

    const list = await u.mcp.call('list_orders');
    expect(list.result.orders[0].order_id).toBe(orderId);

    const orderPage = await h.app.inject({ method: 'GET', url: `/app/orders/${orderId}`, headers: { cookie: u.cookie } });
    expect(orderPage.body).toMatch(/Доставлен|Delivered/);
    expect(cart.cart_id).toBeTruthy();
  });

  it('reorder creates a NEW draft that must be re-quoted', async () => {
    const list = await u.mcp.call('list_orders');
    const r = await u.mcp.call('create_cart', { from_order_id: list.result.orders[0].order_id });
    expect(r.ok).toBe(true);
    expect(r.result.version).toBe(1);
    expect(r.result.status).toBe('open');
    expect(r.next_actions[0].tool).toBe('quote_cart');
  });
});
