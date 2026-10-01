// Live mode against real Grab partner APIs (docs/grab-api-research.md, sections 1 and 2).
//
// - Express (parcel): GrabExpress Delivery API. Quote, create on human confirmation, track (webhook and
//   GET), cancel. Enabled with GRAB_EXPRESS=on.
// - Ride: Partner Farefeed estimates only (fare range, ETA, surge, deep link). There is no ride booking
//   API, so the booking is handed off to the Grab app through the deep link. Enabled with GRAB_FAREFEED=on.
// - Food and Mart: no public consumer ordering API exists; every call fails with an explicit reason.
//   Nothing ever falls back to demo data.
import type { Db } from '../../db/db.js';
import { DomainError } from '../../domain/errors.js';
import { exponentOf } from '../../domain/money.js';
import {
  CancelResult, CancellationTerms, Capability, CapabilityKey, CapabilityUnavailableError, CartLine, FulfillmentStatus, LookupResult, MenuItem, PaymentStatus,
  Provider, ProviderEvent, ProviderOrderStatus, ProviderOutcomeUnknownError, ProviderQuote, ProviderUnavailableError, QuoteIssue, Restaurant, RideEstimate,
  SavedPlaceInfo, Service, SubmitRequest, SubmitResult, Trip,
} from '../types.js';
import type { GrabConfig } from './config.js';
import { CANCELLABLE, ExpressContact, ExpressCreateRequest, ExpressLocation, ExpressPackage, ExpressQuoteRequest, GrabExpressClient, mapGrabStatus, toMinor } from './express.js';
import { GrabFarefeedClient, NoRideServiceError } from './farefeed.js';
import { GrabHttp, GrabTransportError, grabErrorMessage } from './http.js';
import { resolveLivePlace } from './places.js';
import { GrabTokenCache } from './token.js';

const CHECKED = '2026-10-01';
const SRC_EXPRESS = 'GrabExpress Delivery API, https://developer.grab.com/docs/grab-express/';
const SRC_FAREFEED = 'Grab Partner Farefeed API, https://developer.grab.com/docs/partner-farefeed/';
const SRC_FOOD = 'https://developer.grab.com/docs/grabfood/api/v1-1-3/ ; https://developer.grab.com/docs/grabmart/api/v1-1-3/';

export const FOOD_MART_REASON = 'Grab has no public API to place Food or Mart orders for a customer; use Handoff mode';
export const RIDE_BOOKING_REASON =
  'Grab has no public API to book a ride for a customer. estimate_trip (service "ride") returns Grab fare ranges with a deep_link that opens the Grab app with the trip prefilled; the user books and pays there, and Unyly does not see the booking.';
const EXPRESS_OFF = 'GrabExpress ordering is not enabled on this server (GRAB_EXPRESS=off).';
const FAREFEED_OFF = 'Grab ride estimates are not enabled on this server (GRAB_FAREFEED=off).';

export const EXPRESS_STORE_ID = 'grab-express';
export const RIDE_STORE_ID = 'grab-transport';
const VEHICLE_PREFIX = 'express-';

const VEHICLE_NAMES: Record<string, string> = {
  BIKE: 'Bike', CAR: 'Car', JUSTEXPRESS: 'JustExpress', VAN: 'Van', TRUCK: 'Truck', TRIKE: 'Trike', EBIKE: 'E-bike', SUV: 'SUV',
  BOXPICKUPTRUCK: 'Box pickup truck', TRICYCLE: 'Tricycle', CYCLE: 'Bicycle', FOOT: 'On foot',
};

/** Quote validity Unyly applies (Grab documents none); approval re-prices the exact cart after it. */
const QUOTE_TTL_SECONDS = 300;

