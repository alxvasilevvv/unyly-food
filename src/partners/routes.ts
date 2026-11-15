// Signed Partner API: /partner/v1/*. JSON in, JSON out. See docs/partner-api.md and /partner/v1/openapi.json.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { UUID_RE } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import { addAddress, deleteAddress, listAddresses, maskedAddress } from '../services/users.js';
import { verifyPartnerRequest } from './auth.js';
import { catalogFor } from './catalog.js';
import type { PartnerConfig } from './config.js';
import {
  cancellationCard, checkoutCard, confirmCancelPartner, confirmCheckout, declineCheckoutPartner, grabLinkStatus, listOrdersPartner, orderCard,
  prepareCancelPartner, runTool, startGrabLink, unlinkGrab,
} from './core.js';
import { openApiDocument } from './openapi.js';
import { PARTNER_INSTRUCTIONS, partnerToolDefs } from './tools.js';
import { checkExternalId, deletePartnerUser, loadPartnerUser, PartnerUser, upsertPartnerUser } from './users.js';
import { listPartnerEventsFor } from './webhooks.js';

type Req = FastifyRequest & { partner?: PartnerConfig; jsonBody?: any };

function sendError(reply: FastifyReply, e: unknown) {
  const err = isDomainError(e) ? e : new DomainError('INTERNAL', 'Unexpected error. Nothing irreversible was done unless a status call says otherwise.');
  if (!isDomainError(e)) console.error('[partner]', e);
  return reply.code(err.httpStatus).header('cache-control', 'no-store').send({
    ok: false, error: { code: err.code, message: err.message, details: err.details, user_action: err.userAction },
  });
}

const ok = (reply: FastifyReply, data: Record<string, unknown>, status = 200) => reply.code(status).header('cache-control', 'no-store').send({ ok: true, ...data });

/** Errors that have no DomainError code (HTTP-level problems) in the same envelope as every other partner error. */
const sendHttpError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).header('cache-control', 'no-store').send({ ok: false, error: { code, message } });

const AUTH_FAIL_MAX = 300;
const AUTH_FAIL_WINDOW_MS = 60_000;
const AUTH_FAIL_KEYS = 20_000;

/**
 * Failed signature checks per client address (fixed one-minute window, in memory, no database work). The
 * per-user limits only start after a valid signature, so without this an unsigned flood would never be
 * limited at all.
 *
 * Only failures are stored and only failures are refused: a request with a valid signature is never turned
 * away here, so a flood of bad signatures that shares an address with the partner's servers (a NAT, a proxy
 * that is not in TRUST_PROXY) cannot lock the partner out. Memory is bounded: at most `maxKeys` addresses are
 * remembered; when full, expired entries go first, then addresses that are not blocked, then the oldest.
 */
export function authFailureLimiter(max = AUTH_FAIL_MAX, windowMs = AUTH_FAIL_WINDOW_MS, maxKeys = AUTH_FAIL_KEYS) {
  const seen = new Map<string, { n: number; reset: number }>();
  const live = (key: string, now: number) => {
    const e = seen.get(key);
    if (e && e.reset <= now) {
      seen.delete(key);
      return undefined;
    }
    return e;
  };
  const makeRoom = (now: number) => {
    for (const [k, v] of seen) if (v.reset <= now) seen.delete(k);
    const target = Math.floor(maxKeys * 0.9);
    if (seen.size >= maxKeys) for (const [k, v] of seen) {
      if (seen.size <= target) break;
      if (v.n < max) seen.delete(k);
    }
    if (seen.size >= maxKeys) for (const k of seen.keys()) {
      if (seen.size <= target) break;
      seen.delete(k);
    }
  };
  return {
    /** Records one failed check; true when this address is over the limit (answer 429 instead of 401). */
    fail(key: string, now = Date.now()): boolean {
      let e = live(key, now);
      if (!e) {
        if (seen.size >= maxKeys) makeRoom(now);
        e = { n: 0, reset: now + windowMs };
        seen.set(key, e);
      }
      e.n += 1;
      return e.n > max;
    },
    size: () => seen.size,
  };
}

