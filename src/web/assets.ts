import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export interface Asset {
  type: string;
  body: Buffer;
  immutable: boolean;
}

/** Content hash of every static file, appended as ?v= so browsers can cache assets for a long time. */
export let ASSET_VERSION = 'dev';

export async function loadStaticAssets(dir: string): Promise<Map<string, Asset>> {
  const out = new Map<string, Asset>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const type = TYPES[extname(e.name).toLowerCase()];
        if (!type) continue;
        const rel = relative(dir, p).split(sep).join('/');
        out.set(rel, { type, body: await readFile(p), immutable: false });
      }
    }
  };
  await walk(dir);
  const h = createHash('sha256');
  for (const k of [...out.keys()].sort()) h.update(k).update(out.get(k)!.body);
  ASSET_VERSION = h.digest('hex').slice(0, 10);
  return out;
}
