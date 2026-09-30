import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobsOnce } from '../src/jobs/worker.js';
import { resolvePlace } from '../src/providers/demo/places.js';
import { confirmOnWeb, demoUser, Harness, mcpClient, oauthToken, startHarness, webLogin } from './helpers.js';

let h: Harness;
let u: Awaited<ReturnType<typeof demoUser>>;
beforeAll(async () => {
  h = await startHarness();
  u = await demoUser(h, 'multi@example.com');
});
afterAll(async () => {
  await u.mcp.close();
  await h.close();
});

describe('Place resolver (demo map, three languages)', () => {
  it('resolves landmarks in English, Russian (with case endings) and Thai', () => {
    const en = resolvePlace('Siam Paragon');
    const ru = resolvePlace('от Сиама');
    const th = resolvePlace('สนามบินสุวรรณภูมิ');
    expect(en.ok && en.place.name).toBe('Siam Paragon');
    expect(ru.ok && ru.place.name).toBe('Siam Paragon');
    expect(th.ok && th.place.is_airport).toBe(true);
    const icon = resolvePlace('ICONSIAM');
    expect(icon.ok && icon.place.name).toBe('ICONSIAM'); // longer alias wins over "siam"
  });
  it('asks which airport when the user just says "airport"', () => {
    const r = resolvePlace('to the airport');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PLACE_AMBIGUOUS');
      expect(r.suggestions).toHaveLength(2);
    }
  });
  it('uses saved address labels and district centres, and refuses unknown places', () => {
    const home = resolvePlace('Home', [{ label: 'Home', district: 'Watthana', city: 'Bangkok' }]);
    expect(home.ok && home.place.kind).toBe('saved_address');
    const d = resolvePlace('Sathorn');
    expect(d.ok && d.place.kind).toBe('district');
    const x = resolvePlace('Eiffel Tower');
    expect(x.ok).toBe(false);
  });
});

describe('Mart: groceries, flowers, pharmacy, cakes', () => {
  it('search_stores finds a pharmacy with a household-remedies notice', async () => {
    const r = await u.mcp.call('search_stores', { service: 'mart', query: 'paracetamol' });
    expect(r.ok).toBe(true);
    expect(r.result.stores).toHaveLength(1);
    const st = r.result.stores[0];
    expect(st.store.category).toBe('pharmacy');
    expect(st.store.notice).toMatch(/Household remedies/);
    expect(st.store.notice).toMatch(/Prescription medicines are not sold/);
    expect(st.matching_items[0]).toMatchObject({ item_id: 'm4-paracetamol', max_quantity: 2 });
  });

  it('per-order limits on medicines are enforced', async () => {
    const r = await u.mcp.call('create_cart', { store_id: 'demo-m4', items: [{ item_id: 'm4-paracetamol', quantity: 3 }] });
    expect(r.error.code).toBe('QUANTITY_LIMIT');
  });

  it('flowers need the required wrapping choice and carry the card message as a note', async () => {
    const bad = await u.mcp.call('create_cart', { store_id: 'demo-m3', items: [{ item_id: 'm3-roses', quantity: 1 }] });
    expect(bad.error.code).toBe('MODIFIERS_INVALID');
    const ok = await u.mcp.call('create_cart', {
      store_id: 'demo-m3', items: [{ item_id: 'm3-roses', quantity: 1, modifiers: [{ group_id: 'wrap', option_ids: ['box'] }], note: 'Happy anniversary!' }],
    });
    expect(ok.ok).toBe(true);
    expect(ok.result.service).toBe('mart');
    const q = await u.mcp.call('quote_cart', { cart_id: ok.result.cart_id });
    expect(q.result.breakdown.items_subtotal.amount_minor).toBe(89000 + 15000);
    expect(q.result.checkout_allowed).toBe(true);
  });

  it('ride and parcel are not store searches', async () => {
    const r = await u.mcp.call('search_stores', { service: 'ride' as any });
    expect(r.isError).toBe(true);
  });
});

