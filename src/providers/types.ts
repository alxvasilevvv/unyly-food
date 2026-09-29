// Provider abstraction. Unyly's business logic only talks to this interface.
// NOTE: these are Unyly's internal operations. They do NOT imply that a Grab API with
// the same shape exists. See docs/feasibility.md.

export type Mode = 'demo' | 'handoff' | 'live';
export const MODES: Mode[] = ['demo', 'handoff', 'live'];

export type CapabilityKey =
  | 'search_restaurants'
  | 'get_menu'
  | 'cart'
  | 'quote'
  | 'checkout'
  | 'submit_order'
  | 'order_status'
  | 'cancel_order'
  | 'handoff';

export interface Capability {
  available: boolean;
  reason?: string;
  source?: string;
  verified_at?: string;
}

export type FulfillmentStatus = 'submitted' | 'accepted' | 'preparing' | 'picked_up' | 'delivered' | 'cancelled' | 'failed';
export const STATUS_RANK: Record<FulfillmentStatus, number> = {
  submitted: 0,
  accepted: 1,
  preparing: 2,
  picked_up: 3,
  delivered: 4,
  cancelled: 4,
  failed: 4,
};
export const TERMINAL: FulfillmentStatus[] = ['delivered', 'cancelled', 'failed'];

export type PaymentStatus = 'not_charged_demo' | 'pending' | 'authorized' | 'captured' | 'refunded' | 'paid_in_grab' | 'unknown';

export interface DeliveryAddress {
  fingerprint: string;
  label: string;
  line1: string;
  district: string;
  city: string;
  country: string;
  instructions?: string | null;
}

export interface ModifierOption {
  id: string;
  name: string;
  price_delta_minor: number;
  available: boolean;
}
export interface ModifierGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  options: ModifierOption[];
}
export interface AllergenInfo {
  /** 'declared_by_restaurant' means the restaurant supplied a list; 'not_provided' means unknown. */
  status: 'declared_by_restaurant' | 'not_provided';
  declared: string[];
}
export interface MenuItem {
  id: string;
  name: string;
  description: string;
  category: string;
  price_minor: number;
  available: boolean;
  modifier_groups: ModifierGroup[];
  allergen_info: AllergenInfo;
  dietary_tags_declared: string[];
}
export interface Restaurant {
  id: string;
  name: string;
  cuisines: string[];
  is_open: boolean;
  opening_note?: string;
  currency: string;
  delivery_fee_minor: number;
  min_order_minor: number;
  small_order_threshold_minor: number;
  small_order_fee_minor: number;
  eta_min_minutes: number;
  eta_max_minutes: number;
  delivers_to_address: boolean | null;
  promo?: string;
}

export interface SelectedModifier {
  group_id: string;
  option_ids: string[];
}
export interface CartLine {
  line_id: string;
  item_id?: string;
  name: string;
  quantity: number;
  modifiers: SelectedModifier[];
  note?: string;
}

export interface QuoteIssue {
  code: 'OUT_OF_STOCK' | 'RESTAURANT_CLOSED' | 'MINIMUM_ORDER_NOT_MET' | 'DELIVERY_UNAVAILABLE' | 'ITEM_NOT_FOUND' | 'MODIFIERS_INVALID';
  message: string;
  line_id?: string;
}
export interface QuoteLine {
  line_id: string;
  item_id?: string;
  name: string;
  quantity: number;
  modifiers_desc: string[];
  unit_price_minor: number;
  line_total_minor: number;
  available: boolean;
}
export interface ProviderQuote {
  currency: string;
  lines: QuoteLine[];
  subtotal_minor: number;
  delivery_fee_minor: number;
  service_fee_minor: number;
  small_order_fee_minor: number;
  discount_minor: number;
  total_minor: number;
  eta_min_minutes: number;
  eta_max_minutes: number;
  issues: QuoteIssue[];
  price_source: string;
  valid_for_seconds: number;
  payment_method_label: string;
  cancellation_terms: string;
}

export interface SubmitRequest {
  idempotency_key: string;
  restaurant_id: string;
  lines: CartLine[];
  address: DeliveryAddress;
  expected_total_minor: number;
  currency: string;
}
export type SubmitResult =
  | { outcome: 'accepted'; provider_order_ref: string; status: FulfillmentStatus; payment_status: PaymentStatus; eta_at?: string }
  | { outcome: 'rejected'; code: 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'RESTAURANT_CLOSED' | 'DELIVERY_UNAVAILABLE' | 'PROVIDER_REJECTED'; message: string };

export type LookupResult = { found: true; provider_order_ref: string; status: FulfillmentStatus; payment_status: PaymentStatus } | { found: false };

export interface ProviderOrderStatus {
  provider_order_ref: string;
  status: FulfillmentStatus;
  payment_status: PaymentStatus;
  sequence: number;
  eta_at?: string;
}

export interface CancellationTerms {
  allowed: boolean;
  fee_minor: number;
  currency: string;
  terms: string;
}
export type CancelResult = { outcome: 'cancelled'; fee_minor: number } | { outcome: 'rejected'; message: string };

export interface ProviderEvent {
  event_id: string;
  order_ref: string;
  sequence: number;
  type: 'order.status_changed';
  status: FulfillmentStatus;
  payment_status: PaymentStatus;
  occurred_at: string;
  eta_at?: string;
}

/** The request may or may not have reached the provider. Never blindly retry a submit. */
export class ProviderOutcomeUnknownError extends Error {
  readonly kind = 'unknown';
}
/** The provider could not be reached and the request was definitely not processed. */
export class ProviderUnavailableError extends Error {
  readonly kind = 'unavailable';
}
export class CapabilityUnavailableError extends Error {
  constructor(readonly capability: CapabilityKey, readonly reason: string) {
    super(reason);
  }
}

export interface Provider {
  readonly mode: Mode;
  readonly providerName: string;
  capabilities(): Record<CapabilityKey, Capability>;
  searchRestaurants(q: { address: DeliveryAddress | null; query?: string; cuisine?: string }): Promise<Restaurant[]>;
  getMenu(restaurantId: string, address: DeliveryAddress | null): Promise<{ restaurant: Restaurant; items: MenuItem[] }>;
  quote(req: { restaurant_id: string; lines: CartLine[]; address: DeliveryAddress }): Promise<ProviderQuote>;
  submitOrder(req: SubmitRequest): Promise<SubmitResult>;
  lookupByIdempotencyKey(key: string): Promise<LookupResult>;
  getOrderStatus(ref: string): Promise<ProviderOrderStatus>;
  getCancellationTerms(ref: string): Promise<CancellationTerms>;
  /** Must be idempotent per key and must refuse if the current fee exceeds maxFeeMinor (what the user approved). */
  cancelOrder(ref: string, idempotencyKey: string, maxFeeMinor: number): Promise<CancelResult>;
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent[];
  handoffUrl?(region: string): { url: string; source: string; verified_at: string } | null;
}
