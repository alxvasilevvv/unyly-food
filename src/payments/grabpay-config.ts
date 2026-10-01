// GrabPay One-time Charge (OTC v2) configuration. Every value comes from the environment; see
// .env.example and docs/operations.md. Secrets are never logged: describeGrabPayConfig() prints
// only which values are set.

export type GrabPayEnv = 'sandbox' | 'production';

/** Currencies accepted by OTC v2 (docs/grab-api-research.md section 4). */
export const GRABPAY_CURRENCIES = ['SGD', 'MYR', 'PHP', 'IDR', 'THB'] as const;
export type GrabPayCurrency = (typeof GRABPAY_CURRENCIES)[number];

export interface GrabPayConfig {
  /** GRABPAY=on|off (default off). When off every payment route answers 404. */
  enabled: boolean;
  env: GrabPayEnv;
  /** Gateway origin for partner APIs and GrabID: sandbox partner-api.stg-myteksi.com, production partner-api.grab.com. */
  apiBase: string;
  partnerId: string;
  partnerSecret: string;
  merchantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Each GrabPay merchant account is tied to exactly one currency. */
  currency: GrabPayCurrency;
  /** Key for encrypting stored Grab tokens and PKCE verifiers (AES-256-GCM). Derived from clientSecret when unset. */
  tokenKey: string;
}

export const GRABPAY_HOSTS: Record<GrabPayEnv, string> = {
  sandbox: 'https://partner-api.stg-myteksi.com',
  production: 'https://partner-api.grab.com',
};

type Env = Record<string, string | undefined>;

function onOff(name: string, v: string | undefined): boolean {
  const t = (v ?? '').trim().toLowerCase();
  if (t === '') return false;
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  throw new Error(`${name} must be on or off, got "${v}"`);
}

const placeholder = (s: string) => /change[_-]?me|dev-only|example|xxx/i.test(s);

/**
 * Reads and validates GRABPAY_* variables. With GRABPAY=off nothing else is required. With
 * GRABPAY=on every credential must be set, the redirect URI must be absolute (https outside
 * development and tests) and production refuses placeholders.
 */
export function loadGrabPayConfig(webOrigin: string, nodeEnv: string, env: Env = process.env): GrabPayConfig {
  const enabled = onOff('GRABPAY', env.GRABPAY);
  const rawEnv = (env.GRABPAY_ENV ?? '').trim().toLowerCase() || 'sandbox';
  if (rawEnv !== 'sandbox' && rawEnv !== 'production') throw new Error(`GRABPAY_ENV must be sandbox or production, got "${env.GRABPAY_ENV}"`);
  const gpEnv = rawEnv as GrabPayEnv;
  const apiBase = (env.GRABPAY_API_BASE?.trim() || GRABPAY_HOSTS[gpEnv]).replace(/\/$/, '');
  const currency = (env.GRABPAY_CURRENCY?.trim().toUpperCase() || 'THB') as GrabPayCurrency;
  if (!(GRABPAY_CURRENCIES as readonly string[]).includes(currency)) throw new Error(`GRABPAY_CURRENCY must be one of ${GRABPAY_CURRENCIES.join(', ')}, got "${env.GRABPAY_CURRENCY}"`);
  const s = (k: string) => (env[k] ?? '').trim();
  const cfg: GrabPayConfig = {
    enabled,
    env: gpEnv,
    apiBase,
    partnerId: s('GRABPAY_PARTNER_ID'),
    partnerSecret: s('GRABPAY_PARTNER_SECRET'),
    merchantId: s('GRABPAY_MERCHANT_ID'),
    clientId: s('GRABPAY_CLIENT_ID'),
    clientSecret: s('GRABPAY_CLIENT_SECRET'),
    redirectUri: s('GRABPAY_REDIRECT_URI') || `${webOrigin.replace(/\/$/, '')}/pay/grab/callback`,
    currency,
    tokenKey: s('GRABPAY_TOKEN_KEY'),
  };
  validateGrabPayConfig(cfg, nodeEnv);
  return cfg;
}

/** Also used for configs built by tests (overrides) so that an invalid value cannot be smuggled in. */
export function validateGrabPayConfig(cfg: GrabPayConfig, nodeEnv: string): void {
  if (!cfg.enabled) return;
  const missing = (
    [['GRABPAY_PARTNER_ID', cfg.partnerId], ['GRABPAY_PARTNER_SECRET', cfg.partnerSecret], ['GRABPAY_MERCHANT_ID', cfg.merchantId], ['GRABPAY_CLIENT_ID', cfg.clientId], ['GRABPAY_CLIENT_SECRET', cfg.clientSecret]] as const
  ).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`GRABPAY=on needs ${missing.join(', ')}`);
  let api: URL;
  let redirect: URL;
  try {
    api = new URL(cfg.apiBase);
  } catch {
    throw new Error('GRABPAY_API_BASE must be an absolute URL');
  }
  try {
    redirect = new URL(cfg.redirectUri);
  } catch {
    throw new Error('GRABPAY_REDIRECT_URI must be an absolute URL');
  }
  if (redirect.hash) throw new Error('GRABPAY_REDIRECT_URI must not contain a fragment');
  const strict = nodeEnv === 'production';
  if (strict) {
    if (api.protocol !== 'https:') throw new Error('GRABPAY_API_BASE must be https in production');
    if (redirect.protocol !== 'https:') throw new Error('GRABPAY_REDIRECT_URI must be https in production');
    for (const [k, v] of [['GRABPAY_PARTNER_SECRET', cfg.partnerSecret], ['GRABPAY_CLIENT_SECRET', cfg.clientSecret]] as const) {
      if (placeholder(v)) throw new Error(`${k} still contains a placeholder`);
    }
    if (cfg.tokenKey && cfg.tokenKey.length < 32) throw new Error('GRABPAY_TOKEN_KEY must be at least 32 characters (openssl rand -hex 32)');
  }
}

/** Safe summary for logs and diagnostics: never includes a secret or an identifier value. */
export function describeGrabPayConfig(cfg: GrabPayConfig) {
  return {
    enabled: cfg.enabled,
    env: cfg.env,
    apiBase: cfg.apiBase,
    currency: cfg.currency,
    redirectUri: cfg.redirectUri,
    partnerId: cfg.partnerId ? 'set' : 'missing',
    partnerSecret: cfg.partnerSecret ? 'set' : 'missing',
    merchantId: cfg.merchantId ? 'set' : 'missing',
    clientId: cfg.clientId ? 'set' : 'missing',
    clientSecret: cfg.clientSecret ? 'set' : 'missing',
    tokenKey: cfg.tokenKey ? 'set' : 'derived',
  };
}
