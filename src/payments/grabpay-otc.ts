// Low-level client for GrabPay One-time Charge (OTC) API v2, written against
// docs/grab-api-research.md section 4. No business logic and no database access here: the payment
// state machine lives in ./service.ts.
//
// Three auth schemes:
//  1. Request HMAC (init, one-time-charge status, webhooks): Authorization: {partner_id}:{signature}
//  2. OAuth bearer from the user's authorization code (complete, partner charge status, refund)
//  3. X-GID-AUX-POP proof of possession, sent together with the bearer and regenerated per request
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GRABPAY_CURRENCIES, GrabPayConfig, GrabPayCurrency } from './grabpay-config.js';

// ---------------------------------------------------------------------------------------------
// Amounts and identifiers
// ---------------------------------------------------------------------------------------------

/**
 * Minor-unit exponent per OTC currency. The docs list SGD/MYR/PHP/THB as x100 and IDR "as 2
 * decimals in the table"; VND (0 decimals) is listed in the table but is not in the endpoint enum.
 */
export const GRABPAY_EXPONENT: Readonly<Record<GrabPayCurrency, number>> = { SGD: 2, MYR: 2, PHP: 2, THB: 2, IDR: 2 };

/** Country code for acr_values consent_ctx; one merchant account per currency. */
export const GRABPAY_COUNTRY: Readonly<Record<GrabPayCurrency, string>> = { SGD: 'SG', MYR: 'MY', PHP: 'PH', IDR: 'ID', THB: 'TH' };

export const isGrabPayCurrency = (c: string): c is GrabPayCurrency => (GRABPAY_CURRENCIES as readonly string[]).includes(c);

/** `^[a-zA-Z0-9\-_]+$`, at most 32 characters (partnerTxID and partnerGroupTxID). */
export const TX_ID_RE = /^[a-zA-Z0-9\-_]{1,32}$/;

/** partnerTxID for a charge: our payment UUID without dashes (32 hex). Retries reuse it. */
export function chargePartnerTxId(paymentId: string): string {
  const id = paymentId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('payment id must be a UUID');
  return id;
}

/** partnerGroupTxID (receipt level): our checkout UUID without dashes. */
export const groupPartnerTxId = (checkoutId: string) => chargePartnerTxId(checkoutId);

/** partnerTxID for a refund: deterministic from (payment, idempotency key), "r" + 31 hex. */
export function refundPartnerTxId(paymentId: string, key: string): string {
  return `r${createHash('sha256').update(`${paymentId}|${key}`).digest('hex').slice(0, 31)}`;
}

/** Validates an integer minor-unit amount for a currency. Throws on floats, zero or negatives. */
export function assertMinorAmount(amountMinor: number, currency: string): void {
  if (!isGrabPayCurrency(currency)) throw new Error(`Currency ${currency} is not supported by GrabPay OTC`);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('amount must be a positive integer in minor units');
}

/** Converts a major-unit decimal string ("120.50") to minor units for the currency, without float drift. */
export function toMinor(major: string, currency: GrabPayCurrency): number {
  const exp = GRABPAY_EXPONENT[currency];
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(major.trim());
  if (!m) throw new Error('invalid amount');
  const frac = (m[2] ?? '').padEnd(exp, '0');
  if (frac.length > exp) throw new Error('too many decimal places');
  return Number(m[1]) * 10 ** exp + (exp ? Number(frac) : 0);
}

// ---------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------

/** RFC 7231 IMF-fixdate, e.g. "Thu, 01 Oct 2026 10:00:00 GMT". */
export const httpDate = (d: Date) => d.toUTCString();

/** body_digest = base64(sha256(raw_body)); empty string for GET. */
export function bodyDigest(method: string, rawBody: string): string {
  if (method.toUpperCase() === 'GET') return '';
  return createHash('sha256').update(rawBody, 'utf8').digest('base64');
}

export interface HmacInput {
  method: string;
  contentType: string;
  date: string;
  /** Path plus query string as sent on the wire, e.g. /grabpay/partner/v2/one-time-charge/abc/status?currency=THB */
  path: string;
  body: string;
}

/** signing_payload = METHOD \n Content-Type \n Date \n request_path \n body_digest \n */
export function signingPayload(i: HmacInput): string {
  return `${i.method.toUpperCase()}\n${i.contentType}\n${i.date}\n${i.path}\n${bodyDigest(i.method, i.body)}\n`;
}

