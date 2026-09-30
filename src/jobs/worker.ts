import type { Ctx } from '../context.js';
import { reconcileAttempt } from '../services/checkout.js';
import { deleteAccount } from '../services/users.js';
import { ingestWebhook, processPendingEvents, reconcileCancellations } from '../services/orders.js';

/**
 * In-process background jobs. Every job is idempotent and uses row-level claims, so running
 * several app instances is safe. No external queue is needed at this scale.
 */
export async function runJobsOnce(ctx: Ctx) {
  const out = { reconciled: 0, demoEvents: 0, events: 0, stalePolled: 0, expired: 0 };
  // 1) Submissions with unknown outcome, or stuck in flight (e.g. after a crash/restart).
  const due = await ctx.db.query(
    `SELECT id FROM submission_attempts
     WHERE (status IN ('in_flight','unknown') OR (status = 'rejected' AND error_code = 'NOT_RECEIVED_BY_PROVIDER'))
       AND next_reconcile_at <= $1 ORDER BY next_reconcile_at LIMIT 50`,
    [ctx.clock.now()],
  );
  for (const { id } of due.rows) {
    await reconcileAttempt(ctx, id);
    out.reconciled++;
  }
  // 2) Demo simulator emits signed webhooks through the same verification + ingestion path.
  out.demoEvents = await ctx.providers.demo.tick(async (raw, headers) => {
    await ingestWebhook(ctx, 'demo', raw, headers);
  });
  // 3) Events that arrived before their order row existed.
  out.events = await processPendingEvents(ctx);
  // 4) Cancellations with unknown outcome.
  await reconcileCancellations(ctx);
  // 5) Expire stale confirmations (display hygiene; validity is always re-checked on use).
  const ex = await ctx.db.query(
    `UPDATE checkouts SET status='expired', invalid_reason='EXPIRED' WHERE status IN ('awaiting_user','approved') AND expires_at <= $1`,
    [ctx.clock.now()],
  );
  out.expired = ex.rowCount;
  // 6) Data retention: login codes and expired sessions/tokens.
  await ctx.db.query(`DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`);
  await ctx.db.query(`DELETE FROM web_sessions WHERE expires_at < now()`);
  await ctx.db.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`);
  await ctx.db.query(`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'`);
  // 7) Guest demo accounts from /try live for 24 hours.
  const guests = await ctx.db.query(`SELECT id FROM users WHERE is_guest AND created_at < now() - interval '24 hours' ORDER BY created_at LIMIT 25`);
  for (const { id } of guests.rows) await deleteAccount(ctx, id);
  return out;
}

export function startJobs(ctx: Ctx, intervalMs = 5000) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runJobsOnce(ctx);
    } catch (e: any) {
      console.error('[jobs] error', e?.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