describe('Ride: estimate → book → confirm on web → track', () => {
  it('estimate_trip returns fare options, cheapest fitting first, with airport pickup fee', async () => {
    const r = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Suvarnabhumi airport', dropoff: 'Asok', passengers: 5 });
    expect(r.ok).toBe(true);
    expect(r.result.trip.pickup.name).toMatch(/Suvarnabhumi/);
    expect(r.result.trip.distance_km_estimate).toBeGreaterThan(20);
    const [first] = r.result.options;
    expect(first.fits).toBe(true);
    expect(first.seats).toBeGreaterThanOrEqual(5);
    expect(r.result.options.find((o: any) => o.item_id === 'grabbike').fits).toBe(false);
  });

  it('full ride flow, trip bound to the confirmation, ride status labels', async () => {
    const cart = await u.mcp.call('create_cart', { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', items: [{ item_id: 'justgrab', quantity: 1 }] });
    expect(cart.ok).toBe(true);
    expect(cart.result.trip.dropoff.name).toBe('ICONSIAM');
    expect(cart.result.delivery_address).toBeUndefined();
    const q = await u.mcp.call('quote_cart', { cart_id: cart.result.cart_id });
    expect(q.ok).toBe(true);
    expect(q.result.lines).toHaveLength(1);
    expect(q.result.breakdown.delivery_fee.amount_minor).toBe(0);
    const co = await u.mcp.call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: q.result.quote_id });
    expect(co.ok).toBe(true);

    // Changing the trip after preparing invalidates the pending confirmation.
    const moved = await u.mcp.call('update_cart', { cart_id: cart.result.cart_id, expected_version: 1, operations: [{ op: 'set_trip', dropoff: 'Chatuchak' }] });
    expect(moved.ok).toBe(true);
    expect(moved.result.trip.dropoff.name).toMatch(/Chatuchak/);
    const stale = await u.mcp.call('get_checkout_status', { checkout_id: co.result.checkout_id });
    expect(stale.result.status).toBe('invalidated');

    const q2 = await u.mcp.call('quote_cart', { cart_id: cart.result.cart_id });
    const co2 = await u.mcp.call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: q2.result.quote_id });
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${co2.result.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).toContain('Chatuchak');
    expect((await confirmOnWeb(h, u, co2.result.checkout_id)).statusCode).toBe(302);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: co2.result.checkout_id });
    const os = await u.mcp.call('get_order_status', { order_id: st.result.order_id });
    expect(os.result).toMatchObject({ service: 'ride', status_label: 'Driver assigned' });
    expect(os.result.trip).toMatch(/Siam Paragon → Chatuchak/);
    h.clock.advance(2 * 60_000);
    await runJobsOnce(h.ctx);
    expect((await u.mcp.call('get_order_status', { order_id: st.result.order_id })).result.status_label).toBe('Driver arriving');
    const cancel = await u.mcp.call('prepare_cancellation', { order_id: st.result.order_id });
    expect(cancel.result.fee.amount_minor).toBe(3000);
  });

  it('a trip cart holds exactly one vehicle', async () => {
    const r = await u.mcp.call('create_cart', { service: 'ride', pickup: 'Asok', dropoff: 'Khao San', items: [{ item_id: 'justgrab', quantity: 2 }] });
    expect(r.error.code).toBe('QUANTITY_LIMIT');
  });

  it('unknown or ambiguous places come back with suggestions', async () => {
    const r = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Asok', dropoff: 'airport' });
    expect(r.error.code).toBe('PLACE_AMBIGUOUS');
    expect(r.error.details.suggestions).toEqual(expect.arrayContaining(['Don Mueang Airport (DMK)']));
  });
});

describe('Express parcel', () => {
  it('needs a weight and respects vehicle limits', async () => {
    const noWeight = await u.mcp.call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'ICONSIAM', items: [{ item_id: 'express_bike', quantity: 1 }] });
    expect(noWeight.error.code).toBe('VALIDATION_FAILED');
    const heavy = await u.mcp.call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'ICONSIAM', parcel_weight_kg: 35, items: [{ item_id: 'express_bike', quantity: 1 }] });
    expect(heavy.ok).toBe(true);
    expect(heavy.result.trip.pickup.resolved_as).toBe('saved_address');
    const q = await u.mcp.call('quote_cart', { cart_id: heavy.result.cart_id });
    expect(q.result.checkout_allowed).toBe(false);
    expect(q.result.issues[0].code).toBe('WEIGHT_LIMIT');
    const est = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Home', dropoff: 'ICONSIAM', parcel_weight_kg: 35 });
    expect(est.result.options[0].item_id).toBe('express_car');
  });
});

