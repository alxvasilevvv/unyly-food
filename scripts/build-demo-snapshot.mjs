// Build step: saves an empty, fully migrated copy of the embedded demo database (DEMO_DB=memory) as
// dist/db/demo-db.tgz. Starting from it skips the data directory initialisation at boot: about 2 seconds and
// 250 MB less memory at the peak. Optional: if it cannot be built here, the build goes on and the server
// initialises an empty database at start instead.
import { rmSync, writeFileSync } from 'node:fs';

// Never leave the snapshot of an earlier build (other migrations, other PGlite version) behind.
rmSync('dist/db/demo-db.tgz', { force: true });
try {
  const { createMemoryDb } = await import('../dist/db/memory-db.js');
  const db = await createMemoryDb({ snapshot: false });
  const bytes = await db.snapshot();
  await db.close();
  writeFileSync('dist/db/demo-db.tgz', bytes);
  console.log(`demo database snapshot written (${Math.round(bytes.length / 1024)} KB)`);
} catch (e) {
  console.warn(`demo database snapshot skipped: ${e?.message ?? e}`);
}
