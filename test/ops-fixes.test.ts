import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbFromCandidates } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { runJobsOnce, startJobs } from '../src/jobs/worker.js';
import { deleteAddress, exportUserData } from '../src/services/users.js';
import { confirmOnWeb, demoUser, Harness, preparedCheckout, startHarness, TEST_DB } from './helpers.js';

let h: Harness;
let u: Awaited<ReturnType<typeof demoUser>>;
beforeAll(async () => {
  h = await startHarness();
  u = await demoUser(h, 'ops@example.com');
});
afterAll(async () => {
  await u.mcp.close();
  await h.close();
});

describe('migrations', () => {
  it('010 indexes exist and migrate is idempotent (lock taken before schema_migrations)', async () => {
    expect(await migrate(h.db)).toEqual([]);
    await Promise.all([migrate(h.db), migrate(h.db)]);
    const idx = (await h.db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname);
    for (const n of ['checkouts_open_expiry', 'web_sessions_user', 'handoffs_user', 'cart_versions_address', 'webauthn_challenges_expires', 'oauth_codes_grant']) {
      expect(idx).toContain(n);
    }
  });
});

describe('DATABASE_URL candidates', () => {
  it('uses the first reachable candidate', async () => {
    const warnings: string[] = [];
    const db = await createDbFromCandidates(`postgres://nobody:x@127.0.0.1:1/none | ${TEST_DB}`, 1, (m) => warnings.push(m));
    expect(await db.ping()).toBe(true);
    expect(warnings).toHaveLength(1);
    await db.close();
  });
});

