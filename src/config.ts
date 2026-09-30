// Central configuration. Every value comes from the environment; see .env.example.
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';

// Local convenience: load ./.env if present. Variables already set in the environment win.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST && existsSync('.env')) process.loadEnvFile('.env');
export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  /** Public origin of the website and OAuth issuer, e.g. https://unyly.org */
  webOrigin: string;
  /** Canonical MCP resource URL (RFC 8707 / RFC 9728), e.g. https://mcp.unyly.org/mcp */
  mcpResourceUrl: string;
  /**
   * Which proxies to trust for X-Forwarded-For / -Proto (passed to Fastify's trustProxy).
   * A hop count (number of reverse proxies in front of the app, e.g. 1 for Caddy alone) or a list
   * of proxy IPs/CIDRs. Never `true`: trusting every hop lets clients spoof their IP and dodge
   * rate limits. TRUST_PROXY=true is read as 1 for backward compatibility. Default: 1 in production.
   */
  trustProxy: number | string[] | false;
  cookieSecure: boolean;
  demoWebhookSecret: string;
  mail: { mode: 'console' | 'smtp' | 'disabled'; smtpUrl?: string; from: string };
  /** Show login code on the page. Only allowed outside production. */
  devEchoLoginCode: boolean;
  /** Env-level kill switch; DB setting can only further restrict. */
  submissionsEnabledEnv: boolean;
  providerTimeoutMs: number;
  demoTimeScale: number;
  demoGuestSpeed: number;
  guestHourlyLimit: number;
  guestPerIpHourly: number;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  runJobs: boolean;
  /**
   * Step-up confirmation: orders whose total is at or above the threshold for their currency need a
   * fresh passkey assertion on the confirmation page (only for users who have a passkey).
   * Thresholds are in the currency's minor unit. STEP_UP=off disables the check entirely.
   */
  stepUp: { enabled: boolean; thresholds: Record<string, number> };
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const MAIL_MODES = ['smtp', 'disabled', 'console'] as const;

/** Numeric env var: must parse to a finite number (no NaN), optionally an integer within bounds. */
function num(name: string, d: number, o: { min?: number; int?: boolean; positive?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  if (o.int && !Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  if (o.positive && !(n > 0)) throw new Error(`${name} must be greater than 0, got "${raw}"`);
  if (o.min !== undefined && n < o.min) throw new Error(`${name} must be >= ${o.min}, got "${raw}"`);
  return n;
}

/** TRUST_PROXY: hop count ("1"), comma-separated IPs/CIDRs ("10.0.0.0/8,127.0.0.1"), or false/0/empty. */
export function parseTrustProxy(v: string | undefined, d: Config['trustProxy']): Config['trustProxy'] {
  if (v === undefined || v.trim() === '') return d;
  const t = v.trim().toLowerCase();
  if (['false', 'no', 'off', '0'].includes(t)) return false;
  if (['true', 'yes', 'on'].includes(t)) return 1; // legacy boolean: one proxy (Caddy), never "trust all"
  if (/^\d+$/.test(t)) return Number(t);
  const list = t.split(',').map((x) => x.trim()).filter(Boolean);
  const valid = (x: string) => {
    const [ip, bits, extra] = x.split('/');
    const fam = isIP(ip);
    if (!fam || extra !== undefined) return false;
    return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (fam === 4 ? 32 : 128));
  };
  if (!list.length || !list.every(valid)) {
    throw new Error(`TRUST_PROXY must be a hop count or a comma-separated list of IPs/CIDRs, got "${v}"`);
  }
  return list;
}

/**
 * Default step-up thresholds, roughly 2,000 THB (about 55 USD) in each Grab market currency, in minor
 * units (ISO 4217 exponent: 2 for all of these except VND, which has none). Cambodia uses USD.
 * Override one with STEP_UP_THRESHOLD_<CUR>=<minor units>.
 */
export const DEFAULT_STEP_UP_THRESHOLDS: Readonly<Record<string, number>> = {
  THB: 200_000, // 2,000.00 THB
  SGD: 7_500, // 75.00 SGD
  MYR: 25_000, // 250.00 MYR
  IDR: 90_000_000, // 900,000.00 IDR
  VND: 1_400_000, // 1,400,000 VND (no minor unit)
  PHP: 320_000, // 3,200.00 PHP
  USD: 5_500, // 55.00 USD (Cambodia)
  MMK: 20_000_000, // 200,000.00 MMK (between the official and market rate)
};

/** STEP_UP: on (default) or off. Anything else is a typo and refused, so the check is never disabled by accident. */
function stepUpEnabled(): boolean {
  const v = (process.env.STEP_UP ?? '').trim().toLowerCase();
  if (v === '') return true;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`STEP_UP must be on or off, got "${process.env.STEP_UP}"`);
}

