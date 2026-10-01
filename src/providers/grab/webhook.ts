// GrabExpress tracking webhook: POST /webhooks/grab-express (URL given to GrabExpress Tech Support).
// Grab authenticates with a shared secret in the Authorization header (and optionally Authorization-Id);
// there is no signature. Processing is idempotent on (deliveryID, status, timestamp): the raw event is
// recorded once in grab_webhook_events and the order update goes through provider_events, which
// deduplicates again, so a retried or duplicated webhook never applies twice.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { sha256, safeEqual } from '../../domain/crypto.js';
import { reconcileAttempt } from '../../services/checkout.js';
import { ingestEvents } from '../../services/orders.js';
import { settleCheckout } from '../../services/live-payment.js';
import { mapGrabStatus } from './express.js';

export const GRAB_EXPRESS_WEBHOOK_PATH = '/webhooks/grab-express';

export const GrabExpressWebhookBody = z
  .object({
    deliveryID: z.string().min(1).max(128),
    merchantOrderID: z.string().max(128).nullish(),
    timestamp: z.coerce.number().int().positive(),
    status: z.string().min(1).max(40),
    failedReason: z.string().max(500).nullish(),
  })
  .passthrough(); // sender, recipient, driver, proof links: accepted but never stored
export type GrabExpressWebhook = z.infer<typeof GrabExpressWebhookBody>;

const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h) ?? '';
/** Constant-time compare that does not leak the secret's length (both sides hashed first). */
const same = (got: string, want: string) => safeEqual(sha256(got), sha256(want));

export function grabWebhookAuthorized(ctx: Ctx, headers: Record<string, string | string[] | undefined>): boolean {
  const ex = ctx.cfg.grab.express;
  if (!ex.webhookAuth) return false;
  let ok = same(header(headers.authorization), ex.webhookAuth);
  if (ex.webhookAuthId) ok = same(header(headers['authorization-id']), ex.webhookAuthId) && ok;
  return ok;
}

export function registerGrabExpressWebhook(scope: FastifyInstance, ctx: Ctx) {
  // Grab may send up to 33 webhooks per second in production from a few IPs: a generous per-IP limit.
  scope.post(GRAB_EXPRESS_WEBHOOK_PATH, { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!ctx.cfg.grab.express.enabled) return reply.code(404).send({ ok: false, error: 'not_enabled' });
    if (!grabWebhookAuthorized(ctx, req.headers as any)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    let json: unknown;
    try {
      json = JSON.parse(String(req.body ?? ''));
    } catch {
      return reply.code(400).send({ ok: false, error: 'invalid_json' });
    }
    const p = GrabExpressWebhookBody.safeParse(json);
    if (!p.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    await handleGrabExpressWebhook(ctx, p.data);
    return reply.code(204).send();
  });
}

export async function handleGrabExpressWebhook(ctx: Ctx, ev: GrabExpressWebhook): Promise<'applied' | 'unknown_delivery' | 'unknown_status'> {
  const m = mapGrabStatus(ev.status);
  const statusKey = m?.grab_status ?? ev.status.trim().toUpperCase().slice(0, 40);
  await ctx.db.query(
    `INSERT INTO grab_webhook_events (delivery_id, merchant_order_id, status, event_ts, failed_reason) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (delivery_id, status, event_ts) DO NOTHING`,
    [ev.deliveryID, ev.merchantOrderID ?? null, statusKey, ev.timestamp, ev.failedReason?.slice(0, 300) ?? null],
  );
  // Find our delivery: by deliveryID, else by merchantOrderID (a create whose response was lost).
  let row = (await ctx.db.query('SELECT * FROM grab_deliveries WHERE delivery_id = $1', [ev.deliveryID])).rows[0];
  if (!row && ev.merchantOrderID) {
    row = (await ctx.db.query('SELECT * FROM grab_deliveries WHERE merchant_order_id = $1', [ev.merchantOrderID])).rows[0];
    if (row && !row.delivery_id) {
      await ctx.db.query(
        `UPDATE grab_deliveries SET delivery_id = $2, order_ref = COALESCE(order_ref, $2),
           state = CASE WHEN state IN ('sending','unknown','not_found','not_sent') THEN 'created' ELSE state END, updated_at = now()
         WHERE merchant_order_id = $1 AND delivery_id IS NULL`,
        [row.merchant_order_id, ev.deliveryID],
      );
    }
  }
  if (!row) {
    if (ctx.cfg.env !== 'test') console.warn(JSON.stringify({ evt: 'grab_webhook_unknown_delivery', status: statusKey }));
    return 'unknown_delivery';
  }
  if (m) {
    await ctx.db.query(
      `UPDATE grab_deliveries SET last_status = $2, last_status_rank = $3, updated_at = now() WHERE merchant_order_id = $1 AND last_status_rank <= $3`,
      [row.merchant_order_id, m.grab_status, m.rank],
    );
  }
  // A create with an unknown outcome is resolved right away, so the order exists before its event applies.
  if (row.submission_id) {
    const a = (await ctx.db.query('SELECT status, error_code FROM submission_attempts WHERE id = $1', [row.submission_id])).rows[0];
    if (a && (a.status === 'unknown' || a.status === 'in_flight' || (a.status === 'rejected' && a.error_code === 'NOT_RECEIVED_BY_PROVIDER'))) {
      await reconcileAttempt(ctx, row.submission_id).catch((e) => console.error('[grab webhook] reconcile failed:', e?.message ?? e));
    }
  }
  if (!m) return 'unknown_status';
  const fresh = (await ctx.db.query('SELECT order_ref FROM grab_deliveries WHERE merchant_order_id = $1', [row.merchant_order_id])).rows[0];
  await ingestEvents(ctx, 'grab', [{
    event_id: `${ev.deliveryID}:${m.grab_status}:${ev.timestamp}`,
    order_ref: fresh?.order_ref ?? ev.deliveryID,
    sequence: m.rank,
    type: 'order.status_changed',
    status: m.status,
    payment_status: m.status === 'cancelled' ? 'unknown' : 'pending',
    occurred_at: new Date(ev.timestamp * 1000).toISOString(),
  }]);
  // Paid in advance with GrabPay: a delivery cancelled or failed before pickup is refunded right away.
  if (row.submission_id && (m.status === 'cancelled' || m.status === 'failed' || m.status === 'delivered')) {
    const a = (await ctx.db.query('SELECT checkout_id FROM submission_attempts WHERE id = $1', [row.submission_id])).rows[0];
    if (a) await settleCheckout(ctx, a.checkout_id);
  }
  return 'applied';
}
