import type { Db } from '../../db/db.js';
import { hmac, randomToken, safeEqual } from '../../domain/crypto.js';
import {
  CapabilityKey, Capability, CancelResult, CancellationTerms, CartLine, DeliveryAddress, FulfillmentStatus, LookupResult,
  MenuItem, Provider, ProviderEvent, ProviderOrderStatus, ProviderOutcomeUnknownError, ProviderQuote, ProviderUnavailableError,
  QuoteIssue, QuoteLine, Restaurant, Service, SubmitRequest, SubmitResult, Trip,
} from '../types.js';
import { isTripService, REGIONS } from '../../domain/regions.js';
import {
  DEMO_AIRPORT_PICKUP_FEE_MINOR, DEMO_CITY, DEMO_DISTRICTS, DEMO_QUOTE_TTL_SECONDS, DEMO_RESTAURANTS, DEMO_SERVICE_FEE_MINOR, DemoRestaurant, findRestaurant,
} from './catalog.js';
import { resolvePlace } from './places.js';

/** Fault injection for automated tests. Not reachable from any HTTP or MCP input. */
export interface DemoFaults {
  unavailable?: boolean;
  /** Accept (persist) the order, then behave as if the response was lost. */
  timeoutAfterAccept?: boolean;
  /** Lookup by idempotency key fails as well (provider unreachable during reconciliation). */
  lookupUnavailable?: boolean;
  /** Added to every item price, simulating a restaurant price change. */
  priceBumpMinor?: number;
  outOfStockItemIds?: string[];
  /** Simulate a process crash: the call never returns, before / after the provider stored the order. */
  hangBeforeAccept?: boolean;
  hangAfterAccept?: boolean;
}

/** Demo fulfilment timeline per service. For trips the last step follows the trip duration. */
function timeline(service: Service, tripMinutes = 20): { status: FulfillmentStatus; atMinute: number }[] {
  switch (service) {
    case 'ride':
      return [{ status: 'accepted', atMinute: 0 }, { status: 'preparing', atMinute: 1 }, { status: 'picked_up', atMinute: 6 }, { status: 'delivered', atMinute: 6 + tripMinutes }];
    case 'express':
      return [{ status: 'accepted', atMinute: 0 }, { status: 'preparing', atMinute: 2 }, { status: 'picked_up', atMinute: 10 }, { status: 'delivered', atMinute: 10 + tripMinutes }];
    case 'mart':
      return [{ status: 'accepted', atMinute: 0 }, { status: 'preparing', atMinute: 3 }, { status: 'picked_up', atMinute: 12 }, { status: 'delivered', atMinute: 25 }];
    default:
      return [{ status: 'accepted', atMinute: 0 }, { status: 'preparing', atMinute: 2 }, { status: 'picked_up', atMinute: 15 }, { status: 'delivered', atMinute: 30 }];
  }
}

/** Demo fare for one vehicle type on a trip, in minor units (rounded up to a whole baht). */
export function demoFare(it: MenuItem, trip: Trip): number | null {
  const v = it.vehicle;
  if (!v || trip.distance_km === undefined || trip.duration_min === undefined) return null;
  const raw = v.base_minor + v.per_km_minor * trip.distance_km + v.per_min_minor * trip.duration_min;
  return Math.ceil(raw / 100) * 100;
}
const SEQ: Record<string, number> = { accepted: 1, preparing: 2, picked_up: 3, delivered: 4 };

export const DEMO_SIGNATURE_HEADER = 'x-unyly-demo-signature';

export interface DemoProviderDeps {
  db: Db;
  now: () => Date;
  webhookSecret: string;
  timeScale: number;
}

export class DemoProvider implements Provider {
  readonly mode = 'demo' as const;
  readonly providerName = 'demo';
  faults: DemoFaults = {};
  constructor(private deps: DemoProviderDeps) {}

