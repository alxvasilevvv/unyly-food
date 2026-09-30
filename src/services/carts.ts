import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { sha256, stableJson } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import { money } from '../domain/money.js';
import { validateModifiers } from '../providers/demo/provider.js';
import type { CartLine, Mode, SelectedModifier } from '../providers/types.js';
import { callProvider, newLineId, requireCapability } from './common.js';
import { AddressRow, getAddress, getDefaultAddress, getUser, maskedAddress, toDeliveryAddress } from './users.js';

export const MAX_LINES = 30;
export const MAX_QTY = 20;

export interface CartRow {
  id: string;
  user_id: string;
  mode: Mode;
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
  | { op: 'set_address'; address_id: string };

/** Load a cart the actor owns. Other users' carts are indistinguishable from missing ones. */
export async function loadCart(q: Queryable, userId: string, cartId: string, lock = false): Promise<CartState> {
  const r = await q.query<CartRow>(`SELECT * FROM carts WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [cartId, userId]);
  const cart = r.rows[0];
  if (!cart) throw new DomainError('NOT_FOUND', 'Cart not found');
  const v = await q.query('SELECT items, address_id FROM cart_versions WHERE cart_id = $1 AND version = $2', [cartId, cart.version]);
  return { ...cart, items: v.rows[0].items, address_id: v.rows[0].address_id };
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

export async function createCart(
  ctx: Ctx,
  actor: Actor,
  args: { restaurant_id?: string; restaurant_name?: string; items: NewItem[]; address_id?: string },
): Promise<CartState> {
  const user = await getUser(ctx.db, actor.userId);
  requireCapability(ctx, user.mode, 'cart');
  if (args.items.length > MAX_LINES) throw new DomainError('VALIDATION_FAILED', `At most ${MAX_LINES} lines`);
  args.items.forEach((i) => checkQty(i.quantity));
  const address = args.address_id ? await getAddress(ctx.db, actor.userId, args.address_id) : await getDefaultAddress(ctx.db, actor.userId);
  let restaurantName: string;
  let restaurantId: string | null = null;
  if (user.mode === 'handoff') {
    restaurantName = (args.restaurant_name ?? '').trim().slice(0, 120);
    if (!restaurantName) throw new DomainError('VALIDATION_FAILED', 'restaurant_name is required in Handoff mode');
  } else {
    if (!args.restaurant_id) throw new DomainError('VALIDATION_FAILED', 'restaurant_id is required');
    const menu = await callProvider(() => ctx.provider(user.mode).getMenu(args.restaurant_id!, address ? toDeliveryAddress(address) : null));
    restaurantId = menu.restaurant.id;
    restaurantName = menu.restaurant.name;
  }
  const lines = await resolveLines(ctx, user.mode, restaurantId, args.items, address);
  return ctx.db.tx(async (q) => {
    const c = await q.query<CartRow>(
      'INSERT INTO carts (user_id, mode, restaurant_id, restaurant_name) VALUES ($1,$2,$3,$4) RETURNING *',
      [actor.userId, user.mode, restaurantId, restaurantName],
    );
    await q.query('INSERT INTO cart_versions (cart_id, version, items, address_id) VALUES ($1, 1, $2, $3)', [c.rows[0].id, JSON.stringify(lines), address?.id ?? null]);
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'cart.created', mode: user.mode, entity: 'cart', entityId: c.rows[0].id });
    return { ...c.rows[0], items: lines, address_id: address?.id ?? null };
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
      }
    }
    if (items.length > MAX_LINES) throw new DomainError('VALIDATION_FAILED', `At most ${MAX_LINES} lines`);
    const version = cart.version + 1;
    await q.query('INSERT INTO cart_versions (cart_id, version, items, address_id) VALUES ($1,$2,$3,$4)', [cartId, version, JSON.stringify(items), addressId]);
    await q.query('UPDATE carts SET version = $2, updated_at = now() WHERE id = $1', [cartId, version]);
    await invalidateCheckouts(q, cartId, 'CART_CHANGED');
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'cart.updated', mode: cart.mode, entity: 'cart', entityId: cartId, details: { version, ops: ops.map((o) => o.op) } });
    return { ...cart, version, items, address_id: addressId };
  });
}

export async function describeCart(ctx: Ctx, userId: string, cart: CartState) {
  const addr = cart.address_id ? await getAddress(ctx.db, userId, cart.address_id).catch(() => null) : null;
  return {
    cart_id: cart.id,
    version: cart.version,
    mode: cart.mode,
    status: cart.status,
    restaurant: { restaurant_id: cart.restaurant_id, name: cart.restaurant_name },
    items: cart.items.map((l) => ({ line_id: l.line_id, item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers, note: l.note })),
    delivery_address: maskedAddress(addr),
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
  if (!cart.address_id) {
    throw new DomainError('ADDRESS_REQUIRED', 'A delivery address is required', undefined, `Add an address at ${ctx.cfg.webOrigin}/app/addresses, then call update_cart with set_address or quote again.`);
  }
  const addr = await getAddress(ctx.db, actor.userId, cart.address_id).catch(() => {
    throw new DomainError('ADDRESS_REQUIRED', 'The cart address was deleted; choose another address');
  });
  const da = toDeliveryAddress(addr);
  const fetchedAt = ctx.clock.now();
  const pq = await callProvider(() => ctx.provider(cart.mode).quote({ restaurant_id: cart.restaurant_id!, lines: cart.items, address: da }));
  const expires = new Date(fetchedAt.getTime() + pq.valid_for_seconds * 1000);
  const hash = sha256(stableJson({ cart: cart.id, v: cart.version, addr: da.fingerprint, lines: pq.lines, total: pq.total_minor, cur: pq.currency }));
  const row = await ctx.db.tx(async (q) => {
    const cur = await q.query('SELECT version FROM carts WHERE id = $1 FOR SHARE', [cart.id]);
    if (cur.rows[0].version !== cart.version) throw new DomainError('CART_VERSION_CONFLICT', 'Cart changed while quoting; quote again', { current_version: cur.rows[0].version });
    const r = await q.query<QuoteRow>(
      `INSERT INTO quotes (user_id, cart_id, cart_version, mode, currency, lines, subtotal_minor, delivery_fee_minor, service_fee_minor, small_order_fee_minor,
        discount_minor, total_minor, eta_min_minutes, eta_max_minutes, issues, checkout_allowed, price_source, address_fingerprint, quote_hash, fetched_at, expires_at, payment_method_label, cancellation_terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
      [actor.userId, cart.id, cart.version, cart.mode, pq.currency, JSON.stringify(pq.lines), pq.subtotal_minor, pq.delivery_fee_minor, pq.service_fee_minor,
        pq.small_order_fee_minor, pq.discount_minor, pq.total_minor, pq.eta_min_minutes, pq.eta_max_minutes, JSON.stringify(pq.issues), pq.issues.length === 0,
        pq.price_source, da.fingerprint, hash, fetchedAt, expires, pq.payment_method_label, pq.cancellation_terms],
    );
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'quote.created', mode: cart.mode, entity: 'quote', entityId: r.rows[0].id, details: { total: pq.total_minor } });
    return r.rows[0];
  });
  return { quote: row, cart, address: addr };
}

export function describeQuote(qr: QuoteRow, locale: 'ru' | 'en' | 'th' = 'en') {
  const m = (n: number) => money(n, qr.currency, locale);
  return {
    quote_id: qr.id,
    cart_id: qr.cart_id,
    cart_version: qr.cart_version,
    mode: qr.mode,
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
