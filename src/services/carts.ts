import type { Locale } from '../domain/locales.js';
import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { sha256, stableJson } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import { money } from '../domain/money.js';
import { validateModifiers } from '../providers/demo/provider.js';
import { isTripService, Service, SERVICE_LABEL } from '../domain/regions.js';
import { buildTrip } from '../providers/demo/places.js';
import type { CartLine, Mode, Place, SelectedModifier, Trip } from '../providers/types.js';
import { callProvider, newLineId, requireCapability } from './common.js';
import { AddressRow, addressFingerprint, getAddress, getDefaultAddress, getUser, listAddresses, maskedAddress, toDeliveryAddress } from './users.js';

export const MAX_LINES = 30;
export const MAX_QTY = 20;

export interface CartRow {
  id: string;
  user_id: string;
  mode: Mode;
  service: Service;
  restaurant_id: string | null;
  restaurant_name: string;
  version: number;
  status: 'open' | 'ordered' | 'abandoned';
  source_order_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface CartState extends CartRow {
  items: CartLine[];
  address_id: string | null;
  trip: Trip | null;
}

export interface TripInput {
  pickup?: string;
  dropoff?: string;
  parcel_weight_kg?: number;
  parcel_description?: string;
}

export interface NewItem {
  item_id?: string;
  name?: string;
  quantity: number;
  modifiers?: SelectedModifier[];
  note?: string;
}

export type CartOp =
  | { op: 'add_item'; item: NewItem }
  | { op: 'set_quantity'; line_id: string; quantity: number }
  | { op: 'remove_item'; line_id: string }
  | { op: 'set_address'; address_id: string }
  | ({ op: 'set_trip' } & TripInput);

/** Load a cart the actor owns. Other users' carts are indistinguishable from missing ones. */
export async function loadCart(q: Queryable, userId: string, cartId: string, lock = false): Promise<CartState> {
  const r = await q.query<CartRow>(`SELECT * FROM carts WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [cartId, userId]);
  const cart = r.rows[0];
  if (!cart) throw new DomainError('NOT_FOUND', 'Cart not found');
  const v = await q.query('SELECT items, address_id, trip FROM cart_versions WHERE cart_id = $1 AND version = $2', [cartId, cart.version]);
  return { ...cart, items: v.rows[0].items, address_id: v.rows[0].address_id, trip: v.rows[0].trip ?? null };
}

/** What the human approves as "where": the delivery address, or the trip for ride/express. */
export async function locationFingerprint(q: Queryable, userId: string, cart: Pick<CartState, 'service' | 'address_id' | 'trip'>): Promise<string | null> {
  if (isTripService(cart.service)) {
    if (!cart.trip) return null;
    // A trip from/to a saved address is also bound to that address's current content.
    const parts = [cart.trip.fingerprint];
    for (const p of [cart.trip.pickup, cart.trip.dropoff]) {
      if (!p.address_id) continue;
      const a = await getAddress(q, userId, p.address_id).catch(() => null);
      if (!a) return null;
      parts.push(addressFingerprint(a));
    }
    return parts.length === 1 ? parts[0] : sha256(parts.join('|'));
  }
  if (!cart.address_id) return null;
  const addr = await getAddress(q, userId, cart.address_id).catch(() => null);
  return addr ? addressFingerprint(addr) : null;
}

export function tripLabel(t: Trip | null): string | null {
  if (!t) return null;
  return `${t.pickup.name} → ${t.dropoff.name}`;
}

export function describeTrip(t: Trip | null) {
  if (!t) return null;
  const place = (p: Place) => ({ name: p.name, area: p.area ?? null, resolved_as: p.kind });
  return {
    pickup: place(t.pickup),
    dropoff: place(t.dropoff),
    distance_km_estimate: t.distance_km ?? null,
    drive_minutes_estimate: t.duration_min ?? null,
    parcel: t.parcel ?? null,
  };
}

async function resolveOne(ctx: Ctx, mode: Mode, userId: string, text: string | undefined, field: 'pickup' | 'dropoff'): Promise<Place> {
  const raw = (text ?? '').trim().slice(0, 160);
  if (!raw) throw new DomainError('TRIP_REQUIRED', `${field} is required for this service`, { field });
  const provider = ctx.provider(mode);
  if (!provider.resolvePlace) return { name: raw, kind: 'user_text' };
  const saved = (await listAddresses(ctx.db, userId)).map((a) => ({ id: a.id, label: a.label, district: a.district, city: a.city }));
  const r = provider.resolvePlace(raw, saved);
  if (!r.ok) throw new DomainError(r.code, `${field}: ${r.message}`, { field, suggestions: r.suggestions });
  return r.place;
}

export async function resolveTrip(ctx: Ctx, mode: Mode, userId: string, service: Service, input: TripInput, prev?: Trip | null): Promise<Trip> {
  const pickup = input.pickup !== undefined || !prev ? await resolveOne(ctx, mode, userId, input.pickup, 'pickup') : prev.pickup;
  const dropoff = input.dropoff !== undefined || !prev ? await resolveOne(ctx, mode, userId, input.dropoff, 'dropoff') : prev.dropoff;
  let parcel = prev?.parcel;
  if (service === 'express') {
    const w = input.parcel_weight_kg ?? prev?.parcel?.weight_kg;
    if (w === undefined || !(w > 0) || w > 1000) throw new DomainError('VALIDATION_FAILED', 'parcel_weight_kg (0-1000) is required for a parcel', { field: 'parcel_weight_kg' });
    parcel = { weight_kg: Math.round(w * 10) / 10, description: (input.parcel_description ?? prev?.parcel?.description)?.trim().slice(0, 120) || undefined };
  }
  if (pickup.name.toLowerCase() === dropoff.name.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 'Pickup and drop-off are the same place', { field: 'dropoff' });
  return buildTrip(pickup, dropoff, parcel);
}

async function resolveLines(ctx: Ctx, mode: Mode, restaurantId: string | null, items: NewItem[], address: AddressRow | null): Promise<CartLine[]> {
  if (mode === 'handoff') {
    return items.map((i) => {
      const name = (i.name ?? '').trim();
      if (!name) throw new DomainError('VALIDATION_FAILED', 'In Handoff mode each item needs a name');
      return { line_id: newLineId(), name: name.slice(0, 120), quantity: i.quantity, modifiers: [], note: i.note?.slice(0, 200) };
    });
  }
  const menu = await callProvider(() => ctx.provider(mode).getMenu(restaurantId!, address ? toDeliveryAddress(address) : null));
  return items.map((i) => {
    if (!i.item_id) throw new DomainError('VALIDATION_FAILED', 'item_id is required');
    const it = menu.items.find((m) => m.id === i.item_id);
    if (!it) throw new DomainError('ITEM_NOT_FOUND', `Item ${i.item_id} not found in this restaurant`);
    if (!it.available) throw new DomainError('OUT_OF_STOCK', `${it.name} is out of stock`, { item_id: it.id });
    if (it.max_quantity && i.quantity > it.max_quantity) {
      throw new DomainError('QUANTITY_LIMIT', `At most ${it.max_quantity} of ${it.name} per order`, { item_id: it.id, max_quantity: it.max_quantity });
    }
    const mods = i.modifiers ?? [];
    const problem = validateModifiers(it, mods);
    if (problem) {
      throw new DomainError('MODIFIERS_INVALID', problem, {
        item_id: it.id,
        required_groups: it.modifier_groups.filter((g) => g.min_select > 0).map((g) => ({ group_id: g.id, name: g.name, options: g.options.map((o) => o.id) })),
      });
    }
    for (const sel of mods) {
      const g = it.modifier_groups.find((x) => x.id === sel.group_id)!;
      for (const o of sel.option_ids) {
        if (!g.options.find((x) => x.id === o)!.available) throw new DomainError('OUT_OF_STOCK', `Option ${o} is unavailable`);
      }
    }
    return { line_id: newLineId(), item_id: it.id, name: it.name, quantity: i.quantity, modifiers: mods, note: i.note?.slice(0, 200) };
  });
}

function checkQty(q: number) {
  if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) throw new DomainError('VALIDATION_FAILED', `quantity must be 1..${MAX_QTY}`);
}

async function invalidateCheckouts(q: Queryable, cartId: string, reason: string) {
  await q.query(`UPDATE checkouts SET status = 'invalidated', invalid_reason = $2 WHERE cart_id = $1 AND status IN ('awaiting_user','approved')`, [cartId, reason]);
}

/** Trip carts hold exactly one vehicle line with quantity 1. */
function checkTripLines(lines: CartLine[]) {
  if (lines.length > 1 || lines.some((l) => l.quantity !== 1)) {
    throw new DomainError('VALIDATION_FAILED', 'A ride or parcel needs exactly one vehicle type with quantity 1');
  }
}

export interface CreateCartArgs extends TripInput {
  service?: Service;
  restaurant_id?: string;
  restaurant_name?: string;
  items: NewItem[];
  address_id?: string;
  /** Reorder: reuse the exact trip of the earlier order instead of re-resolving names. */
  reuse_trip?: Trip | null;
}

export async function createCart(ctx: Ctx, actor: Actor, args: CreateCartArgs): Promise<CartState> {
  const user = await getUser(ctx.db, actor.userId);
  requireCapability(ctx, user.mode, 'cart');
  if (args.items.length > MAX_LINES) throw new DomainError('VALIDATION_FAILED', `At most ${MAX_LINES} lines`);
  args.items.forEach((i) => checkQty(i.quantity));
  const provider = ctx.provider(user.mode);
  let service: Service = args.service ?? 'food';
  let restaurantName: string;
  let restaurantId: string | null = null;
  let address: AddressRow | null = null;
  let items = args.items;
  if (user.mode === 'handoff') {
    restaurantName = (args.restaurant_name ?? '').trim().slice(0, 120) || (isTripService(service) ? SERVICE_LABEL[service] : '');
    if (!restaurantName) throw new DomainError('VALIDATION_FAILED', 'store_name is required in Handoff mode');
    if (isTripService(service) && !items.length) items = [{ name: service === 'ride' ? 'Vehicle type: choose in Grab' : 'Vehicle size: choose in Grab', quantity: 1 }];
  } else {
    let storeId = args.restaurant_id;
    if (!storeId && isTripService(service)) {
      storeId = (await callProvider(() => provider.searchRestaurants({ address: null, service })))[0]?.id;
      if (!storeId) throw new DomainError('CAPABILITY_UNAVAILABLE', `${service} is not available in this area`);
    }
    if (!storeId) throw new DomainError('VALIDATION_FAILED', 'store_id is required (from search_stores)');
    if (!isTripService(service) || args.restaurant_id) {
      address = args.address_id ? await getAddress(ctx.db, actor.userId, args.address_id) : await getDefaultAddress(ctx.db, actor.userId);
    }
    const menu = await callProvider(() => provider.getMenu(storeId!, address ? toDeliveryAddress(address) : null));
    restaurantId = menu.restaurant.id;
    restaurantName = menu.restaurant.name;
    service = menu.restaurant.service;
    if (isTripService(service)) address = null;
  }
  const trip = isTripService(service) ? args.reuse_trip ?? (await resolveTrip(ctx, user.mode, actor.userId, service, args)) : null;
  const lines = await resolveLines(ctx, user.mode, restaurantId, items, address);
  const perItem = new Map<string, number>();
  for (const l of lines) if (l.item_id) perItem.set(l.item_id, (perItem.get(l.item_id) ?? 0) + l.quantity);
  if (restaurantId && [...perItem.values()].some((n) => n > 1)) {
    const menu = await callProvider(() => ctx.provider(user.mode).getMenu(restaurantId!, address ? toDeliveryAddress(address) : null));
    for (const [id, n] of perItem) {
      const it = menu.items.find((m) => m.id === id);
      if (it?.max_quantity && n > it.max_quantity) throw new DomainError('QUANTITY_LIMIT', `At most ${it.max_quantity} of ${it.name} per order`, { item_id: id, max_quantity: it.max_quantity });
    }
  }
  if (trip) checkTripLines(lines);
  return ctx.db.tx(async (q) => {
    const c = await q.query<CartRow>(
      'INSERT INTO carts (user_id, mode, service, restaurant_id, restaurant_name) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [actor.userId, user.mode, service, restaurantId, restaurantName],
    );
    await q.query('INSERT INTO cart_versions (cart_id, version, items, address_id, trip) VALUES ($1, 1, $2, $3, $4)', [
      c.rows[0].id, JSON.stringify(lines), address?.id ?? null, trip ? JSON.stringify(trip) : null,
    ]);
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'cart.created', mode: user.mode, entity: 'cart', entityId: c.rows[0].id, details: { service } });
    return { ...c.rows[0], items: lines, address_id: address?.id ?? null, trip };
  });
}

export async function updateCart(ctx: Ctx, actor: Actor, cartId: string, expectedVersion: number, ops: CartOp[]): Promise<CartState> {
  if (!ops.length) throw new DomainError('VALIDATION_FAILED', 'No operations');
  // Resolve new items against the menu before taking the lock (network call outside the transaction).
  const pre = await loadCart(ctx.db, actor.userId, cartId);
  const adds = ops.filter((o): o is Extract<CartOp, { op: 'add_item' }> => o.op === 'add_item');
  adds.forEach((a) => checkQty(a.item.quantity));
  let preAddress: AddressRow | null = pre.address_id ? await getAddress(ctx.db, actor.userId, pre.address_id).catch(() => null) : null;
  const resolved = adds.length ? await resolveLines(ctx, pre.mode, pre.restaurant_id, adds.map((a) => a.item), preAddress) : [];
  const tripOps = ops.filter((o): o is Extract<CartOp, { op: 'set_trip' }> => o.op === 'set_trip');
  if (tripOps.length && !isTripService(pre.service)) throw new DomainError('VALIDATION_FAILED', 'set_trip is only for ride and parcel carts');
  if (isTripService(pre.service) && ops.some((o) => o.op === 'set_address')) throw new DomainError('VALIDATION_FAILED', 'Use set_trip for ride and parcel carts');
  let newTrip = pre.trip;
  for (const t of tripOps) newTrip = await resolveTrip(ctx, pre.mode, actor.userId, pre.service, t, newTrip);

  return ctx.db.tx(async (q) => {
    const cart = await loadCart(q, actor.userId, cartId, true);
    if (cart.status !== 'open') throw new DomainError('CART_NOT_OPEN', `Cart is ${cart.status}; create a new cart`);
    if (cart.version !== expectedVersion) {
      throw new DomainError('CART_VERSION_CONFLICT', 'Cart changed since you last read it', { current_version: cart.version });
    }
    let items = [...cart.items];
    let addressId = cart.address_id;
    let addIdx = 0;
    for (const op of ops) {
      switch (op.op) {
        case 'add_item':
          items.push(resolved[addIdx++]);
          break;
        case 'set_quantity': {
          checkQty(op.quantity);
          const l = items.find((x) => x.line_id === op.line_id);
          if (!l) throw new DomainError('NOT_FOUND', `Line ${op.line_id} not found`);
          items = items.map((x) => (x.line_id === op.line_id ? { ...x, quantity: op.quantity } : x));
          break;
        }
        case 'remove_item':
          if (!items.find((x) => x.line_id === op.line_id)) throw new DomainError('NOT_FOUND', `Line ${op.line_id} not found`);
          items = items.filter((x) => x.line_id !== op.line_id);
          break;
        case 'set_address':
          await getAddress(q, actor.userId, op.address_id);
          addressId = op.address_id;
          break;
        case 'set_trip':
          break; // resolved before the lock
      }
    }
    if (items.length > MAX_LINES) throw new DomainError('VALIDATION_FAILED', `At most ${MAX_LINES} lines`);
    if (isTripService(cart.service)) checkTripLines(items);
    // The trip was resolved from the pre-lock snapshot; if another writer changed it, the version check above already failed.
    const trip = tripOps.length ? newTrip : cart.trip;
    const version = cart.version + 1;
    await q.query('INSERT INTO cart_versions (cart_id, version, items, address_id, trip) VALUES ($1,$2,$3,$4,$5)', [
      cartId, version, JSON.stringify(items), addressId, trip ? JSON.stringify(trip) : null,
    ]);
    await q.query('UPDATE carts SET version = $2, updated_at = now() WHERE id = $1', [cartId, version]);
    await invalidateCheckouts(q, cartId, 'CART_CHANGED');
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'cart.updated', mode: cart.mode, entity: 'cart', entityId: cartId, details: { version, ops: ops.map((o) => o.op) } });
    return { ...cart, version, items, address_id: addressId, trip };
  });
}

export async function describeCart(ctx: Ctx, userId: string, cart: CartState) {
  const addr = cart.address_id ? await getAddress(ctx.db, userId, cart.address_id).catch(() => null) : null;
  const trip = isTripService(cart.service);
  return {
    cart_id: cart.id,
    version: cart.version,
    mode: cart.mode,
    service: cart.service,
    status: cart.status,
    store: { store_id: cart.restaurant_id, name: cart.restaurant_name },
    items: cart.items.map((l) => ({ line_id: l.line_id, item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers, note: l.note })),
    delivery_address: trip ? undefined : maskedAddress(addr),
    trip: trip ? describeTrip(cart.trip) : undefined,
  };
}

// ---------------- Quotes ----------------
export interface QuoteRow {
  id: string;
  user_id: string;
  cart_id: string;
  cart_version: number;
  mode: Mode;
  currency: string;
  lines: any[];
  subtotal_minor: number;
  delivery_fee_minor: number;
  service_fee_minor: number;
  small_order_fee_minor: number;
  discount_minor: number;
  total_minor: number;
  eta_min_minutes: number;
  eta_max_minutes: number;
  issues: { code: string; message: string; line_id?: string }[];
  checkout_allowed: boolean;
  price_source: string;
  payment_method_label: string;
  cancellation_terms: string;
  address_fingerprint: string;
  quote_hash: string;
  fetched_at: string;
  expires_at: string;
}

export async function quoteCart(ctx: Ctx, actor: Actor, cartId: string) {
  const cart = await loadCart(ctx.db, actor.userId, cartId);
  requireCapability(ctx, cart.mode, 'quote');
  if (cart.status !== 'open') throw new DomainError('CART_NOT_OPEN', `Cart is ${cart.status}`);
  if (!cart.items.length) throw new DomainError('CART_EMPTY', 'Cart has no items');
  let addr: AddressRow | null = null;
  let fingerprint: string;
  if (isTripService(cart.service)) {
    if (!cart.trip) throw new DomainError('TRIP_REQUIRED', 'Pickup and drop-off are required; call update_cart with set_trip');
    const fp = await locationFingerprint(ctx.db, actor.userId, cart);
    if (!fp) throw new DomainError('ADDRESS_REQUIRED', 'A saved address used in this trip was deleted; call update_cart with set_trip');
    fingerprint = fp;
  } else {
    if (!cart.address_id) {
      throw new DomainError('ADDRESS_REQUIRED', 'A delivery address is required', undefined, `Add an address at ${ctx.cfg.webOrigin}/app/addresses, then call update_cart with set_address or quote again.`);
    }
    addr = await getAddress(ctx.db, actor.userId, cart.address_id).catch(() => {
      throw new DomainError('ADDRESS_REQUIRED', 'The cart address was deleted; choose another address');
    });
    fingerprint = addressFingerprint(addr);
  }
  const da = addr ? toDeliveryAddress(addr) : null;
  const fetchedAt = ctx.clock.now();
  const pq = await callProvider(() => ctx.provider(cart.mode).quote({ restaurant_id: cart.restaurant_id!, lines: cart.items, address: da, trip: cart.trip }));
  const expires = new Date(fetchedAt.getTime() + pq.valid_for_seconds * 1000);
  const hash = sha256(stableJson({ cart: cart.id, v: cart.version, addr: fingerprint, lines: pq.lines, total: pq.total_minor, cur: pq.currency }));
  const row = await ctx.db.tx(async (q) => {
    const cur = await q.query('SELECT version FROM carts WHERE id = $1 FOR SHARE', [cart.id]);
    if (cur.rows[0].version !== cart.version) throw new DomainError('CART_VERSION_CONFLICT', 'Cart changed while quoting; quote again', { current_version: cur.rows[0].version });
    const r = await q.query<QuoteRow>(
      `INSERT INTO quotes (user_id, cart_id, cart_version, mode, currency, lines, subtotal_minor, delivery_fee_minor, service_fee_minor, small_order_fee_minor,
        discount_minor, total_minor, eta_min_minutes, eta_max_minutes, issues, checkout_allowed, price_source, address_fingerprint, quote_hash, fetched_at, expires_at, payment_method_label, cancellation_terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
      [actor.userId, cart.id, cart.version, cart.mode, pq.currency, JSON.stringify(pq.lines), pq.subtotal_minor, pq.delivery_fee_minor, pq.service_fee_minor,
        pq.small_order_fee_minor, pq.discount_minor, pq.total_minor, pq.eta_min_minutes, pq.eta_max_minutes, JSON.stringify(pq.issues), pq.issues.length === 0,
        pq.price_source, fingerprint, hash, fetchedAt, expires, pq.payment_method_label, pq.cancellation_terms],
    );
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'quote.created', mode: cart.mode, entity: 'quote', entityId: r.rows[0].id, details: { total: pq.total_minor } });
    return r.rows[0];
  });
  return { quote: row, cart, address: addr };
}