export interface GrabLiveDeps {
  db: Db;
  cfg: GrabConfig;
  /** Public origin, for links in user actions (addresses page). */
  webOrigin: string;
  /** Overall time the caller gives submitOrder (PROVIDER_TIMEOUT_MS); the fresh quote and the create share it. */
  submitBudgetMs: number;
  now: () => Date;
  fetch?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

interface DeliveryRow {
  merchant_order_id: string;
  idempotency_key: string;
  submission_id: string | null;
  delivery_id: string | null;
  order_ref: string | null;
  state: 'sending' | 'created' | 'unknown' | 'rejected' | 'not_sent' | 'not_found' | 'cancelled_unresolved';
  last_status: string | null;
  last_status_rank: number;
  currency: string | null;
  payment_method: 'CASH' | 'CASHLESS';
  error_detail: string | null;
  created_at: string;
}

interface AddressInfo {
  id: string;
  label: string;
  line1: string;
  district: string;
  city: string;
  instructions: string | null;
  latitude: number | null;
  longitude: number | null;
  contact_name: string | null;
  contact_phone: string | null;
}

/** Package size when the user only gave a weight: conservative boxes within Grab's default 50 x 50 x 50 cm. */
export function defaultDimensions(weightKg: number) {
  const weight = Math.max(1, Math.round(weightKg * 1000));
  if (weightKg <= 3) return { height: 20, width: 30, depth: 25, weight };
  if (weightKg <= 10) return { height: 30, width: 40, depth: 40, weight };
  return { height: 50, width: 50, depth: 50, weight };
}

function splitName(full: string): { firstName: string; lastName?: string } {
  const [first, ...rest] = full.trim().split(/\s+/);
  return rest.length ? { firstName: first, lastName: rest.join(' ') } : { firstName: first };
}

const grabPhone = (e164: string) => e164.replace(/^\+/, '');
const fixed6 = (n: number) => Math.round(n * 1e6) / 1e6;

export class GrabLiveProvider implements Provider {
  readonly mode = 'live' as const;
  readonly providerName = 'grab';
  readonly tokens: GrabTokenCache;
  readonly express: GrabExpressClient;
  readonly farefeed: GrabFarefeedClient;
  private cfg: GrabConfig;

  constructor(private deps: GrabLiveDeps) {
    this.cfg = deps.cfg;
    this.tokens = new GrabTokenCache({ fetch: deps.fetch, timeoutMs: deps.cfg.timeoutMs, log: deps.log });
    // Separate pacers: GrabExpress and Farefeed have separate rate limits.
    const http = (rps: number) => new GrabHttp({ tokens: this.tokens, fetch: deps.fetch, timeoutMs: deps.cfg.timeoutMs, rps, log: deps.log });
    this.express = new GrabExpressClient(http(deps.cfg.rps), deps.cfg);
    this.farefeed = new GrabFarefeedClient(http(deps.cfg.rps), deps.cfg);
  }

  private get payment(): 'CASH' | 'CASHLESS' {
    return this.cfg.express.payment === 'cash' ? 'CASH' : 'CASHLESS';
  }

  capabilities(): Record<CapabilityKey, Capability> {
    const ex = this.cfg.express.enabled;
    const ff = this.cfg.farefeed.enabled;
    const food: Capability = { available: false, reason: FOOD_MART_REASON, source: SRC_FOOD, verified_at: CHECKED };
    const order: Capability = ex
      ? { available: true, source: `${SRC_EXPRESS} (parcels only). Rides: ${RIDE_BOOKING_REASON}`, verified_at: CHECKED }
      : { available: false, reason: ff ? `${EXPRESS_OFF} ${RIDE_BOOKING_REASON}` : EXPRESS_OFF, source: SRC_EXPRESS, verified_at: CHECKED };
    const sources = [ex ? SRC_EXPRESS : null, ff ? SRC_FAREFEED : null].filter(Boolean).join(' ; ');
    return {
      search_restaurants: food,
      get_menu: food,
      cart: order,
      quote: ex || ff ? { available: true, source: sources, verified_at: CHECKED } : { available: false, reason: `${EXPRESS_OFF} ${FAREFEED_OFF}` },
      checkout: order,
      submit_order: order,
      order_status: order,
      cancel_order: order,
      handoff: {
        available: false, verified_at: CHECKED,
        reason: ff
          ? 'Rides are handed off through the deep_link returned by estimate_trip. Food and Mart need Handoff mode.'
          : 'Food and Mart need Handoff mode.',
      },
    };
  }

  private requireExpress() {
    if (!this.cfg.express.enabled) throw new CapabilityUnavailableError('submit_order', EXPRESS_OFF);
  }

  private notFoodOrMart(): never {
    throw new CapabilityUnavailableError('search_restaurants', FOOD_MART_REASON);
  }

  private storeFor(service: Service): Restaurant {
    const cash = this.payment === 'CASH';
    const base = {
      cuisines: [], is_open: true, currency: this.cfg.express.currency, delivery_fee_minor: 0, min_order_minor: 0, small_order_threshold_minor: 0, small_order_fee_minor: 0,
      eta_min_minutes: 0, eta_max_minutes: 0, delivers_to_address: null,
    };
    if (service === 'express') {
      return {
        ...base, id: EXPRESS_STORE_ID, name: 'GrabExpress', service: 'express', category: 'parcel',
        notice:
          'Live GrabExpress: after the user confirms on the Unyly page, a real courier is booked. Fee and ETA come from the live Grab quote. ' +
          (cash
            ? 'Payment: cash, the sender pays the courier at pickup. '
            : 'Payment: GrabPay. After Confirm the user is sent to Grab to approve the payment; the courier is booked only after the payment is captured. ') +
          'Pickup and drop-off must be saved addresses with exact coordinates and a contact name and phone.',
      };
    }
    return { ...base, id: RIDE_STORE_ID, name: 'Grab transport', service: 'ride', category: 'transport', notice: `Live ride estimates from Grab. ${RIDE_BOOKING_REASON}` };
  }

