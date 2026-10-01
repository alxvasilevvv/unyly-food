// Mock of the Grab partner APIs used by Unyly Live (GrabID client-credentials token, GrabExpress,
// Partner Farefeed), following the documented request and response shapes in docs/grab-api-research.md.
// Runs on 127.0.0.1 with a random port; tests point GRAB_API_BASE at it. No real network calls.
import Fastify, { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

export const MOCK_CLIENT_ID = 'test-client-id';
export const MOCK_CLIENT_SECRET = 'test-client-secret-not-real';

export interface MockDelivery {
  deliveryID: string;
  merchantOrderID: string;
  status: string;
  body: any;
  amount: number;
}

export interface GrabMock {
  url: string;
  app: FastifyInstance;
  deliveries: Map<string, MockDelivery>;
  /** Every API call (not token calls): op name plus the parsed body. */
  calls: { op: string; body?: any; auth?: string }[];
  tokenRequests: { scope: string }[];
  knobs: {
    tokenTtlSec: number;
    quoteAmount: number;
    /** Quotes answer with this HTTP error instead (e.g. 400 "Package over weight limit"). */
    quoteError?: { status: number; message: string };
    /** Create stores the delivery, then answers only after this many ms (the client times out first). */
    createDelayMs?: number;
    /** Create times out without storing anything (the request never reached Grab's DB). */
    createDropMs?: number;
    createError?: { status: number; message: string };
    /** DELETE /v1/deliveries/{id} answers 409 even before pickup. */
    cancelConflict?: boolean;
    farefeedNotFound?: boolean;
    /** Extra Farefeed service with a non-Grab deep link (must be dropped by Unyly). */
    farefeedEvilLink?: boolean;
  };
  /** Revoke every issued token: the next API call gets 401 (simulates expiry or rotation). */
  expireTokens(): void;
  setStatus(deliveryID: string, status: string): void;
  ops(op: string): { op: string; body?: any }[];
  /** POST a tracking webhook to Unyly as Grab would. */
  emitWebhook(target: string, payload: Record<string, unknown>, headers: Record<string, string>): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

const CANCELLABLE = new Set(['QUEUEING', 'ALLOCATING', 'PENDING_PICKUP', 'PICKING_UP']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startGrabMock(): Promise<GrabMock> {
  const app = Fastify({ logger: false });
  const valid = new Set<string>();
  let n = 0;
  const deliveries = new Map<string, MockDelivery>();
  const calls: GrabMock['calls'] = [];
  const tokenRequests: GrabMock['tokenRequests'] = [];
  const knobs: GrabMock['knobs'] = { tokenTtlSec: 3600, quoteAmount: 55 };

  app.post('/grabid/v1/oauth2/token', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    tokenRequests.push({ scope: b.scope });
    if (b.client_id !== MOCK_CLIENT_ID || b.client_secret !== MOCK_CLIENT_SECRET || b.grant_type !== 'client_credentials') {
      return reply.code(401).send({ error: 'invalid_client', error_description: 'bad client' });
    }
    if (!['grab_express.partner_deliveries', 'ride.estimate'].includes(b.scope)) return reply.code(400).send({ error: 'invalid_scope' });
    const token = `mock-token-${++n}-${randomBytes(6).toString('hex')}`;
    valid.add(token);
    return { access_token: token, token_type: 'Bearer', expires_in: knobs.tokenTtlSec };
  });

  // Bearer check for everything except the token endpoint and the helper below.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/grabid/')) return;
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m || !valid.has(m[1])) return reply.code(401).send({ message: 'Unauthorized' });
    reply.header('x-grabkit-grab-requestid', `req-${randomBytes(4).toString('hex')}`);
  });

  const E = '/grab-express-sandbox';
  const loc = (x: any) => x && typeof x.address === 'string' && typeof x.coordinates?.latitude === 'number' && typeof x.coordinates?.longitude === 'number';
  const quoteFor = (b: any) => {
    const now = Date.now();
    return {
      service: { id: 0, type: b.serviceType ?? 'INSTANT', name: 'Instant' },
      currency: { code: 'THB', symbol: '฿', exponent: 2 },
      amount: knobs.quoteAmount,
      estimatedTimeline: { pickup: new Date(now + 15 * 60000).toISOString(), dropoff: new Date(now + 40 * 60000).toISOString() },
      distance: 5300,
    };
  };

  app.post(`${E}/v1/deliveries/quotes`, async (req, reply) => {
    const b = req.body as any;
    calls.push({ op: 'quotes', body: b });
    if (!loc(b?.origin) || !loc(b?.destination) || !Array.isArray(b?.packages) || !b.packages.length) return reply.code(400).send({ message: 'Invalid parameters' });
    if (knobs.quoteError) return reply.code(knobs.quoteError.status).send({ message: knobs.quoteError.message });
    return { quotes: [quoteFor(b)], origin: b.origin, destination: b.destination, packages: b.packages };
  });

  app.post(`${E}/v1/deliveries`, async (req, reply) => {
    const b = req.body as any;
    calls.push({ op: 'create', body: b });
    if (!b?.merchantOrderID || !b?.serviceType || !b?.sender?.firstName || !b?.recipient?.firstName || !loc(b?.origin) || !loc(b?.destination)) {
      return reply.code(400).send({ message: 'Invalid parameters' });
    }
    if (knobs.createError) return reply.code(knobs.createError.status).send({ message: knobs.createError.message });
    if (knobs.createDropMs) {
      await sleep(knobs.createDropMs);
      return reply.code(504).send({ message: 'Gateway timeout' });
    }
    const id = `IN-2-${randomBytes(9).toString('hex').toUpperCase()}`;
    const q = quoteFor(b);
    deliveries.set(id, { deliveryID: id, merchantOrderID: b.merchantOrderID, status: 'ALLOCATING', body: b, amount: q.amount });
    if (knobs.createDelayMs) await sleep(knobs.createDelayMs);
    return {
      deliveryID: id, merchantOrderID: b.merchantOrderID, paymentMethod: b.paymentMethod ?? 'CASHLESS', payer: b.payer ?? 'SENDER', quote: q,
      sender: b.sender, recipient: b.recipient, status: 'ALLOCATING', trackingURL: '', courier: null, timeline: null, schedule: null,
      cashOnDelivery: null, invoiceNo: '', pickupPin: '1234', advanceInfo: null,
    };
  });

  const details = (d: MockDelivery) => ({
    deliveryID: d.deliveryID, merchantOrderID: d.merchantOrderID, paymentMethod: d.body.paymentMethod, payer: d.body.payer, status: d.status,
    quote: quoteFor(d.body), trackingURL: 'https://express.grab.com/track/mock', courier: null, timeline: {}, advanceInfo: null,
  });

  app.get(`${E}/v1/deliveries/:id`, async (req, reply) => {
    calls.push({ op: 'get' });
    const d = deliveries.get((req.params as any).id);
    if (!d) return reply.code(404).send({ message: 'Not found' });
    return details(d);
  });

  app.delete(`${E}/v1/deliveries/:id`, async (req, reply) => {
    calls.push({ op: 'cancel' });
    const d = deliveries.get((req.params as any).id);
    if (!d) return reply.code(404).send({ message: 'Not found' });
    if (knobs.cancelConflict || !CANCELLABLE.has(d.status)) return reply.code(409).send({ message: 'Cannot cancel' });
    d.status = 'CANCELED';
    return reply.code(204).send();
  });

  app.delete(`${E}/v1/merchant/deliveries/:mid`, async (req, reply) => {
    calls.push({ op: 'cancel_by_merchant' });
    const mine = [...deliveries.values()].filter((d) => d.merchantOrderID === (req.params as any).mid);
    if (!mine.length) return reply.code(404).send({ message: 'Not found' });
    if (mine.some((d) => !CANCELLABLE.has(d.status))) return reply.code(409).send({ message: 'Cannot cancel' });
    for (const d of mine) d.status = 'CANCELED';
    return reply.code(204).send();
  });

  app.post('/farefeed/v1/estimate', async (req, reply) => {
    const b = req.body as any;
    calls.push({ op: 'farefeed', body: b });
    const ok = (p: any) => p && typeof p.latitude === 'number' && typeof p.longitude === 'number' && typeof p.address === 'string';
    if (!ok(b?.pickUp) || !ok(b?.dropOff)) return reply.code(400).send({ message: 'missing or invalid lat/lng' });
    if (knobs.farefeedNotFound) return reply.code(404).send({ message: 'no service' });
    const services: any[] = [
      {
        serviceID: 302, serviceName: 'JustGrab', eta: 4, fare: { currency: 'THB', minFare: 150, maxFare: 190 },
        deepLink: 'https://grab.onelink.me/2695613898?af_dp=grab%3A%2F%2Fopen%3FscreenType%3DBOOKING%26taxiTypeId%3D302',
        directDeepLink: 'grab://open?screenType=BOOKING&taxiTypeId=302', iconLink: 'https://example.invalid/icon.png', surgeNotice: 'NONE',
      },
      {
        serviceID: 227, serviceName: 'GrabShare', eta: 7, fare: { currency: 'THB', minFare: 98.5, maxFare: 120 },
        deepLink: 'https://grab.onelink.me/2695613898?af_dp=grab%3A%2F%2Fopen%3FtaxiTypeId%3D227', directDeepLink: 'grab://open?screenType=BOOKING&taxiTypeId=227', surgeNotice: 'LOW_SURGE',
      },
    ];
    if (knobs.farefeedEvilLink) {
      services.push({ serviceID: 999, serviceName: 'Odd', eta: 3, fare: { currency: 'THB', minFare: 10, maxFare: 20 }, deepLink: 'https://evil.example/phish', directDeepLink: 'javascript:alert(1)', surgeNotice: 'WEIRD' });
    }
    return { services };
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    app, deliveries, calls, tokenRequests, knobs,
    expireTokens: () => valid.clear(),
    setStatus: (id, s) => {
      const d = deliveries.get(id);
      if (!d) throw new Error(`no delivery ${id}`);
      d.status = s;
    },
    ops: (op) => calls.filter((c) => c.op === op),
    async emitWebhook(target, payload, headers) {
      const r = await fetch(`${target}/webhooks/grab-express`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
      return { status: r.status, body: await r.text() };
    },
    close: () => app.close(),
  };
}

/** Env for loadGrabConfig pointing at the mock. */
export function mockGrabEnv(mock: GrabMock, extra: Record<string, string> = {}): Record<string, string> {
  return {
    GRAB_ENV: 'sandbox',
    GRAB_API_BASE: mock.url,
    GRAB_CLIENT_ID: MOCK_CLIENT_ID,
    GRAB_CLIENT_SECRET: MOCK_CLIENT_SECRET,
    GRAB_EXPRESS_WEBHOOK_AUTH: 'whsec-test-0123456789abcdef0123456789abcdef',
    GRAB_HTTP_TIMEOUT_MS: '1000',
    GRAB_RPS: '100',
    ...extra,
  };
}
