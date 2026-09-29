import type { Db } from '../../db/db.js';
import { hmac, randomToken, safeEqual } from '../../domain/crypto.js';
import {
  CapabilityKey, Capability, CancelResult, CancellationTerms, CartLine, DeliveryAddress, FulfillmentStatus, LookupResult,
  MenuItem, Provider, ProviderEvent, ProviderOrderStatus, ProviderOutcomeUnknownError, ProviderQuote, ProviderUnavailableError,
  QuoteIssue, QuoteLine, Restaurant, SubmitRequest, SubmitResult,
} from '../types.js';
import { DEMO_CITY, DEMO_DISTRICTS, DEMO_QUOTE_TTL_SECONDS, DEMO_RESTAURANTS, DEMO_SERVICE_FEE_MINOR, DemoRestaurant, findRestaurant } from './catalog.js';

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

const TIMELINE: { status: FulfillmentStatus; atMinute: number }[] = [
  { status: 'accepted', atMinute: 0 },
  { status: 'preparing', atMinute: 2 },
  { status: 'picked_up', atMinute: 15 },
  { status: 'delivered', atMinute: 30 },
];
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
      handoff: { available: false, reason: 'Demo restaurants do not exist in Grab, so there is nothing to hand off.' },
    };
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
      id: r.id, name: r.name, cuisines: r.cuisines, is_open: r.open, opening_note: r.opening_note, currency: 'THB',
      delivery_fee_minor: r.delivery_fee_minor, min_order_minor: r.min_order_minor,
      small_order_threshold_minor: r.small_order_threshold_minor, small_order_fee_minor: r.small_order_fee_minor,
      eta_min_minutes: r.eta[0], eta_max_minutes: r.eta[1], delivers_to_address: this.delivers(r, a), promo: r.promo?.text,
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

  async searchRestaurants(q: { address: DeliveryAddress | null; query?: string; cuisine?: string }): Promise<Restaurant[]> {
    this.guard();
    const text = q.query?.toLowerCase().trim();
    return DEMO_RESTAURANTS.filter((r) => {
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
  private price(restaurantId: string, lines: CartLine[], address: DeliveryAddress) {
    const r = findRestaurant(restaurantId);
    if (!r) throw Object.assign(new Error('restaurant not found'), { notFound: true });
    const issues: QuoteIssue[] = [];
    if (!r.open) issues.push({ code: 'RESTAURANT_CLOSED', message: r.opening_note || 'Restaurant is closed' });
    if (!this.delivers(r, address)) issues.push({ code: 'DELIVERY_UNAVAILABLE', message: 'Restaurant does not deliver to this address' });
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
      return { line_id: l.line_id, item_id: it.id, name: it.name, quantity: l.quantity, modifiers_desc: desc, unit_price_minor: unit, line_total_minor: unit * l.quantity, available: it.available };
    });
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
    return { r, qlines, issues, subtotal, smallFee, discount, total };
  }

  async quote(req: { restaurant_id: string; lines: CartLine[]; address: DeliveryAddress }): Promise<ProviderQuote> {
    this.guard();
    const p = this.price(req.restaurant_id, req.lines, req.address);
    return {
      currency: 'THB', lines: p.qlines, subtotal_minor: p.subtotal, delivery_fee_minor: p.r.delivery_fee_minor,
      service_fee_minor: DEMO_SERVICE_FEE_MINOR, small_order_fee_minor: p.smallFee, discount_minor: p.discount, total_minor: p.total,
      eta_min_minutes: p.r.eta[0], eta_max_minutes: p.r.eta[1], issues: p.issues,
      price_source: 'Demo simulator price list (synthetic)', valid_for_seconds: DEMO_QUOTE_TTL_SECONDS,
      payment_method_label: 'Demo wallet (no real charge)',
      cancellation_terms: 'Demo terms: free cancellation before the restaurant starts preparing; 50% of food subtotal after that; not possible once picked up.',
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
    const p = this.price(req.restaurant_id, req.lines, req.address);
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
      [ref, req.idempotency_key, JSON.stringify({ restaurant_id: req.restaurant_id, lines: req.lines }), p.total, now],
    );
    const row = (await this.deps.db.query('SELECT ref, status FROM demo_sim_orders WHERE idempotency_key = $1', [req.idempotency_key])).rows[0];
    if (this.faults.hangAfterAccept) return new Promise<never>(() => {});
    if (this.faults.timeoutAfterAccept) throw new ProviderOutcomeUnknownError('Demo provider: response lost after accept (injected fault)');
    const eta = new Date(now.getTime() + (p.r.eta[1] * 60000) / this.deps.timeScale).toISOString();
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
    const elapsedMin = ((this.deps.now().getTime() - new Date(row.accepted_at).getTime()) / 60000) * this.deps.timeScale;
    let target: FulfillmentStatus = 'accepted';
    for (const t of TIMELINE) if (elapsedMin >= t.atMinute) target = t.status;
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
    const food = (row.payload.lines as CartLine[]).length ? row.total_minor : 0;
    if (row.status === 'accepted') return { allowed: true, fee_minor: 0, currency: 'THB', terms: 'Free cancellation: the restaurant has not started preparing (demo).' };
    if (row.status === 'preparing') {
      return { allowed: true, fee_minor: Math.round(food / 2), currency: 'THB', terms: 'The restaurant is preparing the order: 50% cancellation fee (demo, not charged).' };
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