  async searchRestaurants(q: { service?: Service }): Promise<Restaurant[]> {
    if (q.service === 'express') {
      this.requireExpress();
      return [this.storeFor('express')];
    }
    if (q.service === 'ride') {
      if (!this.cfg.farefeed.enabled) throw new CapabilityUnavailableError('quote', FAREFEED_OFF);
      return [this.storeFor('ride')];
    }
    return this.notFoodOrMart();
  }

  async getMenu(restaurantId: string): Promise<{ restaurant: Restaurant; items: MenuItem[] }> {
    if (restaurantId === RIDE_STORE_ID) throw new CapabilityUnavailableError('submit_order', RIDE_BOOKING_REASON);
    if (restaurantId !== EXPRESS_STORE_ID) return this.notFoodOrMart();
    this.requireExpress();
    return {
      restaurant: this.storeFor('express'),
      items: this.cfg.express.vehicles.map((v) => ({
        id: `${VEHICLE_PREFIX}${v.toLowerCase()}`,
        name: VEHICLE_NAMES[v] ?? v,
        description: `GrabExpress vehicle type ${v}. Size and weight limits follow the Grab agreement (default package limit 50 x 50 x 50 cm).`,
        category: 'vehicle',
        price_minor: 0,
        available: true,
        modifier_groups: [],
        allergen_info: { status: 'not_applicable', declared: [] },
        dietary_tags_declared: [],
        vehicle: { base_minor: 0, per_km_minor: 0, per_min_minor: 0, note: 'Fee from the live Grab quote' },
      })),
    };
  }

  private vehicleOf(itemId: string | undefined): string | null {
    if (!itemId?.startsWith(VEHICLE_PREFIX)) return null;
    const v = itemId.slice(VEHICLE_PREFIX.length).toUpperCase();
    return this.cfg.express.vehicles.includes(v) ? v : null;
  }

  resolvePlace(text: string, saved: SavedPlaceInfo[]) {
    return resolveLivePlace(text, saved, `${this.deps.webOrigin}/app/addresses`);
  }

  private addressesUrl() {
    return `${this.deps.webOrigin}/app/addresses`;
  }

  /** The saved address behind a trip end, with coordinates. Live trips are built only from saved addresses. */
  private async endpoint(place: Trip['pickup'], field: 'pickup' | 'dropoff'): Promise<AddressInfo> {
    const row = place.address_id
      ? (await this.deps.db.query<AddressInfo>(
        'SELECT id, label, line1, district, city, instructions, latitude, longitude, contact_name, contact_phone FROM addresses WHERE id = $1 AND deleted_at IS NULL',
        [place.address_id],
      )).rows[0]
      : undefined;
    if (!row || row.latitude == null || row.longitude == null || place.lat === undefined || place.lng === undefined) {
      throw new DomainError('ADDRESS_REQUIRED', `${field}: Live needs a saved address with exact coordinates`, { field, missing: ['coordinates'], addresses_url: this.addressesUrl() },
        `Ask the user to add the ${field} address at ${this.addressesUrl()} with exact coordinates ("latitude, longitude" copied from a map app) and a contact phone, then set the trip again with that address label.`);
    }
    return row;
  }

  private location(a: AddressInfo, place: Trip['pickup']): ExpressLocation {
    return {
      address: `${a.line1}, ${a.district}, ${a.city}`.slice(0, 500),
      // The approved trip carries the coordinates; the address fingerprint guarantees they match the saved row.
      coordinates: { latitude: fixed6(place.lat!), longitude: fixed6(place.lng!) },
    };
  }

  private contact(a: AddressInfo, role: 'sender' | 'recipient'): ExpressContact {
    if (!a.contact_name || !a.contact_phone) {
      const who = role === 'sender' ? 'sender (pickup)' : 'recipient (drop-off)';
      throw new DomainError('ADDRESS_REQUIRED', `GrabExpress needs a contact name and phone for the ${who}; saved address "${a.label}" has none`,
        { field: role === 'sender' ? 'pickup' : 'dropoff', missing: ['contact_name', 'contact_phone'].filter((k) => !(a as any)[k]), addresses_url: this.addressesUrl() },
        `Ask the user to add "${a.label}" again at ${this.addressesUrl()} with a contact name and phone (international format) for the ${who}, then set the trip again.`);
    }
    return {
      ...splitName(a.contact_name),
      phone: grabPhone(a.contact_phone),
      smsEnabled: role === 'recipient', // sender SMS is not supported by Grab
      instruction: a.instructions?.slice(0, 1000) || undefined,
    };
  }

