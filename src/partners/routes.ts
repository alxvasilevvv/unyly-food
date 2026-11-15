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
import { deletePartnerUser, loadPartnerUser, PartnerUser, upsertPartnerUser } from './users.js';
import { listPartnerEvents } from './webhooks.js';

type Req = FastifyRequest & { partner?: PartnerConfig; jsonBody?: any };

function sendError(reply: FastifyReply, e: unknown) {
  const err = isDomainError(e) ? e : new DomainError('INTERNAL', 'Unexpected error. Nothing irreversible was done unless a status call says otherwise.');
  if (!isDomainError(e)) console.error('[partner]', e);
  return reply.code(err.httpStatus).header('cache-control', 'no-store').send({
    ok: false, error: { code: err.code, message: err.message, details: err.details, user_action: err.userAction },
  });
}

const ok = (reply: FastifyReply, data: Record<string, unknown>, status = 200) => reply.code(status).header('cache-control', 'no-store').send({ ok: true, ...data });

function uuidParam(v: unknown, name: string): string {
  const s = String(v ?? '');
  if (!UUID_RE.test(s)) throw new DomainError('NOT_FOUND', `${name} not found`);
  return s;
}

export async function registerPartnerRoutes(app: FastifyInstance, ctx: Ctx) {
  // Public: the API description (no secrets in it).
  app.get('/partner/v1/openapi.json', async (_req, reply) => reply.header('cache-control', 'public, max-age=300').send(openApiDocument(ctx)));

  await app.register(async (scope) => {
    // Raw body: the signature covers the exact bytes.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));

    scope.addHook('preHandler', async (req: Req, reply) => {
      try {
        const raw = typeof req.body === 'string' ? req.body : '';
        req.partner = await verifyPartnerRequest(ctx, { method: req.method, url: req.url, headers: req.headers as any, rawBody: raw });
        if (raw) {
          const ct = String(req.headers['content-type'] ?? '');
          if (!ct.includes('application/json')) throw new DomainError('VALIDATION_FAILED', 'Content-Type must be application/json');
          try {
            req.jsonBody = JSON.parse(raw);
          } catch {
            throw new DomainError('VALIDATION_FAILED', 'Body is not valid JSON');
          }
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
      return ok(reply, { user: publicUser(u), grab: await grabLinkStatus(ctx, u) }, u.created ? 201 : 200);
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
      const b = req.jsonBody ?? {};
      const a = await addAddress(ctx, u.user_id, {
        label: b.label, line1: b.line1, district: b.district, city: b.city, country: b.country ?? u.region, instructions: b.instructions,
        latitude: b.latitude, longitude: b.longitude,
      } as any, b.is_default !== false);
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
      const u = await user(req);
      const after = Math.max(Number((req.query as any)?.after ?? 0) || 0, 0);
      return ok(reply, { events: await listPartnerEvents(ctx, u.user_id, after) });
    }));

    // ---- Grab account link
    scope.get('/partner/v1/users/:uid/grab', rl, route(async (req, reply) => ok(reply, { grab: await grabLinkStatus(ctx, await user(req)) })));
    scope.post('/partner/v1/users/:uid/grab/link', rl, route(async (req, reply) => ok(reply, await startGrabLink(ctx, req.partner!, await user(req)))));
    scope.delete('/partner/v1/users/:uid/grab', rl, route(async (req, reply) => ok(reply, { grab: await unlinkGrab(ctx, req.partner!, await user(req)) })));
  });
}

function publicUser(u: PartnerUser) {
  return { user_id: u.external_user_id, display_name: u.display_name, locale: u.locale, region: u.region, mode: u.mode, created: u.created };
}