  capabilities(): Record<CapabilityKey, Capability> {
    const ok: Capability = { available: true, source: 'Unyly demo simulator (synthetic data, no real charges or deliveries)' };
    return {
      search_restaurants: ok, get_menu: ok, cart: ok, quote: ok, checkout: ok, submit_order: ok, order_status: ok, cancel_order: ok,
      handoff: { available: false, reason: 'Demo stores do not exist in Grab, so there is nothing to hand off.' },
    };
  }

  resolvePlace(text: string, saved: { id?: string; label: string; district: string; city: string }[]) {
    return resolvePlace(text, saved);
  }

  private delivers(r: DemoRestaurant, a: DeliveryAddress | null): boolean | null {
    if (!a) return null;
    if (a.city.trim().toLowerCase() !== DEMO_CITY.toLowerCase()) return false;
    const d = DEMO_DISTRICTS.find((x) => x.toLowerCase() === a.district.trim().toLowerCase());
    if (!d) return false;
    return r.districts === null || r.districts.includes(d);
  }

  private toRestaurant(r: DemoRestaurant, a: DeliveryAddress | null): Restaurant {
    return {
      id: r.id, name: r.name, service: r.service, category: r.category, notice: r.notice, cuisines: r.cuisines, is_open: r.open, opening_note: r.opening_note, currency: 'THB',
      delivery_fee_minor: r.delivery_fee_minor, min_order_minor: r.min_order_minor,
      small_order_threshold_minor: r.small_order_threshold_minor, small_order_fee_minor: r.small_order_fee_minor,
      eta_min_minutes: r.eta[0], eta_max_minutes: r.eta[1], delivers_to_address: isTripService(r.service) ? null : this.delivers(r, a), promo: r.promo?.text,
    };
  }

  private item(r: DemoRestaurant, id: string): MenuItem | undefined {
    const it = r.items.find((i) => i.id === id);
    if (!it) return undefined;
    const bump = this.faults.priceBumpMinor ?? 0;
    const oos = this.faults.outOfStockItemIds?.includes(id);
    return { ...it, price_minor: it.price_minor + bump, available: it.available && !oos };
  }

  private guard() {
    if (this.faults.unavailable) throw new ProviderUnavailableError('Demo provider is unavailable (injected fault)');
  }

  async searchRestaurants(q: { address: DeliveryAddress | null; query?: string; cuisine?: string; service?: Service; category?: string }): Promise<Restaurant[]> {
    this.guard();
    const text = q.query?.toLowerCase().trim();
    const service = q.service ?? 'food';
    return DEMO_RESTAURANTS.filter((r) => {
      if (r.service !== service) return false;
      if (q.category && r.category !== q.category) return false;
      if (q.cuisine && !r.cuisines.includes(q.cuisine.toLowerCase())) return false;
      if (text) {
        const hay = [r.name, ...r.cuisines, ...r.items.map((i) => `${i.name} ${i.category}`)].join(' ').toLowerCase();
        if (!text.split(/\s+/).some((w) => w.length > 2 && hay.includes(w))) return false;
      }
      return true;
    }).map((r) => this.toRestaurant(r, q.address));
  }

  async getMenu(restaurantId: string, address: DeliveryAddress | null) {
    this.guard();
    const r = findRestaurant(restaurantId);
    if (!r) throw Object.assign(new Error('restaurant not found'), { notFound: true });
    return { restaurant: this.toRestaurant(r, address), items: r.items.map((i) => this.item(r, i.id)!) };
  }