  private emptyQuote(issues: QuoteIssue[], lines: CartLine[]): ProviderQuote {
    return {
      currency: this.cfg.express.currency,
      lines: lines.map((l) => ({ line_id: l.line_id, item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers_desc: [], unit_price_minor: 0, line_total_minor: 0, available: false })),
      subtotal_minor: 0, delivery_fee_minor: 0, service_fee_minor: 0, small_order_fee_minor: 0, discount_minor: 0, total_minor: 0,
      eta_min_minutes: 0, eta_max_minutes: 0, issues, price_source: 'GrabExpress Delivery Quotes API (live)', valid_for_seconds: QUOTE_TTL_SECONDS,
      payment_method_label: this.paymentLabel(), cancellation_terms: CANCEL_TERMS,
    };
  }

  /** Payment method shown to the user and stored on the checkout; a change invalidates pending confirmations. */
  paymentLabel() {
    return this.payment === 'CASH'
      ? 'Cash: the sender pays the courier at pickup (GrabExpress CASH, payer SENDER)'
      : 'GrabPay: paid in advance in Grab before the courier is booked (GrabExpress CASHLESS, payer SENDER)';
  }

  /** Cashless GrabExpress: the user pays Unyly with GrabPay before the delivery is created. */
  get requiresPrepayment(): boolean {
    return this.cfg.express.enabled && this.payment === 'CASHLESS';
  }

  /** Price one express cart with a live Grab quote; also returns the create-request parts. */
  private async priceExpress(lines: CartLine[], trip: Trip | null | undefined, timeoutMs: number) {
    const issues: QuoteIssue[] = [];
    if (!trip) issues.push({ code: 'TRIP_REQUIRED', message: 'Pickup and drop-off are required' });
    if (lines.length !== 1 || lines[0].quantity !== 1) issues.push({ code: 'MODIFIERS_INVALID', message: 'Choose exactly one vehicle type' });
    const vehicle = lines.length === 1 ? this.vehicleOf(lines[0].item_id) : null;
    if (lines.length === 1 && !vehicle) issues.push({ code: 'ITEM_NOT_FOUND', message: `Vehicle type not found: ${lines[0].name}`, line_id: lines[0].line_id });
    if (trip && !trip.parcel) issues.push({ code: 'TRIP_REQUIRED', message: 'Parcel weight is required' });
    if (issues.length || !trip || !vehicle) return { quote: this.emptyQuote(issues, lines) };

    const [pick, drop] = await Promise.all([this.endpoint(trip.pickup, 'pickup'), this.endpoint(trip.dropoff, 'dropoff')]);
    const sender = this.contact(pick, 'sender');
    const recipient = this.contact(drop, 'recipient');
    const desc = (trip.parcel!.description || 'Parcel').slice(0, 500);
    const packages: ExpressPackage[] = [{ name: desc, description: desc, quantity: 1, dimensions: defaultDimensions(trip.parcel!.weight_kg) }];
    const req: ExpressQuoteRequest = {
      serviceType: this.cfg.express.serviceType, vehicleType: vehicle, packages,
      origin: this.location(pick, trip.pickup), destination: this.location(drop, trip.dropoff), paymentMethod: this.payment,
    };
    let r;
    try {
      r = await this.express.quotes(req, timeoutMs);
    } catch (e) {
      if (e instanceof GrabTransportError) throw new ProviderUnavailableError(e.message);
      throw e;
    }
    const line = lines[0];
    if (!r.ok) {
      if (r.status >= 500 || r.status === 429) throw new ProviderUnavailableError(`GrabExpress quotes: ${grabErrorMessage(r.body, r.status)}`);
      const msg = grabErrorMessage(r.body, r.status);
      return { quote: this.emptyQuote([{ code: issueCode(msg), message: `GrabExpress: ${msg}`, line_id: line.line_id }], lines) };
    }
    const q = r.value.quotes.find((x) => x.service?.type === this.cfg.express.serviceType) ?? r.value.quotes[0];
    if (!q) return { quote: this.emptyQuote([{ code: 'DELIVERY_UNAVAILABLE', message: 'GrabExpress returned no quote for this trip' }], lines) };
    const currency = q.currency.code.toUpperCase();
    if (currency !== this.cfg.express.currency) {
      return { quote: this.emptyQuote([{ code: 'DELIVERY_UNAVAILABLE', message: `GrabExpress quoted in ${currency}, expected ${this.cfg.express.currency} (GRAB_EXPRESS_REGION=${this.cfg.express.region})` }], lines) };
    }
    const fee = toMinor(q.amount, q.currency.exponent ?? exponentOf(currency));
    const nowMs = this.deps.now().getTime();
    const dropAt = q.estimatedTimeline?.dropoff ? Date.parse(q.estimatedTimeline.dropoff) : NaN;
    const etaMin = Number.isFinite(dropAt) ? Math.max(1, Math.round((dropAt - nowMs) / 60000)) : (trip.duration_min ?? 20) + 10;
    const km = q.distance ? Math.round(q.distance / 100) / 10 : trip.distance_km;
    const quote: ProviderQuote = {
      currency,
      lines: [{
        line_id: line.line_id, item_id: line.item_id, name: line.name, quantity: 1,
        modifiers_desc: [`${this.cfg.express.serviceType}${km ? `, ${km} km` : ''}`, `${trip.parcel!.weight_kg} kg`],
        unit_price_minor: fee, line_total_minor: fee, available: true,
      }],
      subtotal_minor: fee, delivery_fee_minor: 0, service_fee_minor: 0, small_order_fee_minor: 0, discount_minor: 0, total_minor: fee,
      // Allocation usually takes 5 to 10 minutes (Grab docs), so the upper bound adds 15.
      eta_min_minutes: etaMin, eta_max_minutes: etaMin + 15,
      issues: [], price_source: 'GrabExpress Delivery Quotes API (live)', valid_for_seconds: QUOTE_TTL_SECONDS,
      payment_method_label: this.paymentLabel(), cancellation_terms: CANCEL_TERMS,
    };
    return { quote, req, sender, recipient };
  }

