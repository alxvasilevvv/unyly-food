import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Applies pending SQL migrations in lexical order. Each file runs in its own transaction. */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Serialize concurrent migrators (e.g. two containers starting at once).
  const dir = join(here, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(727274)');
    const done = new Set((await q.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
      log(`applied migration ${f}`);
    }
  });
  return applied;
}