describe('Handoff across services and markets', () => {
  it('ride handoff: pickup and drop-off checklist with the Grab transport page, no order', async () => {
    const s = await webLogin(h, 'handoff-ride@example.com');
    await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'handoff' } });
    const m = await mcpClient(h, (await oauthToken(h, s)).access_token);
    const cart = await m.call('create_cart', { service: 'ride', pickup: 'My condo on Sukhumvit 24', dropoff: 'Don Mueang airport' });
    expect(cart.ok).toBe(true);
    const ho = await m.call('create_handoff', { cart_id: cart.result.cart_id });
    expect(ho.result).toMatchObject({ service: 'ride', open_url: 'https://www.grab.com/th/en/transport/', link_verified: true, order_created: false });
    expect(ho.result.trip.pickup.name).toBe('My condo on Sukhumvit 24');
    await m.close();
  });

  it('every Grab market is selectable; unverified links are labelled as such', async () => {
    const s = await webLogin(h, 'sg@example.com');
    const r = await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'SG', mode: 'handoff' } });
    expect(r.statusCode).toBe(302);
    const m = await mcpClient(h, (await oauthToken(h, s)).access_token);
    const caps = await m.call('get_capabilities');
    expect(caps.result.region).toBe('SG');
    expect(caps.result.markets.map((x: any) => x.region)).toEqual(['TH', 'SG', 'MY', 'ID', 'VN', 'PH', 'KH', 'MM']);
    expect(caps.result.services.map((x: any) => x.service)).toEqual(['food', 'mart', 'ride', 'express']);
    const cart = await m.call('create_cart', { service: 'mart', store_name: 'Any supermarket', items: [{ name: 'Milk', quantity: 1 }] });
    const ho = await m.call('create_handoff', { cart_id: cart.result.cart_id });
    expect(ho.result).toMatchObject({ open_url: 'https://www.grab.com/sg/', link_verified: false });
    await m.close();
  });
});

describe('Review regressions', () => {
  it('per-order limits count the same item across several lines', async () => {
    const r = await u.mcp.call('create_cart', { store_id: 'demo-m4', items: [1, 2, 3].map(() => ({ item_id: 'm4-paracetamol', quantity: 2 })) });
    expect(r.error.code).toBe('QUANTITY_LIMIT');
    const c = await u.mcp.call('create_cart', { store_id: 'demo-m4', items: [{ item_id: 'm4-paracetamol', quantity: 2 }] });
    const up = await u.mcp.call('update_cart', { cart_id: c.result.cart_id, expected_version: 1, operations: [{ op: 'add_item', item: { item_id: 'm4-paracetamol', quantity: 1 } }] });
    const q = await u.mcp.call('quote_cart', { cart_id: up.result.cart_id });
    expect(q.result.checkout_allowed).toBe(false);
    expect(q.result.issues[0].code).toBe('QUANTITY_LIMIT');
  });

  it('editing a saved address used by a trip invalidates the pending confirmation', async () => {
    const cart = await u.mcp.call('create_cart', { service: 'ride', pickup: 'Home', dropoff: 'Asok', items: [{ item_id: 'justgrab', quantity: 1 }] });
    const q = await u.mcp.call('quote_cart', { cart_id: cart.result.cart_id });
    const co = await u.mcp.call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: q.result.quote_id });
    expect(co.ok).toBe(true);
    await h.db.query(`UPDATE addresses SET district = 'Sathon' WHERE user_id = $1 AND label = 'Home'`, [u.userId]);
    const post = await confirmOnWeb(h, u, co.result.checkout_id);
    expect(post.statusCode).toBe(409);
    expect((await u.mcp.call('get_checkout_status', { checkout_id: co.result.checkout_id })).result.status).toBe('invalidated');
  });
});