  async quote(req: { restaurant_id: string; lines: CartLine[]; trip?: Trip | null }): Promise<ProviderQuote> {
    if (req.restaurant_id === RIDE_STORE_ID) throw new CapabilityUnavailableError('submit_order', RIDE_BOOKING_REASON);
    if (req.restaurant_id !== EXPRESS_STORE_ID) return this.notFoodOrMart();
    this.requireExpress();
    return (await this.priceExpress(req.lines, req.trip, this.cfg.timeoutMs)).quote;
  }

  async rideEstimates(trip: Trip): Promise<RideEstimate[]> {
    if (!this.cfg.farefeed.enabled) throw new CapabilityUnavailableError('quote', FAREFEED_OFF);
    const [pick, drop] = await Promise.all([this.endpoint(trip.pickup, 'pickup'), this.endpoint(trip.dropoff, 'dropoff')]);
    const pt = (a: AddressInfo, p: Trip['pickup']) => ({ latitude: fixed6(p.lat!), longitude: fixed6(p.lng!), address: `${a.line1}, ${a.district}, ${a.city}`.slice(0, 500) });
    try {
      return await this.farefeed.estimate(pt(pick, trip.pickup), pt(drop, trip.dropoff));
    } catch (e) {
      if (e instanceof NoRideServiceError) {
        throw new DomainError('OUTSIDE_SERVICE_AREA', 'Grab has no ride service between these points', undefined, 'Tell the user Grab reports no ride service for this trip.');
      }
      throw e;
    }
  }

  // ---------------- Submission ----------------
  private async row(where: 'merchant_order_id' | 'idempotency_key' | 'order_ref' | 'delivery_id', v: string): Promise<DeliveryRow | undefined> {
    return (await this.deps.db.query<DeliveryRow>(`SELECT * FROM grab_deliveries WHERE ${where} = $1`, [v])).rows[0];
  }

  private async setState(mid: string, state: DeliveryRow['state'], detail?: string) {
    await this.deps.db.query('UPDATE grab_deliveries SET state = $2, error_detail = COALESCE($3, error_detail), updated_at = now() WHERE merchant_order_id = $1', [mid, state, detail?.slice(0, 300) ?? null]);
  }

  private paymentStatus(): PaymentStatus {
    return 'pending';
  }