  /** Pure pricing used by both quote and submit, so the provider can detect price drift itself. */
  private price(restaurantId: string, lines: CartLine[], address: DeliveryAddress | null, trip?: Trip | null) {
    const r = findRestaurant(restaurantId);
    if (!r) throw Object.assign(new Error('restaurant not found'), { notFound: true });
    if (isTripService(r.service)) return this.priceTrip(r, lines, trip ?? null);
    const issues: QuoteIssue[] = [];
    if (!r.open) issues.push({ code: 'RESTAURANT_CLOSED', message: r.opening_note || 'Store is closed' });
    if (!address || !this.delivers(r, address)) issues.push({ code: 'DELIVERY_UNAVAILABLE', message: 'Store does not deliver to this address' });
    const qlines: QuoteLine[] = lines.map((l) => {
      const it = l.item_id ? this.item(r, l.item_id) : undefined;
      if (!it) {
        issues.push({ code: 'ITEM_NOT_FOUND', message: `Item not found: ${l.name}`, line_id: l.line_id });
        return { line_id: l.line_id, item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers_desc: [], unit_price_minor: 0, line_total_minor: 0, available: false };
      }
      const problem = validateModifiers(it, l.modifiers);
      if (problem) issues.push({ code: 'MODIFIERS_INVALID', message: problem, line_id: l.line_id });
      let unit = it.price_minor;
      const desc: string[] = [];
      for (const sel of l.modifiers) {
        const g = it.modifier_groups.find((x) => x.id === sel.group_id);
        for (const oid of sel.option_ids) {
          const o = g?.options.find((x) => x.id === oid);
          if (o) {
            unit += o.price_delta_minor;
            desc.push(`${g!.name}: ${o.name}`);
            if (!o.available) issues.push({ code: 'OUT_OF_STOCK', message: `${o.name} is unavailable`, line_id: l.line_id });
          }
        }
      }
      if (!it.available) issues.push({ code: 'OUT_OF_STOCK', message: `${it.name} is out of stock`, line_id: l.line_id });
      if (it.max_quantity && l.quantity > it.max_quantity) {
        issues.push({ code: 'QUANTITY_LIMIT', message: `At most ${it.max_quantity} of ${it.name} per order`, line_id: l.line_id });
      }
      return { line_id: l.line_id, item_id: it.id, name: it.name, quantity: l.quantity, modifiers_desc: desc, unit_price_minor: unit, line_total_minor: unit * l.quantity, available: it.available };
    });
    // Per-order limits apply to the item across all lines, not per line.
    const perItem = new Map<string, number>();
    for (const l of lines) if (l.item_id) perItem.set(l.item_id, (perItem.get(l.item_id) ?? 0) + l.quantity);
    for (const [id, n] of perItem) {
      const it = r.items.find((x) => x.id === id);
      if (it?.max_quantity && n > it.max_quantity && !lines.some((l) => l.item_id === id && l.quantity > it.max_quantity!)) {
        issues.push({ code: 'QUANTITY_LIMIT', message: `At most ${it.max_quantity} of ${it.name} per order (cart has ${n})` });
      }
    }
    const subtotal = qlines.reduce((s, l) => s + l.line_total_minor, 0);
    if (r.min_order_minor && subtotal < r.min_order_minor) {
      issues.push({ code: 'MINIMUM_ORDER_NOT_MET', message: `Minimum food subtotal is ${r.min_order_minor / 100} THB; add ${(r.min_order_minor - subtotal) / 100} THB more` });
    }
    const smallFee = r.small_order_threshold_minor && subtotal < r.small_order_threshold_minor ? r.small_order_fee_minor : 0;
    let discount = 0;
    if (r.promo && subtotal >= r.promo.min_subtotal_minor) {
      discount = Math.min(Math.floor((subtotal * r.promo.percent) / 100), r.promo.max_discount_minor);
    }
    const total = subtotal + r.delivery_fee_minor + DEMO_SERVICE_FEE_MINOR + smallFee - discount;
    return { r, qlines, issues, subtotal, smallFee, discount, total, serviceFee: DEMO_SERVICE_FEE_MINOR, eta: r.eta };
  }