function uuidParam(v: unknown, name: string): string {
  const s = String(v ?? '');
  if (!UUID_RE.test(s)) throw new DomainError('NOT_FOUND', `${name} not found`);
  return s;
}

/** `ipKeyOf`: how a client address becomes a limiter key (the app groups IPv6 by /64, like its other limits). */
export async function registerPartnerRoutes(app: FastifyInstance, ctx: Ctx, ipKeyOf: (ip: string) => string = (ip) => ip) {
  // Public: the API description (no secrets in it).
  app.get('/partner/v1/openapi.json', async (_req, reply) => reply.header('cache-control', 'public, max-age=300').send(openApiDocument(ctx)));

  await app.register(async (scope) => {
    // Raw body: the signature covers the exact bytes.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));

    const authFailures = authFailureLimiter();
    scope.addHook('preHandler', async (req: Req, reply) => {
      try {
        const raw = typeof req.body === 'string' ? req.body : '';
        try {
          req.partner = await verifyPartnerRequest(ctx, { method: req.method, url: req.url, headers: req.headers as any, rawBody: raw });
        } catch (e) {
          // A failed check costs no database work. Too many of them from one address: 429 instead of 401.
          // A valid signature is never refused here, whatever else arrives from the same address.
          if (isDomainError(e) && e.code === 'PARTNER_AUTH_FAILED' && authFailures.fail(ipKeyOf(req.ip))) {
            throw new DomainError('RATE_LIMITED', 'Too many requests with a missing or invalid signature. Retry in a minute.');
          }
          throw e;
        }
        if (raw) {
          const ct = String(req.headers['content-type'] ?? '');
          if (!ct.includes('application/json')) throw new DomainError('VALIDATION_FAILED', 'Content-Type must be application/json');
          try {
            req.jsonBody = JSON.parse(raw);
          } catch {
            throw new DomainError('VALIDATION_FAILED', 'Body is not valid JSON');
          }
          if (!req.jsonBody || typeof req.jsonBody !== 'object' || Array.isArray(req.jsonBody)) throw new DomainError('VALIDATION_FAILED', 'Body must be a JSON object');
        } else req.jsonBody = {};
      } catch (e) {
        return sendError(reply, e);
      }
    });

    const route = (fn: (req: Req, reply: FastifyReply) => Promise<unknown>) => async (req: Req, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (e) {
        return sendError(reply, e);
      }
    };
    // Errors raised outside the handlers (rate limit, body too large) use the same envelope as every other partner error.
    scope.setErrorHandler((err: any, _req, reply) => {
      if (err?.statusCode === 429) return sendError(reply, new DomainError('RATE_LIMITED', 'Too many requests. Retry after a short pause.'));
      if (err?.statusCode === 413) return sendHttpError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large: the limit is 64 KB.');
      if (!isDomainError(err) && err?.statusCode >= 400 && err?.statusCode < 500) return sendError(reply, new DomainError('VALIDATION_FAILED', String(err.message ?? 'Bad request')));
      return sendError(reply, err);
    });
    const user = (req: Req): Promise<PartnerUser> => loadPartnerUser(ctx, req.partner!, String((req.params as any).uid ?? ''));
    // Per partner user, after the signature check: one busy user cannot use up the budget of the others.
    const userKey = (req: FastifyRequest) => `partner:${(req as Req).partner?.id ?? 'anon'}:${String((req.params as any)?.uid ?? '-')}`;
    const rl = { config: { rateLimit: { hook: 'preHandler' as const, max: 600, timeWindow: '1 minute', keyGenerator: userKey } } };

    scope.get('/partner/v1/ping', rl, route(async (req, reply) => ok(reply, { partner: req.partner!.id, mode: req.partner!.mode, time: ctx.clock.now().toISOString() })));

    scope.get('/partner/v1/catalog', rl, route(async (req, reply) => {
      const lang = String((req.query as any)?.lang ?? 'en');
      return ok(reply, catalogFor(lang === 'ru' || lang === 'th' ? lang : 'en'));
    }));

    scope.get('/partner/v1/tools', rl, route(async (req, reply) => ok(reply, { instructions: PARTNER_INSTRUCTIONS, tools: await partnerToolDefs(ctx, req.partner!) })));

    // ---- users
    scope.put('/partner/v1/users/:uid', rl, route(async (req, reply) => {
      const u = await upsertPartnerUser(ctx, req.partner!, String((req.params as any).uid), req.jsonBody ?? {});
      // A user created by this request cannot have a Grab link yet.
      const grab = u.created ? { linked: false, linked_at: null, simulated: false } : await grabLinkStatus(ctx, u);
      return ok(reply, { user: publicUser(u), grab }, u.created ? 201 : 200);
    }));
    scope.get('/partner/v1/users/:uid', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, { user: publicUser(u), grab: await grabLinkStatus(ctx, u) });
    }));
    scope.delete('/partner/v1/users/:uid', rl, route(async (req, reply) => {
      await deletePartnerUser(ctx, req.partner!, String((req.params as any).uid));
      return ok(reply, { deleted: true });
    }));

    // ---- saved places (delivery addresses and ride shortcuts like Home, Work)
    scope.get('/partner/v1/users/:uid/places', rl, route(async (req, reply) => {
      const u = await user(req);
      const list = await listAddresses(ctx.db, u.user_id);
      return ok(reply, { places: list.map((a) => ({ place_id: a.id, label: a.label, is_default: a.is_default, ...maskedAddress(a) })) });
    }));
    scope.post('/partner/v1/users/:uid/places', rl, route(async (req, reply) => {
      const u = await user(req);
      const b = req.jsonBody && typeof req.jsonBody === 'object' && !Array.isArray(req.jsonBody) ? req.jsonBody : {};
      const missing = ['label', 'line1', 'district', 'city'].filter((k) => typeof b[k] !== 'string' || !b[k].trim());
      const wrong = ['country', 'instructions'].filter((k) => b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string');
      const hasCoords = b.latitude !== undefined || b.longitude !== undefined;
      if (hasCoords && !(Number.isFinite(b.latitude) && Number.isFinite(b.longitude) && Math.abs(b.latitude) <= 90 && Math.abs(b.longitude) <= 180)) wrong.push('latitude', 'longitude');
      if (missing.length || wrong.length) {
        throw new DomainError('VALIDATION_FAILED', `Place needs label, line1, district and city as text${hasCoords ? '; latitude and longitude as numbers' : ''}. Check: ${[...missing, ...wrong].join(', ')}.`, { fields: [...missing, ...wrong] });
      }
      let a;
      try {
        a = await addAddress(ctx, u.user_id, {
          label: b.label, line1: b.line1, district: b.district, city: b.city, country: b.country ?? u.region, instructions: b.instructions ?? undefined,
          coordinates: hasCoords ? `${Number(b.latitude).toFixed(6)}, ${Number(b.longitude).toFixed(6)}` : undefined,
        }, b.is_default !== false);
      } catch (e) {
        // An incomplete address (no house number, unknown country) is the caller's input error here.
        if (isDomainError(e) && e.code === 'ADDRESS_AMBIGUOUS') throw new DomainError('VALIDATION_FAILED', `${e.message}: ${((e.details?.fields as string[]) ?? []).join(', ')}`, e.details);
        throw e;
      }
      return ok(reply, { place: { place_id: a.id, label: a.label, is_default: a.is_default, ...maskedAddress(a) } }, 201);
    }));
    scope.delete('/partner/v1/users/:uid/places/:pid', rl, route(async (req, reply) => {
      const u = await user(req);
      await deleteAddress(ctx, u.user_id, uuidParam((req.params as any).pid, 'Place'));
      return ok(reply, { deleted: true });
    }));

    // ---- tools (same catalog as the MCP server) with a card for each result
    scope.post('/partner/v1/users/:uid/tools/:name', { config: { rateLimit: { hook: 'preHandler' as const, max: 120, timeWindow: '1 minute', keyGenerator: userKey } } }, route(async (req, reply) => {
      const u = await user(req);
      const name = String((req.params as any).name ?? '');
      const args = req.jsonBody?.arguments ?? {};
      const r = await runTool(ctx, req.partner!, u, name, args);
      return reply.code(r.ok ? 200 : 422).header('cache-control', 'no-store').send(r);
    }));

    // ---- checkout confirmation (the user's tap / Face ID in the partner app)
    scope.get('/partner/v1/users/:uid/checkouts/:cid', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, { card: await checkoutCard(ctx, req.partner!, u, uuidParam((req.params as any).cid, 'Checkout')) });
    }));
    scope.post('/partner/v1/users/:uid/checkouts/:cid/confirm', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, await confirmCheckout(ctx, req.partner!, u, uuidParam((req.params as any).cid, 'Checkout'), req.jsonBody ?? {}));
    }));
    scope.post('/partner/v1/users/:uid/checkouts/:cid/decline', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, await declineCheckoutPartner(ctx, req.partner!, u, uuidParam((req.params as any).cid, 'Checkout')));
    }));

    // ---- orders
    scope.get('/partner/v1/users/:uid/orders', rl, route(async (req, reply) => {
      const u = await user(req);
      const limit = Math.min(Math.max(Number((req.query as any)?.limit ?? 10) || 10, 1), 50);
      return ok(reply, await listOrdersPartner(ctx, req.partner!, u, limit) as any);
    }));
    scope.get('/partner/v1/users/:uid/orders/:oid', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, { card: await orderCard(ctx, req.partner!, u, uuidParam((req.params as any).oid, 'Order'), { refresh: true }) });
    }));
    scope.post('/partner/v1/users/:uid/orders/:oid/cancel', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, await prepareCancelPartner(ctx, req.partner!, u, uuidParam((req.params as any).oid, 'Order')));
    }));
    scope.get('/partner/v1/users/:uid/cancellations/:xid', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, { card: await cancellationCard(ctx, req.partner!, u, uuidParam((req.params as any).xid, 'Cancellation')) });
    }));
    scope.post('/partner/v1/users/:uid/cancellations/:xid/confirm', rl, route(async (req, reply) => {
      const u = await user(req);
      return ok(reply, await confirmCancelPartner(ctx, req.partner!, u, uuidParam((req.params as any).xid, 'Cancellation'), req.jsonBody ?? {}));
    }));

    // ---- events (the same events that are sent by webhook; for polling or recovery)
    scope.get('/partner/v1/users/:uid/events', rl, route(async (req, reply) => {
      // The polling path: the user check and the events in one statement.
      const ext = String((req.params as any).uid ?? '');
      checkExternalId(ext);
      const after = Math.max(Number((req.query as any)?.after ?? 0) || 0, 0);
      const events = await listPartnerEventsFor(ctx, req.partner!.id, ext, after);
      if (!events) throw new DomainError('NOT_FOUND', 'Unknown user. Create it first with PUT /partner/v1/users/{user_id}.');
      return ok(reply, { events });
    }));

    // ---- Grab account link
    scope.get('/partner/v1/users/:uid/grab', rl, route(async (req, reply) => ok(reply, { grab: await grabLinkStatus(ctx, await user(req)) })));
    scope.post('/partner/v1/users/:uid/grab/link', rl, route(async (req, reply) => ok(reply, await startGrabLink(ctx, req.partner!, await user(req)))));
    scope.delete('/partner/v1/users/:uid/grab', rl, route(async (req, reply) => ok(reply, { grab: await unlinkGrab(ctx, req.partner!, await user(req)) })));

    // Anything else under /partner/v1 (unknown path, wrong method, trailing slash): the JSON 404 after the
    // signature check, never the website's HTML page. Unsigned callers get the same 401 as everywhere else.
    const noRoute = route(async (req) => {
      throw new DomainError('NOT_FOUND', `No such endpoint: ${req.method} ${req.url.split('?')[0].slice(0, 200)}`);
    });
    scope.all('/partner/v1', noRoute);
    scope.all('/partner/v1/*', noRoute);
  });
}

function publicUser(u: PartnerUser) {
  return { user_id: u.external_user_id, display_name: u.display_name, locale: u.locale, region: u.region, mode: u.mode, created: u.created };
}