  async submitOrder(req: SubmitRequest): Promise<SubmitResult> {
    if (req.restaurant_id === RIDE_STORE_ID) throw new CapabilityUnavailableError('submit_order', RIDE_BOOKING_REASON);
    if (req.restaurant_id !== EXPRESS_STORE_ID) return this.notFoodOrMart();
    this.requireExpress();
    const deadline = Date.now() + this.deps.submitBudgetMs - 500;
    const remaining = () => deadline - Date.now();
    // merchantOrderID = Unyly's submission id: deterministic per checkout, and carried by Grab's webhooks.
    const sub = (await this.deps.db.query<{ id: string }>('SELECT id FROM submission_attempts WHERE idempotency_key = $1', [req.idempotency_key])).rows[0];
    const mid = sub?.id ?? req.idempotency_key;
    const existing = await this.row('merchant_order_id', mid);
    if (existing?.delivery_id) {
      return { outcome: 'accepted', provider_order_ref: existing.order_ref ?? existing.delivery_id, status: mapGrabStatus(existing.last_status ?? '')?.status ?? 'submitted', payment_status: this.paymentStatus() };
    }
    if (existing && ['sending', 'unknown', 'cancelled_unresolved', 'not_found'].includes(existing.state)) {
      throw new ProviderOutcomeUnknownError('An earlier GrabExpress create for this order has an unknown outcome; it is never sent twice');
    }
    if (existing?.state === 'rejected') return { outcome: 'rejected', code: 'PROVIDER_REJECTED', message: existing.error_detail ?? 'GrabExpress refused the delivery' };

    // Fresh live price for the exact approved cart version: Grab must charge what the human approved.
    let priced;
    try {
      priced = await this.priceExpress(req.lines, req.trip, Math.min(this.cfg.timeoutMs, Math.max(500, Math.floor(remaining() / 2))));
    } catch (e) {
      // Nothing was sent yet: a validation problem (e.g. a contact removed) is a definite rejection.
      if (e instanceof DomainError) return { outcome: 'rejected', code: 'PROVIDER_REJECTED', message: e.message };
      throw e;
    }
    const blocking = priced.quote.issues[0];
    if (blocking) {
      const code = blocking.code === 'DELIVERY_UNAVAILABLE' || blocking.code === 'OUT_OF_STOCK' ? blocking.code : 'PROVIDER_REJECTED';
      return { outcome: 'rejected', code, message: blocking.message };
    }
    if (priced.quote.total_minor !== Number(req.expected_total_minor) || priced.quote.currency !== req.currency) {
      return { outcome: 'rejected', code: 'PRICE_CHANGED', message: `GrabExpress fee is now ${priced.quote.total_minor} ${priced.quote.currency} minor units, approved ${req.expected_total_minor} ${req.currency}` };
    }
    const body: ExpressCreateRequest = {
      ...priced.req!, merchantOrderID: mid, serviceType: this.cfg.express.serviceType, paymentMethod: this.payment, payer: 'SENDER',
      sender: priced.sender!, recipient: priced.recipient!,
    };

    // Persist the intent BEFORE sending: a crash or timeout from here on leaves a row that forbids a resend.
    const claimed = await this.deps.db.query(
      `INSERT INTO grab_deliveries (merchant_order_id, idempotency_key, submission_id, state, currency, payment_method)
       VALUES ($1,$2,$3,'sending',$4,$5)
       ON CONFLICT (merchant_order_id) DO UPDATE SET state = 'sending', updated_at = now() WHERE grab_deliveries.state = 'not_sent'
       RETURNING merchant_order_id`,
      [mid, req.idempotency_key, sub?.id ?? null, priced.quote.currency, this.payment],
    );
    if (!claimed.rowCount) throw new ProviderOutcomeUnknownError('Another GrabExpress create for this order is in progress');
    const budget = remaining();
    if (budget < 1000) {
      await this.setState(mid, 'not_sent', 'no time left before the provider timeout');
      throw new ProviderUnavailableError('Not enough time left to create the GrabExpress delivery; nothing was sent');
    }

    let r;
    try {
      r = await this.express.create(body, Math.min(this.cfg.timeoutMs, budget));
    } catch (e) {
      if (e instanceof GrabTransportError) {
        if (e.failure === 'not_sent') {
          await this.setState(mid, 'not_sent', e.message);
          throw new ProviderUnavailableError(e.message);
        }
        await this.setState(mid, 'unknown', e.message);
        this.deps.log?.({ evt: 'grab_express_unknown', merchant_order_id: mid, reason: e.failure });
        throw new ProviderOutcomeUnknownError(e.message);
      }
      if (e instanceof ProviderUnavailableError) {
        // Token endpoint failure or credentials refused: the create was never processed.
        await this.setState(mid, 'not_sent', e.message);
      }
      throw e;
    }
    if (r.ok) {
      const d = r.value;
      const m = mapGrabStatus(d.status);
      await this.deps.db.query(
        `UPDATE grab_deliveries SET delivery_id = $2, order_ref = COALESCE(order_ref, $2), state = 'created',
           last_status = CASE WHEN $4 >= last_status_rank THEN $3 ELSE last_status END, last_status_rank = GREATEST(last_status_rank, $4), updated_at = now()
         WHERE merchant_order_id = $1`,
        [mid, d.deliveryID, m?.grab_status ?? d.status.slice(0, 40), m?.rank ?? 0],
      );
      const row = await this.row('merchant_order_id', mid);
      const etaAt = d.quote?.estimatedTimeline?.dropoff && Number.isFinite(Date.parse(d.quote.estimatedTimeline.dropoff)) ? new Date(d.quote.estimatedTimeline.dropoff).toISOString() : undefined;
      return { outcome: 'accepted', provider_order_ref: row?.order_ref ?? d.deliveryID, status: m?.status ?? 'submitted', payment_status: this.paymentStatus(), eta_at: etaAt };
    }
    if (r.status === 429) {
      await this.setState(mid, 'not_sent', 'rate limited (429)');
      throw new ProviderUnavailableError('GrabExpress rate limit reached; nothing was sent');
    }
    if (r.status >= 500) {
      // 5xx (or an unreadable success body): Grab may have created the delivery. Never resend.
      await this.setState(mid, 'unknown', `HTTP ${r.status}`);
      throw new ProviderOutcomeUnknownError(`GrabExpress create returned ${r.status}`);
    }
    const msg = grabErrorMessage(r.body, r.status);
    await this.setState(mid, 'rejected', msg);
    return { outcome: 'rejected', code: 'PROVIDER_REJECTED', message: `GrabExpress refused the delivery: ${msg}` };
  }

