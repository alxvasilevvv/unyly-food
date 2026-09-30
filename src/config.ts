// Central configuration. Every value comes from the environment; see .env.example.
import { existsSync } from 'node:fs';

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
  /** Hostnames on which the MCP endpoint is served (for Host header routing). */
  trustProxy: boolean;
  cookieSecure: boolean;
  demoWebhookSecret: string;
  mail: { mode: 'console' | 'smtp' | 'disabled'; smtpUrl?: string; from: string };
  /** Show login code on the page. Only allowed outside production. */
  devEchoLoginCode: boolean;
  /** Env-level kill switch; DB setting can only further restrict. */
  submissionsEnabledEnv: boolean;
  providerTimeoutMs: number;
  demoTimeScale: number;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  runJobs: boolean;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV as Config['env']) || 'development';
  const port = Number(process.env.PORT || 3000);
  const webOrigin = (process.env.WEB_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
  const cfg: Config = {
    env,
    port,
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/unyly',
    webOrigin,
    mcpResourceUrl: (process.env.MCP_RESOURCE_URL || `${webOrigin}/mcp`).replace(/\/$/, ''),
    trustProxy: bool(process.env.TRUST_PROXY, env === 'production'),
    cookieSecure: bool(process.env.COOKIE_SECURE, webOrigin.startsWith('https://')),
    demoWebhookSecret: process.env.DEMO_WEBHOOK_SECRET || 'dev-only-demo-webhook-secret-change-me',
    mail: {
      mode: (process.env.MAIL_MODE as 'console' | 'smtp' | 'disabled') || 'console',
      smtpUrl: process.env.SMTP_URL,
      from: process.env.MAIL_FROM || 'Unyly <no-reply@unyly.org>',
    },
    devEchoLoginCode: bool(process.env.DEV_ECHO_LOGIN_CODE, env !== 'production'),
    submissionsEnabledEnv: bool(process.env.SUBMISSIONS_ENABLED, true),
    providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS || 10000),
    demoTimeScale: Number(process.env.DEMO_TIME_SCALE || 1),
    accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC || 3600),
    refreshTokenTtlSec: Number(process.env.REFRESH_TOKEN_TTL_SEC || 30 * 24 * 3600),
    runJobs: bool(process.env.RUN_JOBS, true),
    ...overrides,
  };
  if (cfg.env === 'production') {
    if (cfg.devEchoLoginCode) throw new Error('DEV_ECHO_LOGIN_CODE must be false in production');
    if (cfg.demoWebhookSecret.startsWith('dev-only')) throw new Error('DEMO_WEBHOOK_SECRET must be set in production');
    if (!cfg.webOrigin.startsWith('https://')) throw new Error('WEB_ORIGIN must be https in production');
    if (cfg.mail.mode === 'console') throw new Error('MAIL_MODE must be smtp or disabled in production');
  }
  return cfg;
}
