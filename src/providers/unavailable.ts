import { regionOf, Service } from '../domain/regions.js';
import {
  CapabilityKey, Capability, CapabilityUnavailableError, Mode, Provider, ProviderEvent,
} from './types.js';

const CHECKED = '2026-09-30';

/** Shared base: every operation is unavailable unless a subclass overrides it. */
abstract class UnavailableBase implements Provider {
  abstract readonly mode: Mode;
  readonly providerName = 'grab';
  abstract capabilities(): Record<CapabilityKey, Capability>;
  protected fail(cap: CapabilityKey): never {
    throw new CapabilityUnavailableError(cap, this.capabilities()[cap].reason || 'Not available');
  }
  async searchRestaurants(): Promise<never> { return this.fail('search_restaurants'); }
  async getMenu(): Promise<never> { return this.fail('get_menu'); }
  async quote(): Promise<never> { return this.fail('quote'); }
  async submitOrder(): Promise<never> { return this.fail('submit_order'); }
  async lookupByIdempotencyKey(): Promise<never> { return this.fail('order_status'); }
  async getOrderStatus(): Promise<never> { return this.fail('order_status'); }
  async getCancellationTerms(): Promise<never> { return this.fail('cancel_order'); }
  async cancelOrder(): Promise<never> { return this.fail('cancel_order'); }
  verifyWebhook(): ProviderEvent[] { throw new Error('webhooks not supported'); }
}

const NO_CONSUMER_API =
  'Grab does not publish an API for third parties to order GrabFood or GrabMart, or book a ride, on behalf of a consumer. ' +
  'The public Food and Mart APIs are merchant/POS APIs. GrabExpress has a business Delivery API (credentials via Grab sales), not a consumer one. ' +
  'Requires a partner agreement with Grab.';
const SRC = 'https://developer.grab.com/docs/grabfood/api/v1-1-3/ ; https://developer.grab.com/docs/grab-express/ ; https://developer.grab.com/docs/grab-id/';

/**
 * Live mode: real operations against Grab. No capability is enabled because none is
 * documented for consumer ordering (checked 2026-09-30). When Grab grants access, implement
 * the methods here and flip capabilities one by one after contract tests pass.
 */
export class LiveGrabProvider extends UnavailableBase {
  readonly mode = 'live' as const;
  capabilities(): Record<CapabilityKey, Capability> {
    const off: Capability = { available: false, reason: NO_CONSUMER_API, source: SRC, verified_at: CHECKED };
    return {
      search_restaurants: off, get_menu: off, cart: off, quote: off, checkout: off, submit_order: off,
      order_status: off, cancel_order: off, handoff: { available: false, reason: 'Use Handoff mode.' },
    };
  }
}

export const GRABFOOD_TH_URL = 'https://food.grab.com/th/en/';

/**
 * Handoff mode: Unyly prepares a checklist the user completes in Grab. There is no licensed data
 * source for Grab restaurants/menus/prices, so search, menu and quote are unavailable; the cart
 * holds free-text items the user dictates. Opening the link does NOT create an order.
 */
export class HandoffGrabProvider extends UnavailableBase {
  readonly mode = 'handoff' as const;
  capabilities(): Record<CapabilityKey, Capability> {
    const noData: Capability = {
      available: false, verified_at: CHECKED, source: SRC,
      reason: 'No documented Grab API for consumer store, menu, fare or price data, and Grab terms prohibit scraping. Tell Unyly the store and items, or the pickup and drop-off, yourself.',
    };
    const inGrab: Capability = { available: false, verified_at: CHECKED, reason: 'In Handoff mode the order, payment, status and cancellation happen inside Grab, not in Unyly.' };
    return {
      search_restaurants: noData, get_menu: noData, quote: { ...noData, reason: 'Prices, fees and availability are only shown inside Grab.' },
      cart: { available: true, source: 'User-provided items (free text)' },
      checkout: inGrab, submit_order: inGrab, order_status: inGrab, cancel_order: inGrab,
      handoff: {
        available: true, verified_at: CHECKED,
        source: 'Official Grab service pages per country (Thailand checked page by page). Store-level, trip or cart-prefill links are not documented, so none are used.',
      },
    };
  }
  handoffUrl(region: string, service: Service) {
    const link = regionOf(region).links[service];
    return { url: link.url, source: link.note, verified: link.verified, verified_at: link.checked_at };
  }
}