  /**
   * Reconciliation for an unknown create. GrabExpress has no GET by merchantOrderID, so:
   * 1. deliveryID known (create response or a tracking webhook carrying merchantOrderID) -> accepted.
   * 2. otherwise wait up to GRAB_EXPRESS_UNKNOWN_CANCEL_AFTER_SEC for the webhook (reported as "still checking");
   * 3. then cancel by merchantOrderID: 204 -> a delivery existed and is now cancelled (the order is shown as
   *    cancelled); 404 -> nothing was created; 409 -> it exists and is past pickup: keep waiting for the webhook.
   */
  async lookupByIdempotencyKey(key: string): Promise<LookupResult> {
    const row = await this.row('idempotency_key', key);
    if (!row) return { found: false };
    if (row.delivery_id || row.state === 'cancelled_unresolved') {
      return {
        found: true, provider_order_ref: row.order_ref ?? row.delivery_id!,
        status: mapGrabStatus(row.last_status ?? '')?.status ?? 'submitted', payment_status: this.paymentStatus(),
      };
    }
    if (['rejected', 'not_sent', 'not_found'].includes(row.state)) return { found: false };
    const ageMs = this.deps.now().getTime() - new Date(row.created_at).getTime();
    if (ageMs < this.cfg.express.unknownCancelAfterSec * 1000) {
      throw new ProviderUnavailableError('GrabExpress outcome still unknown; waiting for the tracking webhook');
    }
    let c;
    try {
      c = await this.express.cancelByMerchantOrderId(row.merchant_order_id);
    } catch (e) {
      if (e instanceof GrabTransportError) throw new ProviderUnavailableError(e.message);
      throw e;
    }
    if (c === 'cancelled') {
      const ref = `merchant:${row.merchant_order_id}`;
      const u = await this.deps.db.query(
        `UPDATE grab_deliveries SET state = 'cancelled_unresolved', order_ref = COALESCE(order_ref, $2), last_status = 'CANCELED', last_status_rank = 10,
           error_detail = 'created with unknown outcome; cancelled by merchantOrderID', updated_at = now()
         WHERE merchant_order_id = $1 AND delivery_id IS NULL RETURNING order_ref`,
        [row.merchant_order_id, ref],
      );
      this.deps.log?.({ evt: 'grab_express_unknown_cancelled', merchant_order_id: row.merchant_order_id });
      const fresh = u.rows[0] ? null : await this.row('merchant_order_id', row.merchant_order_id);
      return { found: true, provider_order_ref: u.rows[0]?.order_ref ?? fresh?.order_ref ?? ref, status: 'cancelled', payment_status: 'unknown' };
    }
    if (c === 'not_found') {
      await this.deps.db.query(`UPDATE grab_deliveries SET state = 'not_found', updated_at = now() WHERE merchant_order_id = $1 AND delivery_id IS NULL`, [row.merchant_order_id]);
      return { found: false };
    }
    if (c === 'conflict') {
      this.deps.log?.({ evt: 'grab_express_unknown_not_cancellable', merchant_order_id: row.merchant_order_id });
      throw new ProviderUnavailableError('A GrabExpress delivery exists for this order but can no longer be cancelled; waiting for its tracking webhook');
    }
    throw new ProviderUnavailableError(`GrabExpress cancel by merchantOrderID returned ${c.status}`);
  }

