// Grab partner API configuration (GrabExpress and Partner Farefeed). Every value comes from the
// environment; see .env.example and docs/operations.md. Secrets are kept here only to be sent to Grab;
// they are never logged (see redactGrabConfig).
//
// Hosts follow docs/grab-api-research.md (read 2026-10-01):
// - Gateway: production https://partner-api.grab.com, staging https://partner-api.stg-myteksi.com.
// - GrabExpress: production {prod gateway}/grab-express, sandbox {prod gateway}/grab-express-sandbox,
//   token always POST {prod gateway}/grabid/v1/oauth2/token.
// - Farefeed: POST {gateway}/farefeed/v1/estimate, staging gateway in sandbox, token on the same gateway.

import { REGION_CODES, REGIONS } from '../../domain/regions.js';

export type GrabEnv = 'sandbox' | 'production';
export type ExpressPayment = 'cash' | 'cashless';

export const GRAB_PROD_GATEWAY = 'https://partner-api.grab.com';
export const GRAB_STAGING_GATEWAY = 'https://partner-api.stg-myteksi.com';
export const EXPRESS_SERVICE_TYPES = ['INSTANT', 'SAME_DAY', 'BULK'] as const;
export const EXPRESS_VEHICLE_TYPES = [
  'BIKE', 'CAR', 'JUSTEXPRESS', 'VAN', 'TRUCK', 'TRIKE', 'EBIKE', 'SUV', 'BOXPICKUPTRUCK', 'TRICYCLE', 'CYCLE', 'FOOT',
] as const;

export interface GrabCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface GrabConfig {
  env: GrabEnv;
  express: {
    enabled: boolean;
    /** Base URL the documented paths (/v1/deliveries...) are appended to. */
    baseUrl: string;
    creds: GrabCredentials | null;
    serviceType: (typeof EXPRESS_SERVICE_TYPES)[number];
    /**
     * cash: paymentMethod CASH, payer SENDER (the sender pays the courier). cashless: CASHLESS, payer SENDER,
     * Grab bills Unyly, so the user pays Unyly with GrabPay before the delivery is created (needs GRABPAY=on).
     */
    payment: ExpressPayment;
    /** Grab market the GrabExpress account belongs to (GRAB_EXPRESS_REGION, default TH). */
    region: string;
    /** Currency of that market: quotes in another currency are refused, GrabPay must use the same one. */
    currency: string;
    /** Vehicle types offered to the user, in this order (must match the Grab agreement). */
    vehicles: string[];
    /** Shared secret Grab sends in the Authorization header of tracking webhooks. */
    webhookAuth: string | null;
    webhookAuthId: string | null;
    /** How long a create with an unknown outcome waits for the tracking webhook before cancel-by-merchantOrderID. */
    unknownCancelAfterSec: number;
  };
  farefeed: {
    enabled: boolean;
    baseUrl: string;
    creds: GrabCredentials | null;
  };
  /** Per-request timeout for calls to Grab. */
  timeoutMs: number;
  /** Client-side request rate limit (requests per second) per API family. Sandbox allows 5 rps. */
  rps: number;
}

type Env = Record<string, string | undefined>;

function onOff(env: Env, name: string, d: boolean): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (v === '') return d;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be on or off, got "${env[name]}"`);
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], d: T, upper = false): T {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return d;
  const v = (upper ? raw.toUpperCase() : raw.toLowerCase()) as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  return v;
}

function int(env: Env, name: string, d: number, min: number, max: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return d;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  return n;
}

/** https only, except plain http to a loopback host (the test mock server). */
function baseUrl(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${raw}"`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`${name} must be https (Grab drops plain HTTP)`);
  return raw.replace(/\/+$/, '');
}