/** signature = base64(HMAC_SHA256(partner_secret, signing_payload)) */
export function hmacSignature(partnerSecret: string, i: HmacInput): string {
  return createHmac('sha256', partnerSecret).update(signingPayload(i), 'utf8').digest('base64');
}

/** Authorization header value for request HMAC: "{partner_id}:{signature}". */
export const hmacAuthorization = (partnerId: string, partnerSecret: string, i: HmacInput) => `${partnerId}:${hmacSignature(partnerSecret, i)}`;

/**
 * X-GID-AUX-POP: base64url(JSON.stringify({ time_since_epoch, sig })) where
 * sig = base64url(HMAC_SHA256(client_secret, String(unix_ts) + access_token)), padding stripped.
 */
export function popHeader(clientSecret: string, accessToken: string, unixTs: number): string {
  const sig = createHmac('sha256', clientSecret).update(`${unixTs}${accessToken}`, 'utf8').digest('base64url');
  return Buffer.from(JSON.stringify({ time_since_epoch: unixTs, sig }), 'utf8').toString('base64url');
}

const safeEq = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export type WebhookCheck = { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_partner' | 'stale_date' | 'bad_signature' };

/**
 * Verifies a Grab -> merchant webhook: recompute the request HMAC with our webhook path, the
 * received Date and Content-Type (exactly as received) and the raw body; constant-time compare;
 * Date must be within +-5 minutes of now.
 */
export function verifyWebhookSignature(
  cfg: Pick<GrabPayConfig, 'partnerId' | 'partnerSecret'>,
  req: { method: string; path: string; headers: Record<string, string | string[] | undefined>; rawBody: string },
  now: Date,
  maxSkewMs = 5 * 60 * 1000,
): WebhookCheck {
  const h = (k: string) => {
    const v = req.headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const auth = h('authorization');
  const date = h('date');
  const ct = h('content-type') ?? '';
  if (!auth || !date) return { ok: false, reason: 'missing_headers' };
  const idx = auth.indexOf(':');
  if (idx <= 0) return { ok: false, reason: 'missing_headers' };
  const partner = auth.slice(0, idx);
  const sig = auth.slice(idx + 1);
  if (!safeEq(partner, cfg.partnerId)) return { ok: false, reason: 'bad_partner' };
  const t = Date.parse(date);
  if (!Number.isFinite(t) || Math.abs(now.getTime() - t) > maxSkewMs) return { ok: false, reason: 'stale_date' };
  const expected = hmacSignature(cfg.partnerSecret, { method: req.method, contentType: ct, date, path: req.path, body: req.rawBody });
  return safeEq(sig, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ---------------------------------------------------------------------------------------------
// PKCE, state, authorize URL
// ---------------------------------------------------------------------------------------------

export interface AuthSecrets {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Fresh PKCE verifier (43 chars of base64url), state and nonce. */
export function newAuthSecrets(): AuthSecrets {
  return { state: randomBytes(24).toString('base64url'), nonce: randomBytes(16).toString('base64url'), codeVerifier: randomBytes(32).toString('base64url') };
}

export const codeChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export const OTC_SCOPE = 'payment.one_time_charge';

export function acrValues(currency: GrabPayCurrency): string {
  return `consent_ctx:countryCode=${GRABPAY_COUNTRY[currency]},currency=${currency}`;
}

/** GET {apiBase}/grabid/v1/oauth2/authorize with every parameter the OTC flow requires. */
export function buildAuthorizeUrl(cfg: GrabPayConfig, p: { request: string; currency: GrabPayCurrency; secrets: AuthSecrets }): string {
  const u = new URL(`${cfg.apiBase}/grabid/v1/oauth2/authorize`);
  const q: Record<string, string> = {
    acr_values: acrValues(p.currency),
    client_id: cfg.clientId,
    code_challenge: codeChallenge(p.secrets.codeVerifier),
    code_challenge_method: 'S256',
    nonce: p.secrets.nonce,
    redirect_uri: cfg.redirectUri,
    request: p.request,
    response_type: 'code',
    scope: OTC_SCOPE,
    state: p.secrets.state,
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/** The call definitely did not take effect (4xx other than an ambiguous one): safe to treat as final. */
export class GrabPayRejected extends Error {
  constructor(readonly status: number, readonly reason: string, readonly requestId?: string) {
    super(`GrabPay rejected the request (${status} ${reason})`);
  }
}

/** Not processed and safe to retry later (429 or a pre-flight failure such as DNS / connection refused). */
export class GrabPayUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`GrabPay unavailable: ${detail}`);
  }
}

/** The request may or may not have been processed (timeout, reset, 5xx): reconcile via status. */
export class GrabPayOutcomeUnknown extends Error {
  constructor(readonly detail: string) {
    super(`GrabPay outcome unknown: ${detail}`);
  }
}

export interface InitResult { partnerTxID: string; request: string }
export interface TokenResult { accessToken: string; idToken?: string; expiresIn?: number }
export interface ChargeStatus {
  txID?: string;
  status?: string;
  txStatus?: string;
  reason?: string;
  paymentMethod?: string;
  oAuthCode?: string;
  description?: string;
}
export interface RefundStatus { txID?: string; txStatus?: string; reason?: string; status?: string }

export interface OtcClientOptions {
  now?: () => Date;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Connection-level errors that prove the request never reached the server. */
const PRE_FLIGHT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

export class GrabPayOtcClient {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(readonly cfg: GrabPayConfig, opts: OtcClientOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown, auth: { kind: 'hmac' } | { kind: 'bearer'; accessToken: string } | { kind: 'none' }) {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const contentType = 'application/json';
    const date = httpDate(this.now());
    const headers: Record<string, string> = { 'content-type': contentType, date, accept: 'application/json' };
    if (auth.kind === 'hmac') {
      headers.authorization = hmacAuthorization(this.cfg.partnerId, this.cfg.partnerSecret, { method, contentType, date, path, body: raw });
    } else if (auth.kind === 'bearer') {
      headers.authorization = `Bearer ${auth.accessToken}`;
      headers['x-gid-aux-pop'] = popHeader(this.cfg.clientSecret, auth.accessToken, Math.floor(this.now().getTime() / 1000));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.apiBase}${path}`, { method, headers, body: method === 'GET' ? undefined : raw, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e: any) {
      const code = e?.cause?.code ?? e?.code;
      if (PRE_FLIGHT.has(code)) throw new GrabPayUnavailable(String(code));
      throw new GrabPayOutcomeUnknown(e?.name === 'TimeoutError' ? 'timeout' : String(code ?? e?.name ?? 'network error'));
    }
    const requestId = res.headers.get('x-grabkit-grab-requestid') ?? res.headers.get('x-request-id') ?? undefined;
    let json: any = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new GrabPayOutcomeUnknown(`unparseable ${res.status} response`);
    }
    if (res.ok) return { status: res.status, json: json ?? {}, requestId };
    const reason = String(json?.reason ?? json?.error ?? json?.code ?? 'error');
    if (res.status === 429) throw new GrabPayUnavailable('rate_limited');
    if (res.status >= 500) throw new GrabPayOutcomeUnknown(`http ${res.status}`);
    throw new GrabPayRejected(res.status, reason, requestId);
  }

  /** POST /grabpay/partner/v2/charge/init (HMAC). Returns the unsigned `request` JWT for the authorize redirect. */
  async initCharge(p: { partnerTxID: string; partnerGroupTxID: string; amountMinor: number; currency: GrabPayCurrency; description?: string }): Promise<InitResult> {
    if (!TX_ID_RE.test(p.partnerTxID) || !TX_ID_RE.test(p.partnerGroupTxID)) throw new Error('invalid partnerTxID');
    assertMinorAmount(p.amountMinor, p.currency);
    const body: Record<string, unknown> = {
      partnerGroupTxID: p.partnerGroupTxID,
      partnerTxID: p.partnerTxID,
      amount: p.amountMinor,
      currency: p.currency,
      merchantID: this.cfg.merchantId,
    };
    if (p.description) body.description = p.description.slice(0, 255);
    const r = await this.send('POST', '/grabpay/partner/v2/charge/init', body, { kind: 'hmac' });
    if (typeof r.json.request !== 'string' || !r.json.request) throw new GrabPayOutcomeUnknown('init response without request');
    return { partnerTxID: String(r.json.partnerTxID ?? p.partnerTxID), request: r.json.request };
  }

  /** POST /grabid/v1/oauth2/token (JSON) with the authorization code and PKCE verifier. */
  async exchangeCode(p: { code: string; codeVerifier: string }): Promise<TokenResult> {
    const r = await this.send('POST', '/grabid/v1/oauth2/token', {
      code: p.code,
      client_id: this.cfg.clientId,
      grant_type: 'authorization_code',
      redirect_uri: this.cfg.redirectUri,
      code_verifier: p.codeVerifier,
      client_secret: this.cfg.clientSecret,
    }, { kind: 'none' });
    if (typeof r.json.access_token !== 'string' || !r.json.access_token) throw new GrabPayOutcomeUnknown('token response without access_token');
    return { accessToken: r.json.access_token, idToken: r.json.id_token, expiresIn: r.json.expires_in };
  }

  /** POST /grabpay/partner/v2/charge/complete (Bearer + POP). Safe to repeat: returns the latest status. */
  async completeCharge(p: { partnerTxID: string; accessToken: string }): Promise<ChargeStatus> {
    const r = await this.send('POST', '/grabpay/partner/v2/charge/complete', { partnerTxID: p.partnerTxID }, { kind: 'bearer', accessToken: p.accessToken });
    return pickCharge(r.json);
  }

  /**
   * GET /grabpay/partner/v2/one-time-charge/{partnerTxID}/status?currency= (HMAC). Usable any time
   * after init; returns null when Grab has no record (404 / no_record_found).
   */
  async chargeStatus(p: { partnerTxID: string; currency: GrabPayCurrency }): Promise<ChargeStatus | null> {
    try {
      const r = await this.send('GET', `/grabpay/partner/v2/one-time-charge/${encodeURIComponent(p.partnerTxID)}/status?currency=${p.currency}`, undefined, { kind: 'hmac' });
      return pickCharge(r.json);
    } catch (e) {
      if (e instanceof GrabPayRejected && (e.status === 404 || e.reason === 'no_record_found')) return null;
      throw e;
    }
  }

  /** POST /grabpay/partner/v2/refund (Bearer + POP). Full or partial; a reused partnerTxID returns the latest status. */
  async refund(p: { partnerTxID: string; partnerGroupTxID: string; amountMinor: number; currency: GrabPayCurrency; originTxID?: string; description?: string; accessToken: string }): Promise<RefundStatus> {
    assertMinorAmount(p.amountMinor, p.currency);
    const body: Record<string, unknown> = {
      partnerGroupTxID: p.partnerGroupTxID,
      partnerTxID: p.partnerTxID,
      amount: p.amountMinor,
      currency: p.currency,
      merchantID: this.cfg.merchantId,
    };
    if (p.originTxID) body.originTxID = p.originTxID;
    if (p.description) body.description = p.description.slice(0, 255);
    const r = await this.send('POST', '/grabpay/partner/v2/refund', body, { kind: 'bearer', accessToken: p.accessToken });
    return pickRefund(r.json);
  }

  /** GET /grabpay/partner/v2/refund/{partnerTxID}/status?currency= (Bearer + POP). Null when not found. */
  async refundStatus(p: { partnerTxID: string; currency: GrabPayCurrency; accessToken: string }): Promise<RefundStatus | null> {
    try {
      const r = await this.send('GET', `/grabpay/partner/v2/refund/${encodeURIComponent(p.partnerTxID)}/status?currency=${p.currency}`, undefined, { kind: 'bearer', accessToken: p.accessToken });
      return pickRefund(r.json);
    } catch (e) {
      if (e instanceof GrabPayRejected && (e.status === 404 || e.reason === 'no_record_found' || e.reason === 'payment_not_found')) return null;
      throw e;
    }
  }
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

function pickCharge(j: any): ChargeStatus {
  return { txID: str(j?.txID), status: str(j?.status), txStatus: str(j?.txStatus), reason: str(j?.reason), paymentMethod: str(j?.paymentMethod), oAuthCode: str(j?.oAuthCode), description: str(j?.description) };
}

function pickRefund(j: any): RefundStatus {
  return { txID: str(j?.txID), txStatus: str(j?.txStatus), reason: str(j?.reason), status: str(j?.status) };
}

/** Charge txStatus values that are final per the docs. */
export const FINAL_CHARGE = new Set(['success', 'failed']);
