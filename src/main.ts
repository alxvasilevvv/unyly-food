import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createCtx, OffsetClock } from './context.js';
import { createDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { startJobs } from './jobs/worker.js';

const cfg = loadConfig();
// DATABASE_URL may list several candidates separated by "|" (e.g. two pooler hosts); the first reachable one is used.
const candidates = cfg.databaseUrl.split('|').map((s) => s.trim()).filter(Boolean);
let db = createDb(candidates[0]);
for (let i = 0; !(await db.ping()) && i < candidates.length - 1; i++) {
  await db.close().catch(() => {});
  console.warn(`[db] candidate ${i + 1} unreachable, trying next`);
  db = createDb(candidates[i + 1]);
}
await migrate(db, (m) => console.log(`[migrate] ${m}`));
const ctx = createCtx(cfg, db, new OffsetClock());
const app = await buildApp(ctx);
const stopJobs = cfg.runJobs ? startJobs(ctx) : () => {};

await app.listen({ port: cfg.port, host: cfg.host });
console.log(`Unyly listening on ${cfg.webOrigin} (MCP ${cfg.mcpResourceUrl})`);

// Graceful shutdown: stop accepting, let in-flight provider calls finish (their outcome is persisted
// or reconciled after restart), then close the pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    stopJobs();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
