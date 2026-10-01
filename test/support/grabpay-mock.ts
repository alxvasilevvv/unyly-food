// Mock GrabPay OTC v2 + GrabID for tests (Fastify on a random port). It verifies request HMAC,
// Date skew, Bearer tokens, the X-GID-AUX-POP header and PKCE the way docs/grab-api-research.md
// section 4 describes. The signing code here is written independently of src/payments so that a
// bug in our client cannot be mirrored by the mock. No real network.
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface MockCreds {
  partnerId: string;
  partnerSecret: string;
  clientId: string;
  clientSecret: string;
  merchantId: string;
}

type Fault = 'reset_before' | 'reset_after' | 'http_500' | 'http_429';
type Route = 'init' | 'token' | 'complete' | 'status' | 'refund' | 'refund_status';

interface Tx {
  partnerTxID: string;
  partnerGroupTxID: string;
  amount: number;
  currency: string;
  request: string;
  txID: string;
  txStatus: 'processing' | 'authorised' | 'success' | 'failed' | 'cancelled';
  reason: string;
  code?: string;
  codeUsed?: boolean;
  challenge?: string;
  redirectUri?: string;
  accessToken?: string;
  completeCalls: number;
}

interface Refund { partnerTxID: string; origin: string; amount: number; txID: string; txStatus: 'success' | 'failed' | 'processing'; reason: string }

const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Independent implementation of the request HMAC. */
export function mockHmac(secret: string, method: string, contentType: string, date: string, pathWithQuery: string, body: string): string {
  const digest = method === 'GET' ? '' : createHash('sha256').update(Buffer.from(body, 'utf8')).digest().toString('base64');
  const lines = [method, contentType, date, pathWithQuery, digest].join('\n') + '\n';
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(lines, 'utf8')).digest().toString('base64');
}

export class GrabPayMock {
  app!: FastifyInstance;
  baseUrl = '';
  txs = new Map<string, Tx>();
  refunds = new Map<string, Refund>();
  /** Every rejected auth attempt, for assertions ("the client signed correctly"). */
  authFailures: { route: string; why: string }[] = [];
  calls: Route[] = [];
  /** What the simulated user does on the Grab consent page. */
  consent: 'approve' | 'cancel' | 'decline' = 'approve';
  /** txStatus returned by complete for the next call(s) (default success). */
  completeOutcome: 'success' | 'failed' | 'processing' = 'success';
  private faults = new Map<Route, Fault[]>();

  constructor(readonly creds: MockCreds) {}

  /** Inject a fault for the next call of a route. reset_after processes the call, then drops the connection. */
  failNext(route: Route, fault: Fault) {
    this.faults.set(route, [...(this.faults.get(route) ?? []), fault]);
  }

  private takeFault(route: Route): Fault | undefined {
    const q = this.faults.get(route);
    return q?.shift();
  }

