// Measures the website demo (/ari) in-process: start-up time, memory, and N full ride flows
// (session, message, action, confirm, 5 status polls). Run it once per mode to compare:
//   DEMO_DB=memory DATABASE_URL=postgres://... npx tsx scripts/bench-demo-db.ts 200
//   DEMO_DB=shared DATABASE_URL=postgres://... npx tsx scripts/bench-demo-db.ts 200
// The shared database only needs to exist (migrations are applied); in memory mode it gets no demo rows.
// Start with `node --expose-gc --import tsx` to have the garbage collected before each memory reading.
//
// Against a running server (for example the production build, `node dist/main.js`), over HTTP:
//   BENCH_URL=http://127.0.0.1:3700 BENCH_PID=<server pid> npx tsx scripts/bench-demo-db.ts 200
// The server then needs TRUST_PROXY=1 (each flow comes from its own X-Forwarded-For address) and raised
// GUEST_PER_IP_HOURLY / GUEST_HOURLY_LIMIT. Memory is read from the server process (BENCH_PID, Linux).
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createCtx, OffsetClock } from '../src/context.js';
import { createDbFromCandidates } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { createMemoryDemoCtx } from '../src/demo-ctx.js';

const flows = Math.max(1, Number(process.argv[2] ?? 200) || 200);
const remote = process.env.BENCH_URL?.replace(/\/$/, '');
const remotePid = Number(process.env.BENCH_PID) || 0;
const mem = () => {
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  if (remote) {
    if (!remotePid) return { rss_mb: 0 };
    const kb = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${remotePid}/status`, 'utf8'))?.[1];
    return { rss_mb: Math.round(Number(kb ?? 0) / 1024) };
  }
  (globalThis as any).gc?.();
  const u = process.memoryUsage();
  return { rss_mb: mb(u.rss), heap_mb: mb(u.heapUsed), external_mb: mb(u.external) };
};
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];

const report: Record<string, unknown> = { flows, start: mem() };
const t0 = Date.now();
const clock = new OffsetClock();
let local: { app: Awaited<ReturnType<typeof buildApp>>; db: Awaited<ReturnType<typeof createDbFromCandidates>>; demo: Awaited<ReturnType<typeof createMemoryDemoCtx>> } | null = null;
if (remote) {
  report.mode = `remote ${remote}`;
} else {
  const cfg = loadConfig({ runJobs: false, guestPerIpHourly: 1_000_000, guestHourlyLimit: 1_000_000, webOrigin: 'http://localhost:3700', cookieSecure: false });
  const db = await createDbFromCandidates(cfg.databaseUrl);
  await migrate(db);
  const ctx = createCtx(cfg, db, clock);
  const tDemo = Date.now();
  const demo = cfg.demoDb === 'memory' ? await createMemoryDemoCtx(cfg, clock) : null;
  if (demo) ctx.demoCtx = demo.ctx;
  const demoInitMs = Date.now() - tDemo;
  const app = await buildApp(ctx);
  await app.ready();
  local = { app, db, demo };
  report.mode = demo ? 'memory' : 'shared';
  report.boot_ms = Date.now() - t0;
  report.demo_db_init_ms = demo ? demoInitMs : 0;
  report.after_boot = mem();
}

/** One API call: in-process (inject) or over HTTP. */
async function request(method: 'GET' | 'POST', url: string, ip: string, cookie: string, body?: unknown): Promise<{ status: number; json: any; setCookie: string }> {
  const headers: Record<string, string> = { 'x-ari-demo': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const payload = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
  if (local) {
    const r = await local.app.inject({ method, url, remoteAddress: ip, headers, ...(payload ? { payload } : {}) });
    const sc = r.headers['set-cookie'];
    return { status: r.statusCode, json: r.json(), setCookie: sc ? String(Array.isArray(sc) ? sc[0] : sc) : '' };
  }
  const r = await fetch(`${remote}${url}`, { method, headers: { ...headers, 'x-forwarded-for': ip }, body: payload });
  return { status: r.status, json: await r.json(), setCookie: r.headers.get('set-cookie') ?? '' };
}

const steps: Record<string, number[]> = { session: [], message: [], action: [], confirm: [], poll: [], flow: [] };
async function flow(i: number) {
  const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  let cookie = '';
  const call = async (step: string, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const t = performance.now();
    const r = await request(method, url, ip, cookie, body);
    steps[step].push(performance.now() - t);
    if (r.setCookie) cookie = r.setCookie.split(';')[0];
    if (r.status !== 200 || r.json.ok === false) throw new Error(`${step}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    return r.json;
  };
  const t = performance.now();
  await call('session', 'POST', '/ari/api/session?lang=en');
  const m = await call('message', 'POST', '/ari/api/message?lang=en', { text: 'Taxi from Siam Paragon to Suvarnabhumi airport' });
  const opt = m.card.options.find((o: any) => o.action);
  const a = await call('action', 'POST', '/ari/api/action?lang=en', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments });
  const confirm = a.card.actions.find((x: any) => x.kind === 'confirm');
  const c = await call('confirm', 'POST', '/ari/api/confirm?lang=en', { checkout_id: a.card.id, confirm_hash: confirm.endpoint.body.confirm_hash, user_verification: 'biometric' });
  for (let k = 0; k < 5; k++) {
    clock.advance(20_000);
    await call('poll', 'GET', `/ari/api/orders/${c.order_id}?lang=en`);
  }
  steps.flow.push(performance.now() - t);
}

const tFlows = Date.now();
// Memory after every tenth of the run: a leak shows as a steady climb.
const every = Math.max(1, Math.floor(flows / 10));
const rssTrend: number[] = [];
const cleanupEvery = Number(process.env.BENCH_CLEANUP_EVERY) || 0;
for (let i = 0; i < flows; i++) {
  await flow(i);
  // BENCH_CLEANUP_EVERY=n: what the 10 minute cleanup does in production, here after every n flows (in-process memory mode).
  if (cleanupEvery && local?.demo && (i + 1) % cleanupEvery === 0) await local.demo.cleanup(0);
  if ((i + 1) % every === 0) rssTrend.push(mem().rss_mb);
}
report.rss_mb_every_tenth = rssTrend;
report.flows_ms = Date.now() - tFlows;
report.after_flows = mem();
report.step_ms = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { p50: +pct(v, 50).toFixed(1), p95: +pct(v, 95).toFixed(1), max: +Math.max(...v).toFixed(1) }]));
const demo = local?.demo;
if (demo) {
  const counts = (await demo.ctx.db.query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM orders) AS orders, pg_database_size(current_database()) / 1048576 AS db_mb`)).rows[0];
  report.memory_db = counts;
  const tc = Date.now();
  report.cleanup_deleted = await demo.cleanup(0);
  report.cleanup_ms = Date.now() - tc;
  report.memory_db_after_cleanup = (await demo.ctx.db.query(`SELECT (SELECT count(*) FROM users) AS users, pg_database_size(current_database()) / 1048576 AS db_mb`)).rows[0];
  report.after_cleanup = mem();
} else if (local) {
  // Shared mode: remove the guests this run created.
  await local.db.query(`DELETE FROM users WHERE is_guest AND partner_id = 'ari-web' AND created_at > now() - interval '1 hour'`);
}
console.log(JSON.stringify(report));
await local?.app.close();
await local?.demo?.stop();
await local?.db.close();