  /** Ride / express: one vehicle line priced by the trip. */
  private priceTrip(r: DemoRestaurant, lines: CartLine[], trip: Trip | null) {
    const issues: QuoteIssue[] = [];
    const qlines: QuoteLine[] = [];
    if (!trip) issues.push({ code: 'TRIP_REQUIRED', message: 'Pickup and drop-off are required' });
    else if (trip.distance_km === undefined) issues.push({ code: 'OUTSIDE_SERVICE_AREA', message: 'Pickup or drop-off is outside the demo map' });
    if (lines.length !== 1 || lines[0].quantity !== 1) {
      issues.push({ code: 'MODIFIERS_INVALID', message: 'Choose exactly one vehicle type' });
    }
    for (const l of lines) {
      const it = l.item_id ? this.item(r, l.item_id) : undefined;
      if (!it?.vehicle) {
        issues.push({ code: 'ITEM_NOT_FOUND', message: `Vehicle type not found: ${l.name}`, line_id: l.line_id });
        qlines.push({ line_id: l.line_id, item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers_desc: [], unit_price_minor: 0, line_total_minor: 0, available: false });
        continue;
      }
      if (r.service === 'express') {
        if (!trip?.parcel) issues.push({ code: 'TRIP_REQUIRED', message: 'Parcel weight is required' });
        else if (it.vehicle.max_weight_kg !== undefined && trip.parcel.weight_kg > it.vehicle.max_weight_kg) {
          issues.push({ code: 'WEIGHT_LIMIT', message: `${it.name} carries up to ${it.vehicle.max_weight_kg} kg; parcel is ${trip.parcel.weight_kg} kg`, line_id: l.line_id });
        }
      }
      const unit = (trip && demoFare(it, trip)) ?? 0;
      if (!it.available) issues.push({ code: 'OUT_OF_STOCK', message: `${it.name} is not available right now`, line_id: l.line_id });
      qlines.push({ line_id: l.line_id, item_id: it.id, name: it.name, quantity: l.quantity, modifiers_desc: it.vehicle.note ? [it.vehicle.note] : [], unit_price_minor: unit, line_total_minor: unit * l.quantity, available: it.available });
    }
    if (r.service === 'ride' && trip?.pickup.is_airport) {
      qlines.push({ line_id: 'fee_airport', name: 'Airport pickup fee', quantity: 1, modifiers_desc: [], unit_price_minor: DEMO_AIRPORT_PICKUP_FEE_MINOR, line_total_minor: DEMO_AIRPORT_PICKUP_FEE_MINOR, available: true });
    }
    const subtotal = qlines.reduce((s, l) => s + l.line_total_minor, 0);
    const dur = trip?.duration_min ?? 20;
    const eta: [number, number] = r.service === 'ride' ? [dur + 3, dur + 10] : [dur + 10, dur + 25];
    return { r, qlines, issues, subtotal, smallFee: 0, discount: 0, total: subtotal, serviceFee: 0, eta };
  }

  async quote(req: { restaurant_id: string; lines: CartLine[]; address: DeliveryAddress | null; trip?: Trip | null }): Promise<ProviderQuote> {
    this.guard();
    const p = this.price(req.restaurant_id, req.lines, req.address, req.trip);
    return {
      currency: 'THB', lines: p.qlines, subtotal_minor: p.subtotal, delivery_fee_minor: p.r.delivery_fee_minor,
      service_fee_minor: p.serviceFee, small_order_fee_minor: p.smallFee, discount_minor: p.discount, total_minor: p.total,
      eta_min_minutes: p.eta[0], eta_max_minutes: p.eta[1], issues: p.issues,
      price_source: isTripService(p.r.service) ? 'Demo fare formula (synthetic distance and time)' : 'Demo simulator price list (synthetic)',
      valid_for_seconds: DEMO_QUOTE_TTL_SECONDS,
      payment_method_label: 'Demo wallet (no real charge)',
      cancellation_terms: CANCEL_TERMS[p.r.service],
    };
  }

