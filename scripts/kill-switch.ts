// Pause or resume NEW order submissions without touching status reads.
// Usage: npm run kill-switch -- demo off | npm run kill-switch -- live on | npm run kill-switch -- status
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/db.js';
import { setSubmissionsEnabled } from '../src/services/common.js';

const [mode, state] = process.argv.slice(2);
const db = createDb(loadConfig().databaseUrl, 1);
try {
  if (mode !== 'status') {
    if (!['demo', 'live'].includes(mode) || !['on', 'off'].includes(state)) throw new Error('usage: kill-switch <demo|live> <on|off> | status');
    await setSubmissionsEnabled(db, mode as 'demo' | 'live', state === 'on');
    await db.query(`INSERT INTO audit_log (actor, action, mode, details) VALUES ('ops', 'submissions.toggled', $1, $2)`, [mode, JSON.stringify({ enabled: state === 'on' })]);
  }
  console.log((await db.query(`SELECT value FROM settings WHERE key='submissions'`)).rows[0].value);
} finally {
  await db.close();
}