  // ---------------- Tracking and cancellation ----------------
  private async details(ref: string) {
    if (ref.startsWith('merchant:')) return null;
    let r;
    try {
      r = await this.express.get(ref);
    } catch (e) {
      if (e instanceof GrabTransportError) throw new ProviderUnavailableError(e.message);
      throw e;
    }
    if (!r.ok) {
      if (r.status === 404) throw Object.assign(new Error('delivery not found'), { notFound: true });
      throw new ProviderUnavailableError(`GrabExpress details: ${grabErrorMessage(r.body, r.status)}`);
    }
    const m = mapGrabStatus(r.value.status);
    if (m) {
      await this.deps.db.query(
        `UPDATE grab_deliveries SET last_status = $2, last_status_rank = $3, updated_at = now() WHERE delivery_id = $1 AND last_status_rank <= $3`,
        [ref, m.grab_status, m.rank],
      );
    }
    return { delivery: r.value, mapped: m };
  }

  async getOrderStatus(ref: string): Promise<ProviderOrderStatus> {
    this.requireExpress();
    const d = await this.details(ref);
    if (!d) return { provider_order_ref: ref, status: 'cancelled', payment_status: 'unknown', sequence: 10 };
    const row = await this.row('delivery_id', ref);
    const status: FulfillmentStatus = d.mapped?.status ?? mapGrabStatus(row?.last_status ?? '')?.status ?? 'submitted';
    const etaRaw = d.delivery.quote?.estimatedTimeline?.dropoff;
    return {
      provider_order_ref: ref, status, payment_status: this.paymentStatus(), sequence: d.mapped?.rank ?? row?.last_status_rank ?? 0,
      eta_at: etaRaw && Number.isFinite(Date.parse(etaRaw)) ? new Date(etaRaw).toISOString() : undefined,
    };
  }

  async getCancellationTerms(ref: string): Promise<CancellationTerms> {
    this.requireExpress();
    const row = (await this.row('order_ref', ref)) ?? (await this.row('delivery_id', ref));
    const currency = row?.currency ?? this.cfg.express.currency;
    const d = await this.details(ref);
    const raw = d?.mapped?.grab_status ?? 'CANCELED';
    if (CANCELLABLE.has(raw)) return { allowed: true, fee_minor: 0, currency, terms: `Free cancellation: the parcel has not been picked up yet (GrabExpress status ${raw}; Grab charges no cancellation fee).` };
    return { allowed: false, fee_minor: 0, currency, terms: `Cannot cancel: GrabExpress status is ${raw}. Cancellation is only possible before the courier picks up the parcel.` };
  }

  async cancelOrder(ref: string, _key: string, maxFeeMinor: number): Promise<CancelResult> {
    this.requireExpress();
    const row = (await this.row('order_ref', ref)) ?? (await this.row('delivery_id', ref));
    if (row && mapGrabStatus(row.last_status ?? '')?.status === 'cancelled') return { outcome: 'cancelled', fee_minor: 0 };
    if (maxFeeMinor < 0) return { outcome: 'rejected', message: 'FEE_CHANGED: invalid fee cap' };
    if (ref.startsWith('merchant:')) return { outcome: 'rejected', message: 'Already cancelled.' };
    let c;
    try {
      c = await this.express.cancel(ref);
    } catch (e) {
      if (e instanceof GrabTransportError) {
        if (e.failure === 'not_sent') throw new ProviderUnavailableError(e.message);
        throw new ProviderOutcomeUnknownError(e.message);
      }
      throw e;
    }
    if (c === 'cancelled') {
      await this.deps.db.query(`UPDATE grab_deliveries SET last_status = 'CANCELED', last_status_rank = 10, updated_at = now() WHERE delivery_id = $1`, [ref]);
      return { outcome: 'cancelled', fee_minor: 0 };
    }
    if (c === 'conflict') return { outcome: 'rejected', message: 'GrabExpress refused the cancellation: the parcel has been picked up or the delivery has ended.' };
    if (c === 'not_found') return { outcome: 'rejected', message: 'GrabExpress does not know this delivery.' };
    if (c.status === 429) throw new ProviderUnavailableError('GrabExpress rate limit reached');
    throw new ProviderOutcomeUnknownError(`GrabExpress cancel returned ${c.status}`);
  }

  verifyWebhook(): ProviderEvent[] {
    throw new Error('GrabExpress tracking webhooks are received on POST /webhooks/grab-express');
  }
}

const CANCEL_TERMS =
  'GrabExpress: free cancellation until the courier picks up the parcel (Grab charges no cancellation fee). Not possible once the parcel is picked up.';

/** Grab business error message -> quote issue code. */
function issueCode(msg: string): QuoteIssue['code'] {
  const m = msg.toLowerCase();
  if (/weight|size/.test(m)) return 'WEIGHT_LIMIT';
  if (/distance|city|multi-city|not supported|eta sla/.test(m)) return 'OUTSIDE_SERVICE_AREA';
  return 'DELIVERY_UNAVAILABLE';
}
