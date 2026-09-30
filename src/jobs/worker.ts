import type { Ctx } from '../context.js';
import { reconcileAttempt } from '../services/checkout.js';
import { deleteAccount } from '../services/users.js';
import { ingestWebhook, processPendingEvents, reconcileCancellations } from '../services/orders.js';

/**
 * In-process background jobs. No external queue is needed at this scale.
 *
 * Multi-instance safety: every step runs under its own transaction-scoped advisory lock
 * (pg_try_advisory_xact_lock(JOB_LOCK_NS, <step key>)). If another instance already holds the lock
 * for that step, this instance skips the step for this tick. Transaction-scoped locks work behind
 * transaction-mode poolers (Supavisor :6543), unlike session locks. Inside a step, rows are claimed
 * with conditional UPDATEs (`... WHERE status IN (...)`) and, for provider events, `FOR UPDATE SKIP
 * LOCKED`, so a step that overlaps with request-path work stays idempotent.
 *
 * The lock transaction holds one pool connection while the step uses others, so the pool needs
 * at least 2 connections when RUN_JOBS is on (the default pool is 10).
 *
 * Isolation: each step has its own try/catch, and rows inside the reconcile and cleanup loops are
 * processed one by one with their own try/catch (failed submission reconciles are backed off), so
 * one bad row or failing step cannot block expiry, retention or guest deletion.
 */
const JOB_LOCK_NS = 727275;
const STEP_KEYS = {
  reconcile_submissions: 1,
  demo_tick: 2,
  pending_events: 3,
  reconcile_cancellations: 4,
  expire_checkouts: 5,
  retention: 6,
  guest_cleanup: 7,
} as const;
type StepName = keyof typeof STEP_KEYS;

export interface JobRunResult {
  reconciled: number;
  demoEvents: number;
  events: number;
  stalePolled: number;
  expired: number;
  guestsDeleted: number;
  retention: Record<string, number>;
  skipped: StepName[];
  failed: StepName[];
}

async function step(ctx: Ctx, out: JobRunResult, name: StepName, fn: () => Promise<void>) {
  try {
    const ran = await ctx.db.tx(async (q) => {
      const got = (await q.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1, $2) AS ok', [JOB_LOCK_NS, STEP_KEYS[name]])).rows[0]?.ok;
      if (!got) return false;
      await fn();
      return true;
    });
    if (!ran) out.skipped.push(name);
  } catch (e: any) {
    out.failed.push(name);
    console.error(`[jobs] step ${name} failed:`, e?.message ?? e);
  }
}

/** Retention rules. Each statement runs on its own so one failure does not stop the others. */
const RETENTION: [string, string][] = [
  ['login_codes', `DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`],
  ['web_sessions', `DELETE FROM web_sessions WHERE expires_at < now()`],
  ['oauth_codes', `DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`],
  ['oauth_tokens', `DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'`],
  // webauthn_challenges has no created_at; challenges live minutes, so expiry + 1 day is "older than 1 day".
  ['webauthn_challenges', `DELETE FROM webauthn_challenges WHERE expires_at < now() - interval '1 day'`],
  // Processed provider events only; unprocessed ones are still handled (and parked) by processPendingEvents.
  // A duplicate delivery arriving after this is harmless: applyEvent ignores sequences <= orders.status_version.
  ['provider_events', `DELETE FROM provider_events WHERE processed_at IS NOT NULL AND processed_at < now() - interval '30 days'`],
  // Demo simulator rows: only terminal ones whose final webhook was emitted, and only when no order that points at them (orders.provider_order_ref
  // is a text copy, not an FK) is still non-terminal or has an open cancellation request.
  ['demo_sim_orders', `DELETE FROM demo_sim_orders d
     WHERE d.status IN ('delivered','cancelled') AND d.last_emitted_seq >= d.sequence
       AND COALESCE(d.cancelled_at, d.accepted_at) < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.provider = 'demo' AND o.provider_order_ref = d.ref
                         AND (o.fulfillment_status NOT IN ('delivered','cancelled','failed')
                              OR EXISTS (SELECT 1 FROM cancellation_requests c WHERE c.order_id = o.id
                                           AND c.status IN ('awaiting_user','approved','executing','unknown'))))`],
  // Dynamically registered clients that never got a grant (abandoned or abusive registrations).
  // oauth_grants.client_id / oauth_codes.client_id are text, not FKs; codes always belong to a grant.
  ['oauth_clients', `DELETE FROM oauth_clients c WHERE c.registration = 'dcr' AND c.created_at < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)`],
  ['personal_tokens', `DELETE FROM personal_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
     OR expires_at < now() - interval '30 days'`],
];

