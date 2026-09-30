// One-call preparation, slim envelope, actionable errors, checkout TTL / re-pricing, refreshCheckout, gifts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobsOnce } from '../src/jobs/worker.js';
import { buildMcpServer } from '../src/mcp/tools.js';
import { refreshCheckout } from '../src/services/checkout.js';
import { setSubmissionsEnabled } from '../src/services/common.js';
import { confirmOnWeb, demoUser, Harness, mcpClient, oauthToken, startHarness, webLogin } from './helpers.js';

let h: Harness;
let u: Awaited<ReturnType<typeof demoUser>>;
beforeAll(async () => {
  h = await startHarness();
  u = await demoUser(h, 'flow@example.com');
});
afterAll(async () => {
  await u.mcp.close();
  await h.close();
});
const simCount = async () => (await h.db.query('SELECT count(*)::int n FROM demo_sim_orders')).rows[0].n as number;

describe('One-call preparation', () => {
  it('taxi: estimate_trip -> create_cart -> (user confirms) -> get_checkout_status', async () => {
    const est = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM' });
    const pick = est.result.options.find((o: any) => o.item_id === 'justgrab');
    const cart = await u.mcp.call('create_cart', { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', items: [{ item_id: 'justgrab', quantity: 1 }] });
    expect(cart.ok).toBe(true);
    expect(cart.result.quote.breakdown.total.amount_minor).toBe(pick.estimated_total.amount_minor);
    expect(cart.result.quote.lines[0].name).toBe('JustGrab');
    expect(cart.result.checkout.confirm_url).toBe(`http://localhost:3000/confirm/${cart.result.checkout.checkout_id}`);
    expect(cart.result.checkout.total.amount_minor).toBe(cart.result.quote.breakdown.total.amount_minor);
    const ttl = new Date(cart.result.checkout.expires_at).getTime() - h.clock.now().getTime();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(cart.next_actions[0].tool).toBe('get_checkout_status');
    // Nothing was ordered by the assistant.
    expect(await simCount()).toBe(0);
    const early = await u.mcp.call('get_checkout_status', { checkout_id: cart.result.checkout.checkout_id });
    expect(early.result.status).toBe('awaiting_user');
    expect(early.result.summary).toMatch(/press Confirm/);
    expect(early.next_actions).toEqual([]);

    await confirmOnWeb(h, u, cart.result.checkout.checkout_id);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: cart.result.checkout.checkout_id });
    expect(st.result.status).toBe('consumed');
    expect(st.result.submission.status).toBe('accepted');
    expect(st.result.order_id).toBeTruthy();
    expect(st.next_actions.map((n: any) => n.tool)).toEqual(['get_order_status']);
    expect(await simCount()).toBe(1);
  });

  it('flowers: search_stores -> create_cart with option ids from the search result', async () => {
    const s = await u.mcp.call('search_stores', { service: 'mart', category: 'flowers', query: 'roses' });
    expect(s.result.how_to_order).toMatch(/option_id/);
    const roses = s.result.stores[0].matching_items.find((i: any) => i.item_id === 'm3-roses');
    const group = roses.required_options[0];
    expect(group.options[0]).toEqual(expect.objectContaining({ option_id: expect.any(String), name: expect.any(String) }));
    const cart = await u.mcp.call('create_cart', {
      store_id: s.result.stores[0].store.store_id,
      items: [{ item_id: roses.item_id, quantity: 1, modifiers: [{ group_id: group.group_id, option_ids: [group.options[0].option_id] }], note: 'Happy birthday!' }],
    });
    expect(cart.ok).toBe(true);
    expect(cart.result.checkout.confirm_url).toContain('/confirm/');
    expect(cart.result.quote.checkout_allowed).toBe(true);
  });

  it('a blocked quote returns the issues and next actions instead of a link', async () => {
    const r = await u.mcp.call('create_cart', { store_id: 'demo-r4', items: [{ item_id: 'r4-burger', quantity: 1 }] });
    // demo-r4 is closed: the cart is saved, the quote lists the issue, no checkout is created.
    expect(r.ok).toBe(true);
    expect(r.result.checkout).toBeNull();
    expect(r.result.quote.issues.map((i: any) => i.code)).toContain('RESTAURANT_CLOSED');
    expect(r.next_actions[0].tool).toBe('search_stores');
    const heavy = await u.mcp.call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'ICONSIAM', parcel_weight_kg: 35, items: [{ item_id: 'express_bike', quantity: 1 }] });
    expect(heavy.result.checkout).toBeNull();
    const issue = heavy.result.quote.issues.find((i: any) => i.code === 'WEIGHT_LIMIT');
    expect(issue.message).toMatch(/Smallest vehicle that fits: Car \(item_id express_car/);
    expect(heavy.next_actions[0].tool).toBe('update_cart');
    // Swapping the vehicle in one update re-quotes and returns the link.
    const swap = await u.mcp.call('update_cart', {
      cart_id: heavy.result.cart_id, expected_version: 1,
      operations: [{ op: 'remove_item', line_id: heavy.result.items[0].line_id }, { op: 'add_item', item: { item_id: 'express_car', quantity: 1 } }],
    });
    expect(swap.ok).toBe(true);
    expect(swap.result.version).toBe(2);
    expect(swap.result.checkout.confirm_url).toContain('/confirm/');
  });

  it('when the quote itself fails, the cart is kept and checkout_blocked explains what to do', async () => {
    const s = await webLogin(h, 'noaddr@example.com');
    const m = await mcpClient(h, (await oauthToken(h, s)).access_token);
    const r = await m.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-rice', quantity: 1 }] });
    expect(r.ok).toBe(true);
    expect(r.result.cart_id).toBeTruthy();
    expect(r.result.checkout).toBeNull();
    expect(r.result.checkout_blocked.code).toBe('ADDRESS_REQUIRED');
    expect(r.result.checkout_blocked.user_action).toContain('http://localhost:3000/app/addresses');
    expect(r.next_actions[0].tool).toBe('update_cart');
    await m.close();
  });

  it('kill switch: the cart and quote are returned, the link is not', async () => {
    await setSubmissionsEnabled(h.db, 'demo', false);
    const r = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    await setSubmissionsEnabled(h.db, 'demo', true);
    expect(r.ok).toBe(true);
    expect(r.result.quote.breakdown.total.amount_minor).toBeGreaterThan(0);
    expect(r.result.checkout).toBeNull();
    expect(r.result.checkout_blocked.code).toBe('SUBMISSIONS_PAUSED');
  });

  it('handoff: create_cart returns the Grab link and checklist in the same call; handoff:true is refused in demo', async () => {
    const s = await webLogin(h, 'handoff-flow@example.com');
    await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'handoff' } });
    const m = await mcpClient(h, (await oauthToken(h, s)).access_token);
    const r = await m.call('create_cart', { service: 'ride', pickup: 'My condo', dropoff: 'Don Mueang airport' });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('handoff');
    expect(r.result.handoff).toMatchObject({ open_url: 'https://www.grab.com/th/en/transport/', order_created: false });
    expect(r.notices.join(' ')).toMatch(/No order has been created/);
    await m.close();
    const demo = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-rice', quantity: 1 }], handoff: true });
    expect(demo.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('Envelope and schemas', () => {
  it('no outputSchema, no tool field, no operation_id on success; operation_id kept on errors', async () => {
    const { tools } = await u.mcp.client.listTools();
    expect(tools.length).toBeLessThanOrEqual(15);
    for (const t of tools) expect((t as any).outputSchema).toBeUndefined();
    const ok = await u.mcp.call('get_store', { store_id: 'demo-r1' });
    expect(ok.tool).toBeUndefined();
    expect(ok.operation_id).toBeUndefined();
    expect(ok.mode).toBe('demo');
    expect(ok.result.mode).toBeUndefined();
    expect(ok.result.data_as_of).toBeUndefined();
    const bad = await u.mcp.call('get_store', { store_id: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('get_capabilities is compact', async () => {
    const r = await u.mcp.call('get_capabilities');
    expect(r.rawText.length).toBeLessThan(3500);
    expect(r.result.markets[0]).toEqual({ region: 'TH', currency: 'THB', demo_city: 'Bangkok', links_verified: true });
    expect(r.result.markets[1].demo_city).toBeUndefined();
  });

  it('null means omitted for optional arguments; unknown keys are still rejected', async () => {
    const r = await u.mcp.call('create_cart', {
      store_id: 'demo-r1', items: [{ item_id: 'r1-rice', quantity: 1, modifiers: null, note: null }],
      service: null, store_name: null, pickup: null, dropoff: null, address_id: null, deliver_to: null, from_order_id: null, checkout: null,
    });
    expect(r.ok).toBe(true);
    expect(r.result.checkout.confirm_url).toBeTruthy();
    const s = await u.mcp.call('search_stores', { service: null, query: 'curry', limit: null });
    expect(s.ok).toBe(true);
    const forged = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-rice', quantity: 1 }], confirmed: true });
    expect(forged.isError).toBe(true);
    const nullRequired = await u.mcp.call('get_store', { store_id: null });
    expect(nullRequired.isError).toBe(true);
  });

  it('INSUFFICIENT_SCOPE carries the mcp/www_authenticate challenge', async () => {
    const server = buildMcpServer(h.ctx, { userId: u.userId, via: 'mcp', clientId: 'pat:x', scopes: ['orders:read'] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r: any = await client.callTool({ name: 'create_cart', arguments: { store_id: 'demo-r1', items: [] } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE');
    const ch = r._meta['mcp/www_authenticate'][0];
    expect(ch).toMatch(/^Bearer /);
    expect(ch).toContain('error="insufficient_scope"');
    expect(ch).toContain('scope="orders:read orders:prepare"');
    expect(ch).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"');
    await client.close();
  });
});

describe('Actionable errors', () => {
  it('MODIFIERS_INVALID lists required groups with option ids and names', async () => {
    const r = await u.mcp.call('create_cart', { store_id: 'demo-m3', items: [{ item_id: 'm3-roses', quantity: 1 }] });
    expect(r.error.code).toBe('MODIFIERS_INVALID');
    const g = r.error.details.required_groups[0];
    expect(g.group_id).toBe('wrap');
    expect(g.options[0]).toEqual({ option_id: expect.any(String), name: expect.any(String) });
    expect(r.error.user_action).toMatch(/Ask the user to choose/);
    expect(r.next_actions.map((n: any) => n.tool)).toEqual(['create_cart', 'get_store']);
  });

  it('PLACE_AMBIGUOUS asks the user with suggestions', async () => {
    const r = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Siam Paragon', dropoff: 'airport' });
    expect(r.error.code).toBe('PLACE_AMBIGUOUS');
    expect(r.error.user_action).toMatch(/Ask the user which place/);
    expect(r.error.user_action).toMatch(/Suvarnabhumi/);
    expect(r.next_actions[0].tool).toBe('estimate_trip');
  });

  it('QUANTITY_LIMIT, TRIP_REQUIRED and VALIDATION_FAILED say what to do', async () => {
    const q = await u.mcp.call('create_cart', { store_id: 'demo-m4', items: [{ item_id: 'm4-paracetamol', quantity: 3 }] });
    expect(q.error.code).toBe('QUANTITY_LIMIT');
    expect(q.error.user_action).toMatch(/at most 2/);
    const t = await u.mcp.call('create_cart', { service: 'ride', items: [{ item_id: 'justgrab', quantity: 1 }] });
    expect(t.error.code).toBe('TRIP_REQUIRED');
    expect(t.error.user_action).toMatch(/pickup and drop-off/);
    const v = await u.mcp.call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'Asok', items: [{ item_id: 'express_bike', quantity: 1 }] });
    expect(v.error.code).toBe('VALIDATION_FAILED');
    expect(v.error.user_action).toMatch(/do not guess/);
  });
});

describe('Checkout TTL and re-pricing at approval', () => {
  it('a confirmation outlives the 5-minute quote; unchanged price is re-checked and the order goes through', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    const before = await simCount();
    h.clock.advance(8 * 60_000); // quote (5 min) is stale, confirmation (15 min) is not
    const r = await confirmOnWeb(h, u, cart.result.checkout.checkout_id);
    expect(r.statusCode).toBe(302);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: cart.result.checkout.checkout_id });
    expect(st.result.submission.status).toBe('accepted');
    expect(await simCount()).toBe(before + 1);
    const audit = await h.db.query(`SELECT details FROM audit_log WHERE action='checkout.approved' AND entity_id=$1`, [cart.result.checkout.checkout_id]);
    expect(audit.rows[0].details).toEqual({ repriced: true });
  });

  it('a changed price after the quote went stale invalidates with PRICE_CHANGED and orders nothing', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    const before = await simCount();
    h.clock.advance(6 * 60_000);
    h.ctx.providers.demo.faults = { priceBumpMinor: 500 };
    const r = await confirmOnWeb(h, u, cart.result.checkout.checkout_id);
    h.ctx.providers.demo.faults = {};
    expect(r.statusCode).toBe(409);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: cart.result.checkout.checkout_id });
    expect(st.result.status).toBe('invalidated');
    expect(st.result.invalid_reason).toBe('PRICE_CHANGED');
    expect(st.result.submission).toBeNull();
    expect(await simCount()).toBe(before);
  });
});

describe('refreshCheckout (refresh price button)', () => {
  it('re-quotes the same cart version into a new confirmation, reporting whether the price changed', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    const oldId = cart.result.checkout.checkout_id;
    h.clock.advance(16 * 60_000);
    const same = await refreshCheckout(h.ctx, u.userId, oldId);
    expect(same.checkout_id).not.toBe(oldId);
    expect(same.price_changed).toBe(false);
    expect(same.confirm_url).toBe(`http://localhost:3000/confirm/${same.checkout_id}`);
    const row = (await h.db.query('SELECT created_by, cart_version, status FROM checkouts WHERE id=$1', [same.checkout_id])).rows[0];
    expect(row.status).toBe('awaiting_user');
    expect(row.created_by).toMatch(/^mcp:/); // keeps the original requester shown on the page

    h.ctx.providers.demo.faults = { priceBumpMinor: 500 };
    const bumped = await refreshCheckout(h.ctx, u.userId, same.checkout_id);
    h.ctx.providers.demo.faults = {};
    expect(bumped.price_changed).toBe(true);
    expect(bumped.total_minor).toBe(bumped.previous_total_minor + 500);
    expect((await h.db.query('SELECT status, invalid_reason FROM checkouts WHERE id=$1', [same.checkout_id])).rows[0]).toEqual({ status: 'invalidated', invalid_reason: 'SUPERSEDED' });
  });

  it('refuses when the cart changed, and never for a confirmation that was used', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    const id = cart.result.checkout.checkout_id;
    await u.mcp.call('update_cart', { cart_id: cart.result.cart_id, expected_version: 1, operations: [{ op: 'add_item', item: { item_id: 'r1-rice', quantity: 1 } }], checkout: false });
    await expect(refreshCheckout(h.ctx, u.userId, id)).rejects.toMatchObject({ code: 'CONFIRMATION_INVALIDATED' });

    const c2 = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    await confirmOnWeb(h, u, c2.result.checkout.checkout_id);
    await expect(refreshCheckout(h.ctx, u.userId, c2.result.checkout.checkout_id)).rejects.toMatchObject({ code: 'CONFIRMATION_INVALIDATED' });
    // Another user's checkout is indistinguishable from a missing one.
    const other = await webLogin(h, 'other-refresh@example.com');
    await expect(refreshCheckout(h.ctx, other.userId, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Cart locking around submissions', () => {
  it('update_cart is blocked while a submission is unknown and after acceptance; the order uses the approved version', async () => {
    const cart = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    h.ctx.providers.demo.faults = { timeoutAfterAccept: true, lookupUnavailable: true };
    await confirmOnWeb(h, u, cart.result.checkout.checkout_id);
    h.ctx.providers.demo.faults = {};
    const blocked = await u.mcp.call('update_cart', { cart_id: cart.result.cart_id, expected_version: 1, operations: [{ op: 'add_item', item: { item_id: 'r1-rice', quantity: 1 } }] });
    expect(blocked.error.code).toBe('SUBMISSION_UNKNOWN');
    expect(blocked.next_actions[0].tool).toBe('get_checkout_status');

    // Simulate a cart version written behind the service's back (e.g. before this guard existed):
    // the recorded order must still describe what the human approved.
    const other = await h.db.query(
      `INSERT INTO addresses (user_id, label, line1, district, city, country, is_default) VALUES ($1,'Office','99 Silom Road','Bang Rak','Bangkok','TH',false) RETURNING id`, [u.userId]);
    await h.db.query(`INSERT INTO cart_versions (cart_id, version, items, address_id, trip) SELECT cart_id, 2, items, $2, trip FROM cart_versions WHERE cart_id=$1 AND version=1`, [cart.result.cart_id, other.rows[0].id]);
    await h.db.query('UPDATE carts SET version = 2 WHERE id = $1', [cart.result.cart_id]);
    h.clock.advance(3 * 60_000);
    await runJobsOnce(h.ctx);
    const o = (await h.db.query('SELECT address_label FROM orders WHERE checkout_id=$1', [cart.result.checkout.checkout_id])).rows[0];
    expect(o.address_label).toBe('Home');

    const after = await u.mcp.call('update_cart', { cart_id: cart.result.cart_id, expected_version: 2, operations: [{ op: 'add_item', item: { item_id: 'r1-rice', quantity: 1 } }] });
    expect(after.error.code).toBe('CART_NOT_OPEN');
    expect(after.next_actions[0].tool).toBe('create_cart');
  });
});

describe('Gifts: deliver_to', () => {
  const recipient = { name: 'Nok Somchai', phone: '+66 81 234 5678', address_line: '55/1 Soi Ari 4', district: 'phaya thai', city: 'Bangkok' };

  it('creates a one-off recipient address, uses it for this cart and shows it on the confirmation page', async () => {
    const r = await u.mcp.call('create_cart', {
      store_id: 'demo-m3', deliver_to: recipient,
      items: [{ item_id: 'm3-roses', quantity: 1, modifiers: [{ group_id: 'wrap', option_ids: ['box'] }], note: 'With love' }],
    });
    expect(r.ok).toBe(true);
    expect(r.result.delivery_address).toMatchObject({ label: 'Recipient: Nok Somchai', area: 'Phaya Thai, Bangkok' });
    expect(r.result.checkout.confirm_url).toBeTruthy();
    const row = (await h.db.query(`SELECT * FROM addresses WHERE user_id=$1 AND label='Recipient: Nok Somchai'`, [u.userId])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].is_default).toBe(false);
    expect(row[0].instructions).toContain('+66 81 234 5678');
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${r.result.checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).toContain('Recipient: Nok Somchai');
    expect(page.body).toContain('55/1 Soi Ari 4');
    // The same recipient again reuses the row; the default address is unchanged.
    const again = await u.mcp.call('create_cart', { store_id: 'demo-m3', deliver_to: recipient, items: [{ item_id: 'm3-orchid', quantity: 1 }] });
    expect(again.result.delivery_address.address_id).toBe(r.result.delivery_address.address_id);
    const def = (await h.db.query(`SELECT label FROM addresses WHERE user_id=$1 AND is_default`, [u.userId])).rows;
    expect(def).toEqual([{ label: 'Home' }]);
  });

  it('is validated strictly and never half-saved', async () => {
    const n0 = (await h.db.query('SELECT count(*)::int n FROM addresses WHERE user_id=$1', [u.userId])).rows[0].n;
    const bad = await u.mcp.call('create_cart', { store_id: 'demo-m3', deliver_to: { ...recipient, district: 'Hollywood' }, items: [{ item_id: 'm3-orchid', quantity: 1 }] });
    expect(bad.error.code).toBe('VALIDATION_FAILED');
    expect(bad.error.details.field).toBe('deliver_to.district');
    expect(bad.error.details.allowed).toContain('Watthana');
    const phone = await u.mcp.call('create_cart', { store_id: 'demo-m3', deliver_to: { ...recipient, name: 'Other', phone: '12' }, items: [{ item_id: 'm3-orchid', quantity: 1 }] });
    expect(phone.isError).toBe(true);
    const noNumber = await u.mcp.call('create_cart', { store_id: 'demo-m3', deliver_to: { ...recipient, name: 'Other', address_line: 'Soi Ari somewhere' }, items: [{ item_id: 'm3-orchid', quantity: 1 }] });
    expect(noNumber.error.details.field).toBe('deliver_to.address_line');
    const itemBad = await u.mcp.call('create_cart', { store_id: 'demo-m3', deliver_to: { ...recipient, name: 'Other' }, items: [{ item_id: 'm3-roses', quantity: 1 }] });
    expect(itemBad.error.code).toBe('MODIFIERS_INVALID');
    const both = await u.mcp.call('create_cart', { store_id: 'demo-m3', deliver_to: recipient, address_id: '00000000-0000-4000-8000-000000000000', items: [{ item_id: 'm3-orchid', quantity: 1 }] });
    expect(both.error.code).toBe('VALIDATION_FAILED');
    const ride = await u.mcp.call('create_cart', { service: 'ride', pickup: 'Home', dropoff: 'Asok', deliver_to: recipient, items: [{ item_id: 'justgrab', quantity: 1 }] });
    expect(ride.error.code).toBe('VALIDATION_FAILED');
    expect((await h.db.query('SELECT count(*)::int n FROM addresses WHERE user_id=$1', [u.userId])).rows[0].n).toBe(n0);
  });
});
