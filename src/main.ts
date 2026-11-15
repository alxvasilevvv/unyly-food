import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createCtx, OffsetClock } from './context.js';
import { createMemoryDemoCtx, createRemoteDemoCtx } from './demo-ctx.js';
import { createDbFromCandidates } from './db/db.js';
import { migrate } from './db/migrate.js';
import { startJobs } from './jobs/worker.js';

const cfg = loadConfig();
// DATABASE_URL may list several candidates separated by "|" (e.g. two pooler hosts); the first reachable one is used.
const db = await createDbFromCandidates(cfg.databaseUrl);
await migrate(db, (m) => console.log(`[migrate] ${m}`));
const ctx = createCtx(cfg, db, new OffsetClock());
// DEMO_DB=memory: the public web demo (/ari) gets its own context on an embedded in-process database.
// If that cannot start, the demo stays on the shared database (one log line, the site starts either way).
// DEMO_DATABASE_URL: the same on a separate Postgres next to this host. Either falls back to the shared database;
// the separate one is also left and rejoined while running, as it goes away and comes back (src/demo-ctx.ts).
const demo = (cfg.demoDb === 'memory' ? await createMemoryDemoCtx(cfg, ctx.clock) : null) ?? (await createRemoteDemoCtx(cfg, ctx.clock, db));
if (demo) ctx.demoCtx = demo.ctx;
const app = await buildApp(ctx);
const stopJobs: () => Promise<void> = cfg.runJobs ? startJobs(ctx) : async () => {};

await app.listen({ port: cfg.port, host: cfg.host });
console.log(`Unyly listening on ${cfg.webOrigin} (MCP ${cfg.mcpResourceUrl})`);

// Graceful shutdown: stop the job timer and wait for the tick in progress, stop accepting requests and let
// in-flight provider calls finish (their outcome is persisted or reconciled after restart), then close the pool.
// A second signal does not restart shutdown; a 10 s timer forces exit if something hangs.
const FORCED_EXIT_MS = 10_000;
let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) {
    console.warn(`[shutdown] ${sig} received again, shutdown already in progress`);
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] ${sig} received, draining`);
  setTimeout(() => {
    console.error(`[shutdown] still running after ${FORCED_EXIT_MS / 1000} s, forcing exit`);
    process.exit(1);
  }, FORCED_EXIT_MS).unref();
  let code = 0;
  try {
    await Promise.all([stopJobs(), app.close()]);
  } catch (e: any) {
    console.error('[shutdown] error while draining', e?.message ?? e);
    code = 1;
  }
  await demo?.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void shutdown(sig));
