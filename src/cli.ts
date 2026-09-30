// Operations CLI, available in the production image:  node dist/cli.js <command>
//   migrate                       apply pending migrations
//   issue-login-code <email>      one-time sign-in code for account recovery (10 min)
//   kill-switch <demo|live> <on|off> | kill-switch status
import { loadConfig } from './config.js';
import { createDbFromCandidates } from './db/db.js';
import { migrate } from './db/migrate.js';
import { issueLoginCode } from './auth/session.js';
import { setSubmissionsEnabled } from './services/common.js';

const [cmd, ...args] = process.argv.slice(2);
// Same "|" candidate list handling as main.ts (first reachable URL wins).
const db = await createDbFromCandidates(loadConfig().databaseUrl, 1);
try {
  if (cmd === 'migrate') {
    const a = await migrate(db, console.log);
    console.log(a.length ? `applied ${a.length}` : 'up to date');
  } else if (cmd === 'issue-login-code') {
    if (!args[0]) throw new Error('usage: issue-login-code <email>');
    console.log(`Code for ${args[0]}: ${await issueLoginCode(db, args[0])} (valid 10 minutes, sign in at /login/code)`);
  } else if (cmd === 'kill-switch') {
    const [mode, state] = args;
    if (mode !== 'status') {
      if (!['demo', 'live'].includes(mode) || !['on', 'off'].includes(state)) throw new Error('usage: kill-switch <demo|live> <on|off> | status');
      await setSubmissionsEnabled(db, mode as 'demo' | 'live', state === 'on');
      await db.query(`INSERT INTO audit_log (actor, action, mode, details) VALUES ('ops', 'submissions.toggled', $1, $2)`, [mode, JSON.stringify({ enabled: state === 'on' })]);
    }
    console.log((await db.query(`SELECT value FROM settings WHERE key='submissions'`)).rows[0].value);
  } else {
    console.log('commands: migrate | issue-login-code <email> | kill-switch <demo|live> <on|off> | kill-switch status');
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