export function loadGrabConfig(env: Env = process.env): GrabConfig {
  const grabEnv = oneOf<GrabEnv>(env, 'GRAB_ENV', ['sandbox', 'production'], 'sandbox');
  const override = env.GRAB_API_BASE?.trim() ? baseUrl('GRAB_API_BASE', env.GRAB_API_BASE.trim()) : null;
  const prodGateway = override ?? GRAB_PROD_GATEWAY;
  const ffGateway = override ?? (grabEnv === 'production' ? GRAB_PROD_GATEWAY : GRAB_STAGING_GATEWAY);
  const clientId = env.GRAB_CLIENT_ID?.trim() || '';
  const clientSecret = env.GRAB_CLIENT_SECRET?.trim() || '';
  const ffId = env.GRAB_FAREFEED_CLIENT_ID?.trim() || clientId;
  const ffSecret = env.GRAB_FAREFEED_CLIENT_SECRET?.trim() || clientSecret;
  const vehicles = (env.GRAB_EXPRESS_VEHICLES?.trim() || 'BIKE,CAR,VAN')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  for (const v of vehicles) {
    if (!(EXPRESS_VEHICLE_TYPES as readonly string[]).includes(v)) throw new Error(`GRAB_EXPRESS_VEHICLES: unknown vehicle type "${v}"`);
  }
  const region = oneOf(env, 'GRAB_EXPRESS_REGION', REGION_CODES, 'TH', true);
  const cfg: GrabConfig = {
    env: grabEnv,
    express: {
      enabled: onOff(env, 'GRAB_EXPRESS', false),
      baseUrl: `${prodGateway}/${grabEnv === 'production' ? 'grab-express' : 'grab-express-sandbox'}`,
      creds: clientId && clientSecret ? { tokenUrl: `${prodGateway}/grabid/v1/oauth2/token`, clientId, clientSecret } : null,
      serviceType: oneOf(env, 'GRAB_EXPRESS_SERVICE_TYPE', EXPRESS_SERVICE_TYPES, 'INSTANT', true),
      payment: oneOf<ExpressPayment>(env, 'GRAB_EXPRESS_PAYMENT', ['cash', 'cashless'], 'cash'),
      region,
      currency: REGIONS[region].currency,
      vehicles: [...new Set(vehicles)],
      webhookAuth: env.GRAB_EXPRESS_WEBHOOK_AUTH?.trim() || null,
      webhookAuthId: env.GRAB_EXPRESS_WEBHOOK_AUTH_ID?.trim() || null,
      unknownCancelAfterSec: int(env, 'GRAB_EXPRESS_UNKNOWN_CANCEL_AFTER_SEC', 600, 60, 24 * 3600),
    },
    farefeed: {
      enabled: onOff(env, 'GRAB_FAREFEED', false),
      baseUrl: ffGateway,
      creds: ffId && ffSecret ? { tokenUrl: `${ffGateway}/grabid/v1/oauth2/token`, clientId: ffId, clientSecret: ffSecret } : null,
    },
    timeoutMs: int(env, 'GRAB_HTTP_TIMEOUT_MS', 8000, 500, 60_000),
    rps: int(env, 'GRAB_RPS', grabEnv === 'production' ? 30 : 5, 1, 300),
  };
  validateGrabConfig(cfg);
  return cfg;
}

/** A feature that is on must have everything it needs: startup fails instead of silently disabling it. */
export function validateGrabConfig(cfg: GrabConfig) {
  if (cfg.express.enabled) {
    if (!cfg.express.creds) throw new Error('GRAB_EXPRESS=on requires GRAB_CLIENT_ID and GRAB_CLIENT_SECRET');
    const s = cfg.express.webhookAuth ?? '';
    if (s.length < 32 || /change[_-]?me/i.test(s)) {
      throw new Error('GRAB_EXPRESS=on requires GRAB_EXPRESS_WEBHOOK_AUTH: a random secret of at least 32 characters (openssl rand -hex 32)');
    }
    if (!cfg.express.vehicles.length) throw new Error('GRAB_EXPRESS_VEHICLES must list at least one vehicle type');
    if (REGIONS[cfg.express.region]?.currency !== cfg.express.currency) throw new Error('GRAB_EXPRESS_REGION and the GrabExpress currency do not match');
  }
  if (cfg.farefeed.enabled && !cfg.farefeed.creds) {
    throw new Error('GRAB_FAREFEED=on requires GRAB_CLIENT_ID and GRAB_CLIENT_SECRET (or GRAB_FAREFEED_CLIENT_ID / GRAB_FAREFEED_CLIENT_SECRET)');
  }
}

/** Safe to log: no secrets. */
export function redactGrabConfig(cfg: GrabConfig) {
  return {
    env: cfg.env,
    express: { enabled: cfg.express.enabled, baseUrl: cfg.express.baseUrl, serviceType: cfg.express.serviceType, payment: cfg.express.payment, region: cfg.express.region, vehicles: cfg.express.vehicles },
    farefeed: { enabled: cfg.farefeed.enabled, baseUrl: cfg.farefeed.baseUrl },
  };
}

/**
 * Cashless GrabExpress is billed to Unyly, so the user must pay first with GrabPay. Checked at startup
 * together with the GrabPay configuration: an incomplete combination stops the server instead of
 * silently creating deliveries nobody paid for, or falling back to cash.
 */
export function validateExpressPayment(grab: GrabConfig, grabpay: { enabled: boolean; currency: string }) {
  if (!grab.express.enabled || grab.express.payment !== 'cashless') return;
  if (!grabpay.enabled) {
    throw new Error('GRAB_EXPRESS_PAYMENT=cashless requires GRABPAY=on (the user pays with GrabPay before the delivery is created); use GRAB_EXPRESS_PAYMENT=cash otherwise');
  }
  if (grabpay.currency !== grab.express.currency) {
    throw new Error(`GRAB_EXPRESS_PAYMENT=cashless requires GRABPAY_CURRENCY=${grab.express.currency} (GRAB_EXPRESS_REGION=${grab.express.region}), got ${grabpay.currency}`);
  }
}
