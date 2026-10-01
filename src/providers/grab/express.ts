// Typed client for the GrabExpress Delivery API (docs/grab-api-research.md, section 1).
// Field names, paths and enums are copied from Grab's public documentation.
import { z } from 'zod';
import type { FulfillmentStatus } from '../types.js';
import type { GrabConfig } from './config.js';
import type { GrabHttp, GrabResponse } from './http.js';
import { SCOPE_EXPRESS } from './token.js';

// ---------------- Request shapes ----------------
export interface ExpressLocation {
  address: string;
  keywords?: string;
  coordinates: { latitude: number; longitude: number };
}
export interface ExpressPackage {
  name: string;
  description: string;
  quantity: number;
  price?: number;
  dimensions: { height: number; width: number; depth: number; weight: number };
}
export interface ExpressQuoteRequest {
  serviceType?: string;
  vehicleType?: string;
  packages: ExpressPackage[];
  origin: ExpressLocation;
  destination: ExpressLocation;
  paymentMethod?: 'CASH' | 'CASHLESS';
}
export interface ExpressContact {
  firstName: string;
  lastName?: string;
  phone: string;
  smsEnabled: boolean;
  instruction?: string;
}
export interface ExpressCreateRequest extends ExpressQuoteRequest {
  merchantOrderID: string;
  serviceType: string;
  paymentMethod: 'CASH' | 'CASHLESS';
  payer: 'SENDER' | 'RECIPIENT';
  sender: ExpressContact;
  recipient: ExpressContact;
}

// ---------------- Response shapes (lenient: unknown fields are ignored) ----------------
const Currency = z.object({ code: z.string(), symbol: z.string().optional(), exponent: z.coerce.number().int().min(0).max(4).optional() }).passthrough();
const Quote = z
  .object({
    service: z.object({ id: z.any().optional(), type: z.string().optional(), name: z.string().optional() }).passthrough().optional(),
    currency: Currency,
    amount: z.coerce.number(),
    estimatedTimeline: z.object({ pickup: z.string().nullish(), dropoff: z.string().nullish() }).passthrough().nullish(),
    distance: z.coerce.number().nullish(),
  })
  .passthrough();
export type ExpressQuote = z.infer<typeof Quote>;
export const QuotesResponse = z.object({ quotes: z.array(Quote) }).passthrough();
export const DeliveryResponse = z
  .object({
    deliveryID: z.string().min(1).max(128),
    merchantOrderID: z.string().nullish(),
    status: z.string(),
    quote: Quote.nullish(),
    trackingURL: z.string().nullish(),
    paymentMethod: z.string().nullish(),
    advanceInfo: z.object({ failedReason: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();
export type ExpressDelivery = z.infer<typeof DeliveryResponse>;

// ---------------- Status mapping ----------------
/**
 * Grab status -> Unyly fulfillment status plus a monotonic rank used as the event sequence (later
 * states have a higher rank, so a late webhook can never move an order backwards). The raw Grab
 * status is kept next to the order in grab_deliveries.last_status.
 */
const STATUS: Record<string, { status: FulfillmentStatus; rank: number }> = {
  QUEUEING: { status: 'submitted', rank: 1 },
  ALLOCATING: { status: 'submitted', rank: 2 },
  PENDING_PICKUP: { status: 'accepted', rank: 3 },
  PICKING_UP: { status: 'preparing', rank: 4 },
  PENDING_DROP_OFF: { status: 'picked_up', rank: 5 },
  IN_DELIVERY: { status: 'picked_up', rank: 6 },
  IN_RETURN: { status: 'picked_up', rank: 7 },
  COMPLETED: { status: 'delivered', rank: 10 },
  RETURNED: { status: 'failed', rank: 10 },
  CANCELED: { status: 'cancelled', rank: 10 },
  CANCELLED: { status: 'cancelled', rank: 10 }, // webhook spelling
  FAILED: { status: 'failed', rank: 10 },
};
export const KNOWN_GRAB_STATUSES = Object.keys(STATUS);

export function mapGrabStatus(raw: string): { status: FulfillmentStatus; rank: number; grab_status: string } | null {
  const k = raw.trim().toUpperCase();
  const m = STATUS[k];
  return m ? { ...m, grab_status: k } : null;
}

/** Cancellation is allowed only in these states (docs 1.4 / 1.5). No fee is documented. */
export const CANCELLABLE = new Set(['QUEUEING', 'ALLOCATING', 'PENDING_PICKUP', 'PICKING_UP']);

/** float64 amount in major units -> integer minor units, using Grab's exponent when given. */
export function toMinor(amount: number, exponent: number) {
  return Math.round(amount * 10 ** exponent);
}

export type ExpressResult<T> = { ok: true; value: T; requestId?: string } | { ok: false; status: number; body: any; requestId?: string };

export class GrabExpressClient {
  constructor(private http: GrabHttp, private cfg: GrabConfig) {}

  private call(op: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<GrabResponse> {
    return this.http.request({ op, method, url: `${this.cfg.express.baseUrl}${path}`, body, creds: this.cfg.express.creds!, scope: SCOPE_EXPRESS, timeoutMs });
  }

  private parse<T>(r: GrabResponse, schema: z.ZodType<T>, okStatuses = [200, 201]): ExpressResult<T> {
    if (!okStatuses.includes(r.status)) return { ok: false, status: r.status, body: r.body, requestId: r.requestId };
    const p = schema.safeParse(r.body);
    if (!p.success) return { ok: false, status: 502, body: { message: 'Malformed response from Grab' }, requestId: r.requestId };
    return { ok: true, value: p.data, requestId: r.requestId };
  }

  async quotes(req: ExpressQuoteRequest, timeoutMs?: number) {
    return this.parse(await this.call('express.quotes', 'POST', '/v1/deliveries/quotes', req, timeoutMs), QuotesResponse);
  }

  async create(req: ExpressCreateRequest, timeoutMs?: number) {
    return this.parse(await this.call('express.create', 'POST', '/v1/deliveries', req, timeoutMs), DeliveryResponse);
  }

  async get(deliveryId: string) {
    return this.parse(await this.call('express.get', 'GET', `/v1/deliveries/${encodeURIComponent(deliveryId)}`), DeliveryResponse);
  }

  /** 204 cancelled, 404 unknown order, 409 cannot cancel (already picked up). */
  async cancel(deliveryId: string): Promise<'cancelled' | 'not_found' | 'conflict' | { status: number; body: any }> {
    const r = await this.call('express.cancel', 'DELETE', `/v1/deliveries/${encodeURIComponent(deliveryId)}`);
    return cancelOutcome(r);
  }

  /** Cancels every delivery of this merchantOrderID, only if all are still before pickup. */
  async cancelByMerchantOrderId(merchantOrderId: string): Promise<'cancelled' | 'not_found' | 'conflict' | { status: number; body: any }> {
    const r = await this.call('express.cancel_by_merchant', 'DELETE', `/v1/merchant/deliveries/${encodeURIComponent(merchantOrderId)}`);
    return cancelOutcome(r);
  }
}

function cancelOutcome(r: GrabResponse) {
  if (r.status === 204 || r.status === 200) return 'cancelled' as const;
  if (r.status === 404) return 'not_found' as const;
  if (r.status === 409) return 'conflict' as const;
  return { status: r.status, body: r.body };
}