  async submitOrder(req: SubmitRequest): Promise<SubmitResult> {
    this.guard();
    if (this.faults.hangBeforeAccept) return new Promise<never>(() => {});
    // Provider-side idempotency: a repeated key returns the original order.
    const existing = await this.deps.db.query('SELECT ref, status FROM demo_sim_orders WHERE idempotency_key = $1', [req.idempotency_key]);
    if (existing.rows[0]) {
      return { outcome: 'accepted', provider_order_ref: existing.rows[0].ref, status: existing.rows[0].status, payment_status: 'not_charged_demo' };
    }
    const p = this.price(req.restaurant_id, req.lines, req.address, req.trip);
    const blocking = p.issues[0]; // every issue blocks a real submission
    if (blocking) {
      const code = blocking.code === 'RESTAURANT_CLOSED' || blocking.code === 'DELIVERY_UNAVAILABLE' || blocking.code === 'OUT_OF_STOCK' ? blocking.code : 'PROVIDER_REJECTED';
      return { outcome: 'rejected', code, message: blocking.message };
    }
    if (p.total !== req.expected_total_minor || req.currency !== 'THB') {
      return { outcome: 'rejected', code: 'PRICE_CHANGED', message: `Provider total is ${p.total} THB minor units, expected ${req.expected_total_minor}` };
    }
    const ref = `DEMO-${randomToken(9).replace(/[-_]/g, 'x').toUpperCase()}`;
    const now = this.deps.now();
    await this.deps.db.query(
      `INSERT INTO demo_sim_orders (ref, idempotency_key, payload, total_minor, status, sequence, accepted_at) VALUES ($1,$2,$3,$4,'accepted',1,$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [ref, req.idempotency_key, JSON.stringify({ restaurant_id: req.restaurant_id, service: p.r.service, lines: req.lines, trip_minutes: req.trip?.duration_min ?? null }), p.total, now],
    );
    const row = (await this.deps.db.query('SELECT ref, status FROM demo_sim_orders WHERE idempotency_key = $1', [req.idempotency_key])).rows[0];
    if (this.faults.hangAfterAccept) return new Promise<never>(() => {});
    if (this.faults.timeoutAfterAccept) throw new ProviderOutcomeUnknownError('Demo provider: response lost after accept (injected fault)');
    const eta = new Date(now.getTime() + (p.eta[1] * 60000) / this.deps.timeScale).toISOString();
    return { outcome: 'accepted', provider_order_ref: row.ref, status: row.status, payment_status: 'not_charged_demo', eta_at: eta };
  }

  async lookupByIdempotencyKey(key: string): Promise<LookupResult> {
    if (this.faults.unavailable || this.faults.lookupUnavailable) throw new ProviderUnavailableError('Demo provider lookup unavailable (injected fault)');
    const r = await this.deps.db.query('SELECT ref, status FROM demo_sim_orders WHERE idempotency_key = $1', [key]);
    if (!r.rows[0]) return { found: false };
    return { found: true, provider_order_ref: r.rows[0].ref, status: r.rows[0].status, payment_status: 'not_charged_demo' };
  }

  /** Advance simulated fulfilment according to the demo clock. */
  private async advance(ref: string) {
    const r = await this.deps.db.query('SELECT * FROM demo_sim_orders WHERE ref = $1', [ref]);
    const row = r.rows[0];
    if (!row) return undefined;
    if (row.status === 'cancelled' || row.status === 'delivered') return row;
    const elapsedMin = ((this.deps.now().getTime() - new Date(row.accepted_at).getTime()) / 60000) * this.deps.timeScale * Number(row.speed ?? 1);
    let target: FulfillmentStatus = 'accepted';
    for (const t of timeline(row.payload.service ?? 'food', row.payload.trip_minutes ?? undefined)) if (elapsedMin >= t.atMinute) target = t.status;
    if (SEQ[target] > row.sequence) {
      const u = await this.deps.db.query(
        `UPDATE demo_sim_orders SET status = $2, sequence = $3 WHERE ref = $1 AND status NOT IN ('cancelled','delivered') AND sequence < $3 RETURNING *`,
        [ref, target, SEQ[target]],
      );
      return u.rows[0] ?? (await this.deps.db.query('SELECT * FROM demo_sim_orders WHERE ref = $1', [ref])).rows[0];
    }
    return row;
  }

  async getOrderStatus(ref: string): Promise<ProviderOrderStatus> {
    this.guard();
    const row = await this.advance(ref);
    if (!row) throw Object.assign(new Error('order not found'), { notFound: true });
    return { provider_order_ref: ref, status: row.status, payment_status: 'not_charged_demo', sequence: row.sequence };
  }

  async getCancellationTerms(ref: string): Promise<CancellationTerms> {
    this.guard();
    const row = await this.advance(ref);
    if (!row) throw Object.assign(new Error('order not found'), { notFound: true });
    const service: Service = row.payload.service ?? 'food';
    const food = (row.payload.lines as CartLine[]).length ? row.total_minor : 0;
    if (service === 'ride' || service === 'express') {
      const who = service === 'ride' ? 'driver' : 'courier';
      if (row.status === 'accepted') return { allowed: true, fee_minor: 0, currency: 'THB', terms: `Free cancellation: the ${who} has just been assigned (demo).` };
      if (row.status === 'preparing') {
        const fee = service === 'ride' ? 3000 : 2000;
        return { allowed: true, fee_minor: fee, currency: 'THB', terms: `The ${who} is on the way: ${fee / 100} THB cancellation fee (demo, not charged).` };
      }
      return { allowed: false, fee_minor: 0, currency: 'THB', terms: service === 'ride' ? 'Cannot cancel: the trip has started or ended.' : 'Cannot cancel: the parcel has been picked up.' };
    }
    const who = service === 'mart' ? 'store' : 'restaurant';
    if (row.status === 'accepted') return { allowed: true, fee_minor: 0, currency: 'THB', terms: `Free cancellation: the ${who} has not started preparing (demo).` };
    if (row.status === 'preparing') {
      return { allowed: true, fee_minor: Math.round(food / 2), currency: 'THB', terms: `The ${who} is preparing the order: 50% cancellation fee (demo, not charged).` };
    }
    return { allowed: false, fee_minor: 0, currency: 'THB', terms: `Cannot cancel: order is ${row.status}.` };
  }

  async cancelOrder(ref: string, _key: string, maxFeeMinor: number): Promise<CancelResult> {
    this.guard();
    const already = (await this.deps.db.query('SELECT status FROM demo_sim_orders WHERE ref=$1', [ref])).rows[0];
    if (already?.status === 'cancelled') return { outcome: 'cancelled', fee_minor: 0 }; // idempotent repeat
    const terms = await this.getCancellationTerms(ref);
    if (!terms.allowed) return { outcome: 'rejected', message: terms.terms };
    if (terms.fee_minor > maxFeeMinor) return { outcome: 'rejected', message: `FEE_CHANGED: cancellation fee is now ${terms.fee_minor}` };
    const u = await this.deps.db.query(
      `UPDATE demo_sim_orders SET status='cancelled', sequence = sequence + 1, cancelled_at = $2 WHERE ref = $1 AND status IN ('accepted','preparing') RETURNING ref`,
      [ref, this.deps.now()],
    );
    if (!u.rowCount) {
      const row = (await this.deps.db.query('SELECT status FROM demo_sim_orders WHERE ref=$1', [ref])).rows[0];
      if (row?.status === 'cancelled') return { outcome: 'cancelled', fee_minor: terms.fee_minor };
      return { outcome: 'rejected', message: 'Order state changed; cannot cancel now.' };
    }
    return { outcome: 'cancelled', fee_minor: terms.fee_minor };
  }

  // ----- Webhooks (demo scheme: HMAC-SHA256 over "<t>.<raw body>") -----
  sign(rawBody: string, t = Math.floor(this.deps.now().getTime() / 1000)): string {
    return `t=${t},v1=${hmac(this.deps.webhookSecret, `${t}.${rawBody}`)}`;
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent[] {
    const h = headers[DEMO_SIGNATURE_HEADER];
    const sig = Array.isArray(h) ? h[0] : h;
    if (!sig) throw new Error('missing signature');
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    if (!m) throw new Error('malformed signature');
    const t = Number(m[1]);
    const skew = Math.abs(this.deps.now().getTime() / 1000 - t);
    if (skew > 300) throw new Error('signature timestamp outside tolerance');
    const expected = hmac(this.deps.webhookSecret, `${t}.${rawBody}`);
    if (!safeEqual(expected, m[2])) throw new Error('bad signature');
    const body = JSON.parse(rawBody);
    const events = Array.isArray(body.events) ? body.events : [];
    return events.map((e: any) => ({
      event_id: String(e.event_id), order_ref: String(e.order_ref), sequence: Number(e.sequence), type: 'order.status_changed',
      status: e.status, payment_status: e.payment_status ?? 'not_charged_demo', occurred_at: String(e.occurred_at), eta_at: e.eta_at,
    }));
  }

  /** Simulator: advance orders and emit signed webhook deliveries for new states. */
  async tick(deliver: (rawBody: string, headers: Record<string, string>) => Promise<void>): Promise<number> {
    const open = await this.deps.db.query(`SELECT ref FROM demo_sim_orders WHERE last_emitted_seq < 5 AND (status NOT IN ('delivered','cancelled') OR last_emitted_seq < sequence)`);
    let sent = 0;
    for (const { ref } of open.rows) {
      const row = await this.advance(ref);
      if (!row || row.sequence <= row.last_emitted_seq) continue;
      const events = [{
        event_id: `${ref}:${row.sequence}`, order_ref: ref, sequence: row.sequence, type: 'order.status_changed',
        status: row.status, payment_status: 'not_charged_demo', occurred_at: this.deps.now().toISOString(),
      }];
      const raw = JSON.stringify({ events });
      await deliver(raw, { [DEMO_SIGNATURE_HEADER]: this.sign(raw), 'content-type': 'application/json' });
      await this.deps.db.query('UPDATE demo_sim_orders SET last_emitted_seq = GREATEST(last_emitted_seq, $2) WHERE ref = $1', [ref, row.sequence]);
      sent++;
    }
    return sent;
  }
}

const CANCEL_TERMS: Record<Service, string> = {
  food: 'Demo terms: free cancellation before the restaurant starts preparing; 50% of the total after that; not possible once picked up.',
  mart: 'Demo terms: free cancellation before the store starts picking; 50% of the total after that; not possible once picked up.',
  ride: 'Demo terms: free cancellation right after a driver is assigned; 30 THB once the driver is on the way; not possible after pickup.',
  express: 'Demo terms: free cancellation right after a courier is assigned; 20 THB once the courier is on the way; not possible after pickup.',
};

/** Region list is exported for capability reporting; the demo catalog covers Bangkok only. */
export const DEMO_REGION = REGIONS.TH;

export function validateModifiers(it: MenuItem, selected: { group_id: string; option_ids: string[] }[]): string | null {
  for (const sel of selected) {
    const g = it.modifier_groups.find((x) => x.id === sel.group_id);
    if (!g) return `Unknown modifier group "${sel.group_id}" for ${it.name}`;
    if (new Set(sel.option_ids).size !== sel.option_ids.length) return `Duplicate options in "${g.name}"`;
    for (const o of sel.option_ids) if (!g.options.find((x) => x.id === o)) return `Unknown option "${o}" in "${g.name}"`;
  }
  for (const g of it.modifier_groups) {
    const n = selected.find((s) => s.group_id === g.id)?.option_ids.length ?? 0;
    if (n < g.min_select) return `"${g.name}" is required for ${it.name}: choose ${g.min_select}`;
    if (n > g.max_select) return `"${g.name}" allows at most ${g.max_select} option(s)`;
  }
  return null;
}
