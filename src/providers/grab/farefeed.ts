// Partner Farefeed API: ride fare ranges, pickup ETA and deep links into the Grab app
// (docs/grab-api-research.md, section 2). It does not book rides: booking happens in the Grab app.
import { z } from 'zod';
import { exponentOf } from '../../domain/money.js';
import { ProviderUnavailableError, type RideEstimate } from '../types.js';
import type { GrabConfig } from './config.js';
import { GrabTransportError, grabErrorMessage, type GrabHttp } from './http.js';
import { SCOPE_FAREFEED } from './token.js';

export interface FarefeedPoint {
  latitude: number;
  longitude: number;
  address: string;
}

const Service = z
  .object({
    serviceID: z.coerce.number().int(),
    serviceName: z.string().min(1).max(120),
    eta: z.coerce.number().nullish(),
    fare: z.object({ currency: z.string().min(3).max(3), minFare: z.coerce.number(), maxFare: z.coerce.number() }).passthrough(),
    deepLink: z.string().nullish(),
    directDeepLink: z.string().nullish(),
    iconLink: z.string().nullish(),
    surgeNotice: z.string().nullish(),
  })
  .passthrough();
export const EstimateResponse = z.object({ services: z.array(Service) }).passthrough();

export const SURGE_NOTICES = ['NONE', 'LOW_SURGE', 'HIGH_SURGE', 'FRACTIONAL_SURGE'] as const;

/** Only https links to Grab hosts, or the grab:// app scheme, are passed on to assistants. */
function safeLink(v: string | null | undefined, scheme: 'https' | 'grab'): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (scheme === 'grab') return u.protocol === 'grab:' ? v : undefined;
    if (u.protocol !== 'https:') return undefined;
    return /(^|\.)grab\.(com|onelink\.me)$|(^|\.)onelink\.me$/i.test(u.hostname) ? v : undefined;
  } catch {
    return undefined;
  }
}

export class NoRideServiceError extends Error {}

export class GrabFarefeedClient {
  constructor(private http: GrabHttp, private cfg: GrabConfig) {}

  /** Throws ProviderUnavailableError when Grab is unreachable; NoRideServiceError for 404 (no service there). */
  async estimate(pickUp: FarefeedPoint, dropOff: FarefeedPoint): Promise<RideEstimate[]> {
    let r;
    try {
      r = await this.http.request({
        op: 'farefeed.estimate', method: 'POST', url: `${this.cfg.farefeed.baseUrl}/farefeed/v1/estimate`,
        body: { pickUp, dropOff }, creds: this.cfg.farefeed.creds!, scope: SCOPE_FAREFEED,
      });
    } catch (e) {
      if (e instanceof GrabTransportError) throw new ProviderUnavailableError(e.message);
      throw e;
    }
    if (r.status === 404) throw new NoRideServiceError('Grab has no ride service at these coordinates');
    if (r.status !== 200) throw new ProviderUnavailableError(`Grab Farefeed: ${grabErrorMessage(r.body, r.status)}`);
    const p = EstimateResponse.safeParse(r.body);
    if (!p.success) throw new ProviderUnavailableError('Grab Farefeed: malformed response');
    return p.data.services.map((s) => {
      const cur = s.fare.currency.toUpperCase();
      const exp = exponentOf(cur);
      const surge = (s.surgeNotice ?? 'NONE').toUpperCase();
      return {
        service_id: s.serviceID,
        name: s.serviceName,
        currency: cur,
        min_fare_minor: Math.round(s.fare.minFare * 10 ** exp),
        max_fare_minor: Math.round(s.fare.maxFare * 10 ** exp),
        eta_minutes: s.eta ?? null,
        surge: (SURGE_NOTICES as readonly string[]).includes(surge) ? surge : 'UNKNOWN',
        deep_link: safeLink(s.deepLink, 'https'),
        direct_deep_link: safeLink(s.directDeepLink, 'grab'),
      };
    });
  }
}