describe('job worker', () => {
  it('retention deletes old rows and keeps fresh or referenced ones', async () => {
    const q = (sql: string, p: unknown[] = []) => h.db.query(sql, p);
    await q(`INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES ('old@x', 'h', now() - interval '2 days', now() - interval '2 days')`);
    await q(`INSERT INTO webauthn_challenges (purpose, challenge, expires_at) VALUES ('login', 'old', now() - interval '2 days'), ('login', 'new', now() + interval '5 minutes')`);
    await q(`INSERT INTO provider_events (provider, event_id, order_ref, sequence, type, payload, occurred_at, processed_at, outcome)
             VALUES ('demo', 'old-ev', 'X', 1, 't', '{}', now(), now() - interval '31 days', 'applied'),
                    ('demo', 'new-ev', 'X', 2, 't', '{}', now(), now() - interval '1 day', 'applied')`);
    await q(`INSERT INTO demo_sim_orders (ref, idempotency_key, payload, total_minor, status, accepted_at)
             VALUES ('SIM-OLD', 'k-old', '{}', 1, 'delivered', now() - interval '40 days'),
                    ('SIM-UNSENT', 'k-unsent', '{}', 1, 'delivered', now() - interval '40 days')`);
    await q(`UPDATE demo_sim_orders SET sequence = 5, last_emitted_seq = 5 WHERE ref = 'SIM-OLD'`);
    await q(`UPDATE demo_sim_orders SET sequence = 5, last_emitted_seq = 4 WHERE ref = 'SIM-UNSENT'`);
    // A sim row whose order in Unyly is still open must be kept even when the sim row is old and terminal.
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const ref = (await q('SELECT provider_order_ref FROM orders WHERE checkout_id = $1', [checkout.checkout_id])).rows[0].provider_order_ref;
    await q(`UPDATE demo_sim_orders SET status = 'delivered', accepted_at = now() - interval '40 days', last_emitted_seq = sequence WHERE ref = $1`, [ref]);
    await q(`UPDATE orders SET fulfillment_status = 'preparing' WHERE provider_order_ref = $1`, [ref]);
    await q(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration, created_at)
             VALUES ('dcr-old', 'x', '[]', 'dcr', now() - interval '40 days'), ('cimd-old', 'x', '[]', 'cimd', now() - interval '40 days')`);
    await q(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration, created_at) VALUES ('dcr-granted', 'x', '[]', 'dcr', now() - interval '40 days')`);
    await q(`INSERT INTO oauth_grants (user_id, client_id, client_name, scopes, resource) VALUES ($1, 'dcr-granted', 'x', '{orders:read}', 'r')`, [u.userId]);
    await q(`INSERT INTO personal_tokens (user_id, name, token_hash, scopes, expires_at, revoked_at)
             VALUES ($1, 'revoked-old', 'h1', '{orders:read}', now() + interval '10 days', now() - interval '31 days'),
                    ($1, 'expired-old', 'h2', '{orders:read}', now() - interval '31 days', NULL),
                    ($1, 'live', 'h3', '{orders:read}', now() + interval '10 days', NULL)`, [u.userId]);

    const out = await runJobsOnce(h.ctx);
    expect(out.failed).toEqual([]);
    const has = async (sql: string, p: unknown[] = []) => (await q(sql, p)).rowCount > 0;
    expect(await has(`SELECT 1 FROM login_codes WHERE email = 'old@x'`)).toBe(false);
    expect(await has(`SELECT 1 FROM webauthn_challenges WHERE challenge = 'old'`)).toBe(false);
    expect(await has(`SELECT 1 FROM webauthn_challenges WHERE challenge = 'new'`)).toBe(true);
    expect(await has(`SELECT 1 FROM provider_events WHERE event_id = 'old-ev'`)).toBe(false);
    expect(await has(`SELECT 1 FROM provider_events WHERE event_id = 'new-ev'`)).toBe(true);
    expect(await has(`SELECT 1 FROM demo_sim_orders WHERE ref = 'SIM-OLD'`)).toBe(false);
    expect(await has(`SELECT 1 FROM demo_sim_orders WHERE ref = $1`, [ref])).toBe(true);
    expect(await has(`SELECT 1 FROM oauth_clients WHERE client_id = 'dcr-old'`)).toBe(false);
    expect(await has(`SELECT 1 FROM oauth_clients WHERE client_id = 'cimd-old'`)).toBe(true);
    expect(await has(`SELECT 1 FROM oauth_clients WHERE client_id = 'dcr-granted'`)).toBe(true);
    const names = (await q(`SELECT name FROM personal_tokens WHERE user_id = $1`, [u.userId])).rows.map((r: any) => r.name);
    expect(names).toEqual(['live']);
  });

  it('skips a step whose advisory lock is held by another instance', async () => {
    const other = new pg.Client({ connectionString: TEST_DB });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock(727275, 6)'); // "retention"
      await h.db.query(`INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES ('locked@x', 'h', now(), now() - interval '2 days')`);
      const out = await runJobsOnce(h.ctx);
      expect(out.skipped).toEqual(['retention']);
      expect((await h.db.query(`SELECT 1 FROM login_codes WHERE email = 'locked@x'`)).rowCount).toBe(1);
      await other.query('SELECT pg_advisory_unlock(727275, 6)');
      expect((await runJobsOnce(h.ctx)).skipped).toEqual([]);
      expect((await h.db.query(`SELECT 1 FROM login_codes WHERE email = 'locked@x'`)).rowCount).toBe(0);
    } finally {
      await other.end();
    }
  });

  it('a failing step or a poison row does not block the rest', async () => {
    // Poison submission: any status change by reconcileAttempt raises.
    const { checkout } = await preparedCheckout(u.mcp.call);
    await confirmOnWeb(h, u, checkout.checkout_id);
    const a = (await h.db.query('SELECT id FROM submission_attempts WHERE checkout_id = $1', [checkout.checkout_id])).rows[0];
    await h.db.query(`UPDATE submission_attempts SET status = 'unknown', mode = 'bogus', error_code = NULL, next_reconcile_at = $2 WHERE id = $1`, [a.id, new Date(h.clock.now().getTime() - 60_000)]);
    await h.db.query(`CREATE OR REPLACE FUNCTION ops_test_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.error_code IS DISTINCT FROM OLD.error_code THEN RAISE EXCEPTION 'poison'; END IF; RETURN NEW; END $$`);
    await h.db.query(`CREATE TRIGGER ops_test_poison BEFORE UPDATE ON submission_attempts FOR EACH ROW WHEN (OLD.id = '${a.id}') EXECUTE FUNCTION ops_test_poison()`);
    // An expired confirmation that step 5 must still expire.
    const { checkout: c2 } = await preparedCheckout(u.mcp.call, [{ item_id: 'r1-greencurry', quantity: 1 }]);
    await h.db.query(`UPDATE checkouts SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c2.checkout_id]);
    const demo = h.ctx.providers.demo;
    const tick = demo.tick;
    demo.tick = async () => {
      throw new Error('boom');
    };
    try {
      const out = await runJobsOnce(h.ctx);
      expect(out.failed).toEqual(['demo_tick']);
      const after = (await h.db.query('SELECT next_reconcile_at FROM submission_attempts WHERE id = $1', [a.id])).rows[0];
      expect(new Date(after.next_reconcile_at).getTime()).toBeGreaterThan(h.clock.now().getTime());
      expect((await h.db.query('SELECT status FROM checkouts WHERE id = $1', [c2.checkout_id])).rows[0].status).toBe('expired');
    } finally {
      demo.tick = tick;
      await h.db.query('DROP TRIGGER ops_test_poison ON submission_attempts');
      await h.db.query('DROP FUNCTION ops_test_poison()');
      await h.db.query(`UPDATE submission_attempts SET mode = 'demo', status = 'accepted', next_reconcile_at = NULL WHERE id = $1`, [a.id]);
    }
  });

  it('stopJobs resolves after the tick in progress and is idempotent', async () => {
    const stop = startJobs(h.ctx, 10);
    await new Promise((r) => setTimeout(r, 30));
    const p1 = stop();
    const p2 = stop();
    expect(p1).toBe(p2);
    await p1;
  });
});

describe('data rights', () => {
  it('export covers the account and is JSON-serialisable without secrets', async () => {
    await h.db.query(`INSERT INTO webauthn_credentials (id, user_id, public_key, label) VALUES ('cred-abcdefghijklmnop', $1, '\\x0102', 'Laptop')`, [u.userId]);
    const data: any = await exportUserData(h.db, u.userId);
    const json = JSON.stringify(data);
    for (const k of ['passkeys', 'carts', 'quotes', 'checkouts', 'submissions', 'orders', 'cancellation_requests', 'provider_connections', 'activity', 'personal_tokens', 'handoffs']) {
      expect(Array.isArray(data[k])).toBe(true);
    }
    expect(data.passkeys[0].credential_id_prefix).toBe('cred-abc…');
    expect(json).not.toContain('public_key');
    expect(json).not.toContain('cred-abcdefghijklmnop');
    expect(json).not.toContain('token_hash');
    expect(data.carts[0].versions[0].items).toBeTruthy();
    expect(data.orders.length).toBeGreaterThan(0);
    expect(data.activity.some((r: any) => r.action === 'user.created')).toBe(true);
  });

  it('deleting an address scrubs every text field and keeps order labels', async () => {
    const addr = (await h.db.query('SELECT id FROM addresses WHERE user_id = $1 AND deleted_at IS NULL', [u.userId])).rows[0];
    const before = (await h.db.query('SELECT address_label FROM orders WHERE user_id = $1', [u.userId])).rows;
    await deleteAddress(h.ctx, u.userId, addr.id);
    const a = (await h.db.query('SELECT label, line1, district, city, instructions FROM addresses WHERE id = $1', [addr.id])).rows[0];
    expect(a).toEqual({ label: '[deleted]', line1: '[deleted]', district: '[deleted]', city: '[deleted]', instructions: null });
    expect((await h.db.query('SELECT address_label FROM orders WHERE user_id = $1', [u.userId])).rows).toEqual(before);
  });
});