function stepUpThresholds(): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_STEP_UP_THRESHOLDS };
  for (const cur of Object.keys(out)) out[cur] = num(`STEP_UP_THRESHOLD_${cur}`, out[cur], { int: true, positive: true });
  return out;
}

const weakSecret = (s: string) => s.length < 32 || /change[_-]?me|dev-only/i.test(s);

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV as Config['env']) || 'development';
  const port = num('PORT', 3000, { int: true, min: 1 });
  const mailMode = (process.env.MAIL_MODE || 'console').trim().toLowerCase();
  if (!(MAIL_MODES as readonly string[]).includes(mailMode)) throw new Error(`MAIL_MODE must be one of ${MAIL_MODES.join(', ')}, got "${process.env.MAIL_MODE}"`);
  const webOrigin = (process.env.WEB_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
  const cfg: Config = {
    env,
    port,
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/unyly',
    webOrigin,
    mcpResourceUrl: (process.env.MCP_RESOURCE_URL || `${webOrigin}/mcp`).replace(/\/$/, ''),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, env === 'production' ? 1 : false),
    cookieSecure: bool(process.env.COOKIE_SECURE, webOrigin.startsWith('https://')),
    demoWebhookSecret: process.env.DEMO_WEBHOOK_SECRET || 'dev-only-demo-webhook-secret-change-me',
    mail: {
      mode: mailMode as Config['mail']['mode'],
      smtpUrl: process.env.SMTP_URL,
      from: process.env.MAIL_FROM || 'Unyly <no-reply@unyly.org>',
    },
    devEchoLoginCode: bool(process.env.DEV_ECHO_LOGIN_CODE, env !== 'production'),
    submissionsEnabledEnv: bool(process.env.SUBMISSIONS_ENABLED, true),
    providerTimeoutMs: num('PROVIDER_TIMEOUT_MS', 10000, { positive: true }),
    demoTimeScale: num('DEMO_TIME_SCALE', 1, { positive: true }),
    demoGuestSpeed: num('DEMO_GUEST_SPEED', 12, { positive: true }),
    guestHourlyLimit: num('GUEST_HOURLY_LIMIT', 2000, { int: true, min: 0 }),
    guestPerIpHourly: num('GUEST_PER_IP_HOURLY', 6, { int: true, min: 0 }),
    accessTokenTtlSec: num('ACCESS_TOKEN_TTL_SEC', 3600, { int: true, positive: true }),
    refreshTokenTtlSec: num('REFRESH_TOKEN_TTL_SEC', 30 * 24 * 3600, { int: true, positive: true }),
    runJobs: bool(process.env.RUN_JOBS, true),
    stepUp: { enabled: stepUpEnabled(), thresholds: stepUpThresholds() },
    ...overrides,
  };
  // Also checked here so that overrides (tests, CLI) cannot smuggle in an invalid value.
  if (!(MAIL_MODES as readonly string[]).includes(cfg.mail.mode)) throw new Error(`MAIL_MODE must be one of ${MAIL_MODES.join(', ')}`);
  if (!(Number.isFinite(cfg.demoTimeScale) && cfg.demoTimeScale > 0)) throw new Error('DEMO_TIME_SCALE must be greater than 0');
  for (const [cur, v] of Object.entries(cfg.stepUp.thresholds)) {
    if (!(Number.isSafeInteger(v) && v > 0)) throw new Error(`STEP_UP_THRESHOLD_${cur} must be a positive integer in minor units`);
  }
  if (cfg.env === 'production') {
    if (!process.env.DATABASE_URL && !overrides.databaseUrl) throw new Error('DATABASE_URL must be set in production');
    if (/CHANGE_ME/i.test(cfg.databaseUrl)) throw new Error('DATABASE_URL still contains a placeholder password');
    if (cfg.devEchoLoginCode) throw new Error('DEV_ECHO_LOGIN_CODE must be false in production');
    if (weakSecret(cfg.demoWebhookSecret)) throw new Error('DEMO_WEBHOOK_SECRET must be a random secret of at least 32 characters in production (openssl rand -hex 32)');
    if (!cfg.webOrigin.startsWith('https://')) throw new Error('WEB_ORIGIN must be https in production');
    if (!cfg.mcpResourceUrl.startsWith('https://')) throw new Error('MCP_RESOURCE_URL must be https in production');
    if (cfg.mail.mode === 'console') throw new Error('MAIL_MODE must be smtp or disabled in production');
    if (cfg.mail.mode === 'smtp' && !cfg.mail.smtpUrl) throw new Error('SMTP_URL is required when MAIL_MODE=smtp');
  }
  return cfg;
}
