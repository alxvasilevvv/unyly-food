// Measures the website demo (/ari) in-process: start-up time, memory, and N full ride flows
// (session, message, action, confirm, 5 status polls). Run it once per mode to compare:
//   DEMO_DB=memory DATABASE_URL=postgres://... npx tsx scripts/bench-demo-db.ts 200
//   DEMO_DB=shared DATABASE_URL=postgres://... npx tsx scripts/bench-demo-db.ts 200
// The shared database only needs to exist (migrations are applied); in memory mode it gets no demo rows.
// Start with `node --expose-gc --import tsx` to have the garbage collected before each memory reading.
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createCtx, OffsetClock } from '../src/context.js';
import { createDbFromCandidates } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { createMemoryDemoCtx } from '../src/demo-ctx.js';

const flows = Math.max(1, Number(process.argv[2] ?? 200) || 200);
const mem = () => {
  (globalThis as any).gc?.();
  const u = process.memoryUsage();
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  return { rss_mb: mb(u.rss), heap_mb: mb(u.heapUsed), external_mb: mb(u.external) };
};
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];

const report: Record<string, unknown> = { flows, start: mem() };
const t0 = Date.now();
const cfg = loadConfig({ runJobs: false, guestPerIpHourly: 1_000_000, guestHourlyLimit: 1_000_000, webOrigin: 'http://localhost:3700', cookieSecure: false });
const db = await createDbFromCandidates(cfg.databaseUrl);
await migrate(db);
const clock = new OffsetClock();
const ctx = createCtx(cfg, db, clock);
const tDemo = Date.now();
const demo = cfg.demoDb === 'memory' ? await createMemoryDemoCtx(cfg, clock) : null;
if (demo) ctx.demoCtx = demo.ctx;
const demoInitMs = Date.now() - tDemo;
const app = await buildApp(ctx);
await app.ready();
report.mode = demo ? 'memory' : 'shared';
report.boot_ms = Date.now() - t0;
report.demo_db_init_ms = demo ? demoInitMs : 0;
report.after_boot = mem();

const steps: Record<string, number[]> = { session: [], message: [], action: [], confirm: [], poll: [], flow: [] };
async function flow(i: number) {
  const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  let cookie = '';
  const call = async (step: string, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const t = performance.now();
    const r = await app.inject({ method, url, remoteAddress: ip, headers: { 'x-ari-demo': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    steps[step].push(performance.now() - t);
    const sc = r.headers['set-cookie'];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0];
    const json = r.json() as any;
    if (r.statusCode !== 200 || json.ok === false) throw new Error(`${step}: HTTP ${r.statusCode} ${JSON.stringify(json).slice(0, 300)}`);
    return json;
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
for (let i = 0; i < flows; i++) {
  await flow(i);
  if ((i + 1) % every === 0) rssTrend.push(mem().rss_mb);
}
report.rss_mb_every_tenth = rssTrend;
report.flows_ms = Date.now() - tFlows;
report.after_flows = mem();
report.step_ms = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { p50: +pct(v, 50).toFixed(1), p95: +pct(v, 95).toFixed(1), max: +Math.max(...v).toFixed(1) }]));
if (demo) {
  const counts = (await demo.ctx.db.query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM orders) AS orders, pg_database_size(current_database()) / 1048576 AS db_mb`)).rows[0];
  report.memory_db = counts;
  const tc = Date.now();
  report.cleanup_deleted = await demo.cleanup(0);
  report.cleanup_ms = Date.now() - tc;
  report.memory_db_after_cleanup = (await demo.ctx.db.query(`SELECT (SELECT count(*) FROM users) AS users, pg_database_size(current_database()) / 1048576 AS db_mb`)).rows[0];
  report.after_cleanup = mem();
} else {
  // Shared mode: remove the guests this run created.
  await db.query(`DELETE FROM users WHERE is_guest AND partner_id = 'ari-web' AND created_at > now() - interval '1 hour'`);
}
console.log(JSON.stringify(report, null, 2));
await app.close();
await demo?.stop();
await db.close();
