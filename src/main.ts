import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createCtx, OffsetClock } from './context.js';
import { createDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { startJobs } from './jobs/worker.js';

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);
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
