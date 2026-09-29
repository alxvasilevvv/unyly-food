// Copies non-TS runtime assets (SQL migrations, static web files) into dist/.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
mkdirSync('dist/web/static', { recursive: true });
cpSync('src/web/static', 'dist/web/static', { recursive: true });
console.log('assets copied');