  async start() {
    const app = Fastify({ logger: false });
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
    this.app = app;

    const hmacOk = (req: FastifyRequest, route: string, raw: string): boolean => {
      const auth = String(req.headers.authorization ?? '');
      const date = String(req.headers.date ?? '');
      const ct = String(req.headers['content-type'] ?? '');
      const [pid, sig] = [auth.slice(0, auth.indexOf(':')), auth.slice(auth.indexOf(':') + 1)];
      if (pid !== this.creds.partnerId) return this.reject(route, 'partner id');
      const t = Date.parse(date);
      if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 5 * 60 * 1000) return this.reject(route, 'date skew');
      if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(date)) return this.reject(route, 'date format');
      if (ct !== 'application/json') return this.reject(route, 'content type');
      const want = mockHmac(this.creds.partnerSecret, req.method, ct, date, req.url, raw);
      if (!eq(sig, want)) return this.reject(route, 'signature');
      return true;
    };

    const bearerOk = (req: FastifyRequest, route: string): Tx | null => {
      const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
      if (!m) return (this.reject(route, 'no bearer'), null);
      if (!req.headers.date) return (this.reject(route, 'no date'), null);
      const tx = [...this.txs.values()].find((x) => x.accessToken === m[1]);
      if (!tx) return (this.reject(route, 'unknown token'), null);
      let pop: any;
      try {
        pop = JSON.parse(Buffer.from(String(req.headers['x-gid-aux-pop'] ?? ''), 'base64url').toString('utf8'));
      } catch {
        return (this.reject(route, 'pop format'), null);
      }
      if (typeof pop?.time_since_epoch !== 'number' || typeof pop?.sig !== 'string') return (this.reject(route, 'pop fields'), null);
      if (Math.abs(Date.now() / 1000 - pop.time_since_epoch) > 300) return (this.reject(route, 'pop time'), null);
      const want = b64u(createHmac('sha256', this.creds.clientSecret).update(`${pop.time_since_epoch}${m[1]}`).digest());
      if (!eq(pop.sig, want)) return (this.reject(route, 'pop sig'), null);
      return tx;
    };

    // Applies an injected fault: "before" faults skip processing, "after" faults run it first.
    const guard = async (route: Route, req: FastifyRequest, reply: FastifyReply, run: () => Promise<{ code: number; body: unknown }>) => {
      this.calls.push(route);
      const f = this.takeFault(route);
      if (f === 'reset_before') return req.raw.socket.destroy();
      if (f === 'http_429') return reply.code(429).send({ reason: 'rate_limited' });
      const out = await run();
      if (f === 'reset_after') return req.raw.socket.destroy();
      if (f === 'http_500') return reply.code(500).send({ reason: 'internal' });
      return reply.code(out.code).header('x-grabkit-grab-requestid', randomBytes(8).toString('hex')).send(out.body);
    };

    app.post('/grabpay/partner/v2/charge/init', async (req, reply) => {
      const raw = String(req.body ?? '');
      if (!hmacOk(req, 'init', raw)) return reply.code(401).send({ reason: 'unauthorized' });
      return guard('init', req, reply, async () => {
        const b = JSON.parse(raw);
        const idRe = /^[a-zA-Z0-9\-_]{1,32}$/;
        if (!idRe.test(b.partnerTxID ?? '') || !idRe.test(b.partnerGroupTxID ?? '')) return { code: 400, body: { reason: 'client_error' } };
        if (!Number.isSafeInteger(b.amount) || b.amount <= 0) return { code: 400, body: { reason: 'client_error' } };
        if (!['SGD', 'MYR', 'PHP', 'IDR', 'THB'].includes(b.currency)) return { code: 400, body: { reason: 'client_error' } };
        if (b.merchantID !== this.creds.merchantId) return { code: 409, body: { reason: 'invalid_merchant' } };
        if (this.txs.has(b.partnerTxID)) return { code: 409, body: { reason: 'transaction_already_exists' } };
        const header = b64u(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
        const payload = b64u(Buffer.from(JSON.stringify({ partnerTxID: b.partnerTxID, amount: b.amount, currency: b.currency })));
        const request = `${header}.${payload}.`;
        this.txs.set(b.partnerTxID, {
          partnerTxID: b.partnerTxID, partnerGroupTxID: b.partnerGroupTxID, amount: b.amount, currency: b.currency, request,
          txID: randomBytes(16).toString('hex'), txStatus: 'processing', reason: 'pending_user_consent', completeCalls: 0,
        });
        return { code: 200, body: { partnerTxID: b.partnerTxID, request } };
      });
    });

    // The simulated Grab consent page: validates the authorize request, then redirects back.
    app.get('/grabid/v1/oauth2/authorize', async (req, reply) => {
      const q = req.query as Record<string, string>;
      const required = ['acr_values', 'client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'redirect_uri', 'request', 'response_type', 'scope', 'state'];
      const missing = required.filter((k) => !q[k]);
      if (missing.length) return reply.code(400).send({ error: 'invalid_request', missing });
      if (q.client_id !== this.creds.clientId || q.code_challenge_method !== 'S256' || q.response_type !== 'code' || q.scope !== 'payment.one_time_charge') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      let ptx: string;
      try {
        ptx = JSON.parse(Buffer.from(q.request.split('.')[1], 'base64url').toString('utf8')).partnerTxID;
      } catch {
        return reply.code(400).send({ error: 'invalid_token' });
      }
      const tx = this.txs.get(ptx);
      if (!tx) return reply.code(400).send({ error: 'transaction_not_found' });
      if (q.acr_values !== `consent_ctx:countryCode=${{ THB: 'TH', SGD: 'SG', MYR: 'MY', PHP: 'PH', IDR: 'ID' }[tx.currency]},currency=${tx.currency}`) {
        return reply.redirect(`${q.redirect_uri}?error=invalid_acr_values&state=${encodeURIComponent(q.state)}`);
      }
      if (this.consent === 'cancel') return reply.redirect(`${q.redirect_uri}?error=user_canceled&state=${encodeURIComponent(q.state)}`);
      if (this.consent === 'decline') {
        tx.txStatus = 'failed';
        tx.reason = 'insufficient_balance';
        return reply.redirect(`${q.redirect_uri}?error=insufficient_balance&state=${encodeURIComponent(q.state)}`);
      }
      tx.code = randomBytes(16).toString('hex');
      tx.challenge = q.code_challenge;
      tx.redirectUri = q.redirect_uri;
      tx.txStatus = 'authorised';
      tx.reason = 'pending_capture';
      return reply.redirect(`${q.redirect_uri}?code=${tx.code}&state=${encodeURIComponent(q.state)}`);
    });

    app.post('/grabid/v1/oauth2/token', async (req, reply) => {
      return guard('token', req, reply, async () => {
        const b = JSON.parse(String(req.body ?? '{}'));
        if (b.client_id !== this.creds.clientId || b.client_secret !== this.creds.clientSecret) return (this.reject('token', 'client'), { code: 401, body: { error: 'invalid_client' } });
        if (b.grant_type !== 'authorization_code') return { code: 400, body: { error: 'unsupported_grant_type' } };
        const tx = [...this.txs.values()].find((x) => x.code && x.code === b.code);
        if (!tx || tx.codeUsed) return { code: 400, body: { error: 'invalid_grant' } };
        if (b.redirect_uri !== tx.redirectUri) return { code: 400, body: { error: 'invalid_grant' } };
        if (b64u(createHash('sha256').update(String(b.code_verifier ?? '')).digest()) !== tx.challenge) return (this.reject('token', 'pkce'), { code: 400, body: { error: 'invalid_grant' } });
        tx.codeUsed = true;
        tx.accessToken = `gpat_${randomBytes(18).toString('hex')}`;
        return { code: 200, body: { access_token: tx.accessToken, token_type: 'Bearer', expires_in: 31536000, id_token: 'x.y.z' } };
      });
    });

    app.post('/grabpay/partner/v2/charge/complete', async (req, reply) => {
      const tx = bearerOk(req, 'complete');
      if (!tx) return reply.code(401).send({ reason: 'unauthorized' });
      return guard('complete', req, reply, async () => {
        const b = JSON.parse(String(req.body ?? '{}'));
        if (b.partnerTxID !== tx.partnerTxID) return { code: 404, body: { reason: 'no_record_found' } };
        tx.completeCalls++;
        if (tx.txStatus === 'authorised') {
          tx.txStatus = this.completeOutcome;
          tx.reason = this.completeOutcome === 'failed' ? 'err_capture_failed' : this.completeOutcome === 'processing' ? 'capturing' : '';
        }
        return { code: 200, body: { txID: tx.txID, status: tx.txStatus, paymentMethod: 'GPWALLET', description: '', txStatus: tx.txStatus, reason: tx.reason } };
      });
    });

    app.get('/grabpay/partner/v2/one-time-charge/:ptx/status', async (req, reply) => {
      if (!hmacOk(req, 'status', '')) return reply.code(401).send({ reason: 'unauthorized' });
      return guard('status', req, reply, async () => {
        const tx = this.txs.get((req.params as any).ptx);
        if (!tx || (req.query as any).currency !== tx.currency) return { code: 404, body: { reason: 'no_record_found' } };
        return {
          code: 200,
          body: { txID: tx.txID, status: tx.txStatus, txStatus: tx.txStatus, reason: tx.reason, paymentMethod: 'GPWALLET', oAuthCode: tx.txStatus === 'authorised' && tx.code && !tx.codeUsed ? tx.code : '' },
        };
      });
    });

    app.post('/grabpay/partner/v2/refund', async (req, reply) => {
      const tx = bearerOk(req, 'refund');
      if (!tx) return reply.code(401).send({ reason: 'unauthorized' });
      return guard('refund', req, reply, async () => {
        const b = JSON.parse(String(req.body ?? '{}'));
        const prev = this.refunds.get(b.partnerTxID);
        if (prev) return { code: 200, body: { txID: prev.txID, txStatus: prev.txStatus, reason: prev.reason, status: prev.txStatus } };
        if (b.merchantID !== this.creds.merchantId) return { code: 409, body: { reason: 'invalid_merchant' } };
        if (tx.txStatus !== 'success' || (b.originTxID && b.originTxID !== tx.txID) || b.partnerGroupTxID !== tx.partnerGroupTxID) return { code: 409, body: { reason: 'payment_not_found' } };
        const already = [...this.refunds.values()].filter((r) => r.origin === tx.partnerTxID && r.txStatus === 'success').reduce((s, r) => s + r.amount, 0);
        const ok = Number.isSafeInteger(b.amount) && b.amount > 0 && already + b.amount <= tx.amount && b.currency === tx.currency;
        const r: Refund = { partnerTxID: b.partnerTxID, origin: tx.partnerTxID, amount: b.amount, txID: randomBytes(16).toString('hex'), txStatus: ok ? 'success' : 'failed', reason: ok ? '' : 'exceed_payment_amount' };
        this.refunds.set(b.partnerTxID, r);
        return { code: 200, body: { txID: r.txID, txStatus: r.txStatus, reason: r.reason, status: r.txStatus } };
      });
    });

    app.get('/grabpay/partner/v2/refund/:ptx/status', async (req, reply) => {
      const tx = bearerOk(req, 'refund_status');
      if (!tx) return reply.code(401).send({ reason: 'unauthorized' });
      return guard('refund_status', req, reply, async () => {
        const r = this.refunds.get((req.params as any).ptx);
        if (!r) return { code: 404, body: { reason: 'no_record_found' } };
        return { code: 200, body: { txID: r.txID, txStatus: r.txStatus, reason: r.reason } };
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    this.baseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
    return this;
  }

  private reject(route: string, why: string): false {
    this.authFailures.push({ route, why });
    return false;
  }

  /** Follows an authorize URL like the user's browser would and returns the redirect back to Unyly. */
  async consentRedirect(authorizeUrl: string): Promise<URL> {
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    if (res.status !== 302) throw new Error(`authorize failed ${res.status} ${await res.text()}`);
    return new URL(String(res.headers.get('location')));
  }

  /** Signed webhook headers for a body sent to `path` on Unyly (Grab -> merchant). */
  signWebhook(path: string, body: string, opts: { secret?: string; date?: Date } = {}) {
    const date = (opts.date ?? new Date()).toUTCString();
    const ct = 'application/json; charset=utf-8';
    return { authorization: `${this.creds.partnerId}:${mockHmac(opts.secret ?? this.creds.partnerSecret, 'POST', ct, date, path, body)}`, date, 'content-type': ct };
  }

  async close() {
    await this.app.close();
  }
}

export async function startGrabPayMock(creds: MockCreds) {
  return new GrabPayMock(creds).start();
}
