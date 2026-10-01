// Small fetch wrapper for Grab partner APIs: bearer token (with one retry after a 401), per-request
// timeout, JSON in and out, client-side pacing (sandbox allows 5 requests per second), and a log line
// per call with Grab's request id. Never logs tokens, secrets, request bodies, addresses or phones.
import { ProviderUnavailableError } from '../types.js';
import type { GrabCredentials } from './config.js';
import type { GrabTokenCache } from './token.js';

/**
 * How a call failed before an HTTP response arrived.
 * - not_sent: the connection was never established (DNS, refused); Grab certainly did not process it.
 * - timeout / network: the request may have reached Grab. For a create this is an UNKNOWN outcome.
 */
export type SendFailure = 'not_sent' | 'timeout' | 'network';

export class GrabTransportError extends Error {
  constructor(readonly failure: SendFailure, message: string) {
    super(message);
  }
}

export interface GrabResponse {
  status: number;
  body: any;
  requestId?: string;
}

/** Spaces requests out to at most `rps` per second (FIFO, no burst). */
export class Pacer {
  private next = 0;
  private readonly interval: number;
  constructor(rps: number) {
    this.interval = Math.ceil(1000 / Math.max(1, rps));
  }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

function classify(e: any): SendFailure {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return 'not_sent';
  return 'network';
}

/** A short, log-safe excerpt of Grab's error message (business errors are plain English sentences). */
export function grabErrorMessage(body: any, status: number): string {
  const pick = [body?.message, body?.reason, body?.error_description, body?.error, body?.errors?.[0]?.message].find((x) => typeof x === 'string' && x.trim());
  const text = typeof pick === 'string' ? pick : `HTTP ${status}`;
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

export interface GrabHttpDeps {
  tokens: GrabTokenCache;
  fetch?: typeof fetch;
  timeoutMs: number;
  rps: number;
  log?: (entry: Record<string, unknown>) => void;
}

export class GrabHttp {
  private pacer: Pacer;
  constructor(private deps: GrabHttpDeps) {
    this.pacer = new Pacer(deps.rps);
  }

  /**
   * `op` names the call in logs (e.g. "express.create"); the URL path may carry a deliveryID, which is
   * Grab's tracking id and not personal data.
   */
  async request(o: {
    op: string;
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    body?: unknown;
    creds: GrabCredentials;
    scope: string;
    timeoutMs?: number;
  }): Promise<GrabResponse> {
    let token = await this.deps.tokens.get(o.creds, o.scope);
    let r = await this.send(o, token);
    if (r.status === 401) {
      // Expired or revoked token: Grab rejected the call before processing it, so one retry is safe.
      this.deps.tokens.invalidate(o.creds, o.scope, token);
      token = await this.deps.tokens.get(o.creds, o.scope);
      r = await this.send(o, token);
      if (r.status === 401) throw new ProviderUnavailableError(`Grab rejected the credentials for ${o.op} (401)`);
    }
    return r;
  }

  private async send(o: { op: string; method: string; url: string; body?: unknown; timeoutMs?: number }, token: string): Promise<GrabResponse> {
    await this.pacer.wait();
    const f = this.deps.fetch ?? fetch;
    const ac = new AbortController();
    const timeout = o.timeoutMs ?? this.deps.timeoutMs;
    const t = setTimeout(() => ac.abort(), timeout);
    const t0 = Date.now();
    const path = new URL(o.url).pathname;
    let res: Response;
    try {
      res = await f(o.url, {
        method: o.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: ac.signal,
      });
    } catch (e: any) {
      clearTimeout(t);
      const failure = classify(e);
      this.deps.log?.({ evt: 'grab_call', op: o.op, method: o.method, path, ok: false, failure, ms: Date.now() - t0 });
      throw new GrabTransportError(failure, `Grab ${o.op}: ${failure === 'timeout' ? `no response within ${timeout} ms` : failure === 'not_sent' ? 'could not connect' : 'connection lost'}`);
    }
    let body: any = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        clearTimeout(t);
        this.deps.log?.({ evt: 'grab_call', op: o.op, method: o.method, path, status: res.status, ok: false, failure: 'timeout', ms: Date.now() - t0 });
        throw new GrabTransportError('timeout', `Grab ${o.op}: response body timed out`);
      }
      body = null; // non-JSON body (HTML error page)
    } finally {
      clearTimeout(t);
    }
    const requestId = res.headers.get('x-grabkit-grab-requestid') ?? undefined;
    const xRequestId = res.headers.get('x-request-id') ?? undefined;
    this.deps.log?.({ evt: 'grab_call', op: o.op, method: o.method, path, status: res.status, grab_request_id: requestId, x_request_id: xRequestId, ms: Date.now() - t0 });
    return { status: res.status, body, requestId: requestId ?? xRequestId };
  }
}
