import { loadConfig } from '../config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl, 1);
migrate(db, console.log)
  .then((a) => console.log(a.length ? `done (${a.length} applied)` : 'up to date'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.close());
