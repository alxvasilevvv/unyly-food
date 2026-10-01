// OAuth 2.0 client-credentials tokens for Grab partner APIs (GrabID token endpoint).
// One cached token per (token URL, client, scope). Refreshed shortly before expiry, or after a 401
// from an API call (the caller invalidates the rejected token and asks again). Concurrent callers
// share one in-flight refresh. Tokens and secrets are never logged.
import { z } from 'zod';
import { ProviderUnavailableError } from '../types.js';
import type { GrabCredentials } from './config.js';

export const SCOPE_EXPRESS = 'grab_express.partner_deliveries';
export const SCOPE_FAREFEED = 'ride.estimate';

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().positive(),
});

interface Cached {
  token: string;
  expiresAt: number;
}

export interface TokenDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs: number;
  log?: (entry: Record<string, unknown>) => void;
}

export class GrabTokenCache {
  private cache = new Map<string, Cached>();
  private inflight = new Map<string, Promise<Cached>>();
  /** Number of token requests sent (tests assert caching). */
  requests = 0;
  constructor(private deps: TokenDeps) {}

  private key(c: GrabCredentials, scope: string) {
    return `${c.tokenUrl}|${c.clientId}|${scope}`;
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async get(creds: GrabCredentials, scope: string): Promise<string> {
    const k = this.key(creds, scope);
    const c = this.cache.get(k);
    if (c && c.expiresAt > this.now()) return c.token;
    let p = this.inflight.get(k);
    if (!p) {
      p = this.fetchToken(creds, scope).finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    const fresh = await p;
    this.cache.set(k, fresh);
    return fresh.token;
  }

  /** Drop a token Grab rejected (401). A newer token fetched meanwhile by another caller is kept. */
  invalidate(creds: GrabCredentials, scope: string, token: string) {
    const k = this.key(creds, scope);
    if (this.cache.get(k)?.token === token) this.cache.delete(k);
  }

  private async fetchToken(creds: GrabCredentials, scope: string): Promise<Cached> {
    const f = this.deps.fetch ?? fetch;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.deps.timeoutMs);
    const t0 = Date.now();
    this.requests++;
    let res: Response;
    try {
      res = await f(creds.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', accept: 'application/json' },
        body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials', scope }),
        signal: ac.signal,
      });
    } catch (e: any) {
      this.deps.log?.({ evt: 'grab_token', scope, ok: false, error: e?.name === 'AbortError' ? 'timeout' : 'network', ms: Date.now() - t0 });
      throw new ProviderUnavailableError(`Grab token endpoint unreachable (${e?.name === 'AbortError' ? 'timeout' : 'network error'})`);
    } finally {
      clearTimeout(t);
    }
    const requestId = res.headers.get('x-grabkit-grab-requestid') ?? res.headers.get('x-request-id') ?? undefined;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error page */
    }
    this.deps.log?.({ evt: 'grab_token', scope, status: res.status, request_id: requestId, ms: Date.now() - t0 });
    if (!res.ok) {
      const err = typeof (body as any)?.error === 'string' ? String((body as any).error).slice(0, 60) : `HTTP ${res.status}`;
      throw new ProviderUnavailableError(`Grab token request failed (${err})`);
    }
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new ProviderUnavailableError('Grab token response malformed');
    const lifetimeMs = parsed.data.expires_in * 1000;
    // Refresh margin: 10% of the lifetime, at most 5 minutes (tokens live days; tests use seconds).
    const margin = Math.min(5 * 60_000, lifetimeMs * 0.1);
    return { token: parsed.data.access_token, expiresAt: this.now() + lifetimeMs - margin };
  }
}