export function describeQuote(qr: QuoteRow, locale: Locale = 'en', cart?: Pick<CartState, 'service' | 'trip'>) {
  const m = (n: number) => money(n, qr.currency, locale);
  return {
    quote_id: qr.id,
    cart_id: qr.cart_id,
    cart_version: qr.cart_version,
    mode: qr.mode,
    service: cart?.service,
    trip: cart && isTripService(cart.service) ? describeTrip(cart.trip) : undefined,
    lines: qr.lines.map((l: any) => ({ line_id: l.line_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers_desc, unit_price: m(l.unit_price_minor), line_total: m(l.line_total_minor), available: l.available })),
    breakdown: {
      items_subtotal: m(qr.subtotal_minor),
      delivery_fee: m(qr.delivery_fee_minor),
      service_fee: m(qr.service_fee_minor),
      small_order_fee: m(qr.small_order_fee_minor),
      discount: m(-qr.discount_minor),
      total: m(qr.total_minor),
    },
    eta_estimate_minutes: { min: qr.eta_min_minutes, max: qr.eta_max_minutes, note: 'Estimate, not a guarantee' },
    issues: qr.issues,
    checkout_allowed: qr.checkout_allowed,
    price_source: qr.price_source,
    fetched_at: new Date(qr.fetched_at).toISOString(),
    expires_at: new Date(qr.expires_at).toISOString(),
  };
}
