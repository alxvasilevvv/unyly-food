import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import { DomainError } from '../domain/errors.js';
import { isTripService, REGION_CODES, REGIONS, regionOf, Service, SERVICE_LABEL, SERVICES } from '../domain/regions.js';
import { MODES, Mode } from '../providers/types.js';
import { describeTrip, loadCart } from './carts.js';
import { requireCapability, submissionsEnabled } from './common.js';
import { getDefaultAddress, getUser, maskedAddress } from './users.js';

const HANDOFF_STEPS: Record<Service, string[]> = {
  food: [
    'Open the link (or the Grab app), choose GrabFood and search for the restaurant yourself.',
    'Add the items from the checklist. Prices, fees, availability and allergen information are shown only in Grab.',
  ],
  mart: [
    'Open the link (or the Grab app), choose GrabMart and search for the store yourself.',
    'Add the items from the checklist. Prices, stock and substitutions are shown only in Grab.',
  ],
  ride: [
    'Open the Grab app (or the link) and choose Transport.',
    'Enter the pickup and drop-off from the checklist, pick the vehicle type and check the fare Grab shows.',
  ],
  express: [
    'Open the Grab app (or the link) and choose Express.',
    'Enter the pickup, drop-off and parcel details from the checklist, pick the vehicle size and check the fee Grab shows.',
  ],
};

export async function createHandoff(ctx: Ctx, actor: Actor, cartId: string) {
  const cart = await loadCart(ctx.db, actor.userId, cartId);
  requireCapability(ctx, cart.mode, 'handoff');
  if (!cart.items.length) throw new DomainError('CART_EMPTY', 'Cart has no items');
  const user = await getUser(ctx.db, actor.userId);
  const link = ctx.provider(cart.mode).handoffUrl?.(user.region, cart.service);
  if (!link) throw new DomainError('CAPABILITY_UNAVAILABLE', `No Grab link for region ${user.region}`);
  const checklist = cart.items.map((l) => ({ name: l.name, quantity: l.quantity, note: l.note ?? null }));
  const trip = isTripService(cart.service) ? describeTrip(cart.trip) : null;
  const r = await ctx.db.tx(async (q) => {
    const h = await q.query(
      'INSERT INTO handoffs (user_id, cart_id, cart_version, url, checklist) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
      [actor.userId, cart.id, cart.version, link.url, JSON.stringify(trip ? { trip, items: checklist } : checklist)],
    );
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'handoff.created', mode: cart.mode, entity: 'handoff', entityId: h.rows[0].id, details: { service: cart.service } });
    return h.rows[0];
  });
  return {
    handoff_id: r.id,
    service: cart.service,
    open_url: link.url,
    link_verified: link.verified,
    link_source: link.source,
    store: isTripService(cart.service) ? undefined : cart.restaurant_name,
    trip: trip ?? undefined,
    checklist,
    instructions: [
      ...HANDOFF_STEPS[cart.service],
      'Review and pay inside Grab. Opening the link does NOT create an order, and Unyly cannot see whether you completed it.',
    ],
    order_created: false,
  };
}

export async function getCapabilities(ctx: Ctx, actor: Actor) {
  const user = await getUser(ctx.db, actor.userId);
  const addr = await getDefaultAddress(ctx.db, actor.userId);
  const modes: Record<string, unknown> = {};
  for (const m of MODES) {
    modes[m] = { capabilities: ctx.provider(m).capabilities(), submissions_enabled: await submissionsEnabled(ctx, ctx.db, m) };
  }
  const current = modes[user.mode] as any;
  const region = regionOf(user.region);
  const demoHere = user.mode === 'demo';
  return {
    region: region.code,
    region_name: region.name,
    region_note:
      'No live Grab access has been granted in any market. Demo data covers Bangkok only; Handoff links work in every Grab market ' +
      '(Thailand links checked page by page, others open the Grab country site).',
    current_mode: user.mode as Mode,
    mode_explanations: {
      demo: 'Synthetic stores, fares and orders in Bangkok. No real food, ride, delivery or payment.',
      handoff: 'Unyly prepares a checklist; you order or book and pay inside Grab yourself.',
      live: 'Real Grab orders placed by Unyly. Not available: requires a Grab partner agreement.',
    },
    services: SERVICES.map((s) => ({
      service: s,
      label: SERVICE_LABEL[s],
      how: isTripService(s)
        ? demoHere ? 'estimate_trip, then create_cart with pickup, dropoff and item_id of the vehicle' : 'create_cart with service, pickup and dropoff, then create_handoff'
        : demoHere ? 'search_stores, get_store, then create_cart with store_id and items' : 'create_cart with service, store_name and item names, then create_handoff',
      examples: SERVICE_EXAMPLES[s],
    })),
    markets: REGION_CODES.map((c) => ({ region: c, name: REGIONS[c].name, currency: REGIONS[c].currency, demo_catalog: REGIONS[c].demo_city, handoff_links_verified: REGIONS[c].links.food.verified })),
    current: current,
    delivery_address: maskedAddress(addr),
    unyly_scopes_granted: actor.scopes ?? null,
    settings_url: `${ctx.cfg.webOrigin}/app`,
  };
}

const SERVICE_EXAMPLES: Record<Service, string[]> = {
  food: ['dinner for two under 600 THB, no nuts', 'vegan lunch'],
  mart: ['groceries: rice, eggs, water', 'a bouquet of roses with a card', 'paracetamol and plasters from a pharmacy (household remedies only)', 'a birthday cake'],
  ride: ['taxi from Siam Paragon to Suvarnabhumi airport', 'bike to Asok'],
  express: ['send a 3 kg parcel from home to ICONSIAM'],
};