export async function runJobsOnce(ctx: Ctx): Promise<JobRunResult> {
  const out: JobRunResult = { reconciled: 0, demoEvents: 0, events: 0, stalePolled: 0, expired: 0, guestsDeleted: 0, retention: {}, skipped: [], failed: [] };

  // 1) Submissions with unknown outcome, or stuck in flight (e.g. after a crash/restart).
  await step(ctx, out, 'reconcile_submissions', async () => {
    const due = await ctx.db.query(
      `SELECT id FROM submission_attempts
       WHERE (status IN ('in_flight','unknown') OR (status = 'rejected' AND error_code = 'NOT_RECEIVED_BY_PROVIDER'))
         AND next_reconcile_at <= $1 ORDER BY next_reconcile_at LIMIT 50`,
      [ctx.clock.now()],
    );
    for (const { id } of due.rows) {
      try {
        await reconcileAttempt(ctx, id);
        out.reconciled++;
      } catch (e: any) {
        console.error(`[jobs] reconcile submission ${id} failed:`, e?.message ?? e);
        // Back off proportionally to the attempt's age (30 s .. 30 min) so a poison row does not
        // stay at the head of the queue and starve the others.
        await ctx.db
          .query(
            `UPDATE submission_attempts
             SET next_reconcile_at = $2::timestamptz + LEAST(GREATEST($2::timestamptz - started_at, interval '30 seconds'), interval '30 minutes')
             WHERE id = $1`,
            [id, ctx.clock.now()],
          )
          .catch((e2: any) => console.error(`[jobs] backoff for ${id} failed:`, e2?.message ?? e2));
      }
    }
  });

  // 2) Demo simulator emits signed webhooks through the same verification + ingestion path.
  await step(ctx, out, 'demo_tick', async () => {
    out.demoEvents = await ctx.providers.demo.tick(async (raw, headers) => {
      await ingestWebhook(ctx, 'demo', raw, headers);
    });
  });

  // 3) Events that arrived before their order row existed (per-event backoff lives in processPendingEvents).
  await step(ctx, out, 'pending_events', async () => {
    out.events = await processPendingEvents(ctx);
  });

  // 4) Cancellations with unknown outcome (per-row try/catch lives in reconcileCancellations).
  await step(ctx, out, 'reconcile_cancellations', async () => {
    await reconcileCancellations(ctx);
  });

  // 5) Expire stale confirmations (display hygiene; validity is always re-checked on use).
  await step(ctx, out, 'expire_checkouts', async () => {
    const ex = await ctx.db.query(
      `UPDATE checkouts SET status='expired', invalid_reason='EXPIRED' WHERE status IN ('awaiting_user','approved') AND expires_at <= $1`,
      [ctx.clock.now()],
    );
    out.expired = ex.rowCount;
  });

  // 6) Data retention.
  await step(ctx, out, 'retention', async () => {
    for (const [table, sql] of RETENTION) {
      try {
        out.retention[table] = (await ctx.db.query(sql)).rowCount;
      } catch (e: any) {
        console.error(`[jobs] retention ${table} failed:`, e?.message ?? e);
      }
    }
  });

  // 7) Guest demo accounts from /try live for 24 hours.
  await step(ctx, out, 'guest_cleanup', async () => {
    const guests = await ctx.db.query(`SELECT id FROM users WHERE is_guest AND created_at < now() - interval '24 hours' ORDER BY created_at LIMIT 25`);
    for (const { id } of guests.rows) {
      try {
        await deleteAccount(ctx, id);
        out.guestsDeleted++;
      } catch (e: any) {
        console.error(`[jobs] guest deletion ${id} failed:`, e?.message ?? e);
      }
    }
  });

  return out;
}

/**
 * Starts the periodic job loop. Returns `stop()`, which clears the timer and resolves once the
 * tick in progress (if any) has finished. Calling stop() again returns the same promise.
 */
export function startJobs(ctx: Ctx, intervalMs = 5000): () => Promise<void> {
  let current: Promise<void> | null = null;
  let stopped: Promise<void> | null = null;
  const t = setInterval(() => {
    if (current || stopped) return;
    current = runJobsOnce(ctx)
      .then(() => undefined)
      .catch((e: any) => console.error('[jobs] error', e?.message ?? e))
      .finally(() => {
        current = null;
      });
  }, intervalMs);
  t.unref();
  return () => {
    if (!stopped) {
      clearInterval(t);
      stopped = current ? current.then(() => undefined) : Promise.resolve();
    }
    return stopped;
  };
}
