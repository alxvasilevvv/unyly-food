// OAuth 2.1 authorization server for Unyly's own MCP resource, following the MCP authorization spec:
// PKCE (S256 only), RFC 8414 metadata, RFC 9728 protected resource metadata, RFC 8707 resource
// indicators with audience checks, RFC 7591 dynamic registration, client ID metadata documents,
// refresh-token rotation with reuse detection. Tokens are opaque and stored hashed.
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { randomToken, safeEqual, sha256, sha256b64url } from '../domain/crypto.js';

export const SCOPES = ['orders:read', 'orders:prepare', 'orders:submit', 'orders:cancel'] as const;
export type Scope = (typeof SCOPES)[number];
const CODE_TTL_MS = 5 * 60_000;

export class OAuthError extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400) {
    super(description);
  }
}

export function asMetadata(ctx: Ctx) {
  const o = ctx.cfg.webOrigin;
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    // offline_access is accepted for clients that always request it; refresh tokens are issued regardless.
    scopes_supported: [...SCOPES, 'offline_access'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/connect`,
  };
}

export function prMetadata(ctx: Ctx) {
  return {
    resource: ctx.cfg.mcpResourceUrl,
    authorization_servers: [ctx.cfg.webOrigin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Unyly MCP',
    resource_documentation: `${ctx.cfg.webOrigin}/connect`,
  };
}

export function prMetadataUrl(ctx: Ctx) {
  const u = new URL(ctx.cfg.mcpResourceUrl);
  const path = u.pathname === '/' ? '' : u.pathname;
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

// ---------------- Clients ----------------
export interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  registration: 'dcr' | 'cimd';
}

/** Redirect URIs: https, or http on loopback only (native/CLI clients). No fragments, no userinfo. */
export function validRedirectUri(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
  return false;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** RFC 8252 7.3: for http loopback redirects the port may vary per request; everything else must match exactly. */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== 'http:' || !LOOPBACK.includes(req.hostname) || req.hash || req.username || req.password) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === req.hostname && u.pathname === req.pathname && u.search === req.search;
    } catch {
      return false;
    }
  });
}

export async function registerClient(ctx: Ctx, body: any): Promise<Client & { client_id_issued_at: number }> {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https URLs or http loopback URLs');
  }
  const name = String(body?.client_name ?? 'Unnamed MCP client').slice(0, 80);
  const id = `dcr_${randomToken(16)}`;
  await ctx.db.query('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration) VALUES ($1,$2,$3,$4)', [id, name, JSON.stringify(uris), 'dcr']);
  return { client_id: id, client_name: name, redirect_uris: uris, registration: 'dcr', client_id_issued_at: Math.floor(Date.now() / 1000) };
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const v4 = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return v4 ? isPrivateIp(v4[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Fetch a Client ID Metadata Document with SSRF protection: https on 443 only, DNS answers pinned
 * and checked against private ranges, no redirects, 5 s timeout, 16 KB cap.
 */
export async function fetchClientMetadata(url: string): Promise<any> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password || u.hash) throw new OAuthError('invalid_client', 'client_id URL not allowed');
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new OAuthError('invalid_client', 'client_id host not allowed');
  const pinned = addrs[0];
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        timeout: 5000,
        headers: { accept: 'application/json' },
        lookup: (_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family)),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new OAuthError('invalid_client', `client metadata HTTP ${res.statusCode}`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 16384) {
            req.destroy();
            reject(new OAuthError('invalid_client', 'client metadata too large'));
          } else chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new OAuthError('invalid_client', 'client metadata is not JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new OAuthError('invalid_client', 'could not fetch client metadata')));
  });
}

export async function getClient(ctx: Ctx, clientId: string, fetcher = fetchClientMetadata): Promise<Client> {
  if (!clientId || clientId.length > 500) throw new OAuthError('invalid_client', 'unknown client');
  const r = await ctx.db.query('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
  if (r.rows[0]) return r.rows[0];
  if (clientId.startsWith('https://')) {
    const doc = await fetcher(clientId);
    if (doc?.client_id !== clientId) throw new OAuthError('invalid_client', 'client_id in metadata does not match URL');
    const uris: string[] = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String).filter(validRedirectUri) : [];
    if (!uris.length) throw new OAuthError('invalid_client', 'client metadata has no valid redirect_uris');
    const name = String(doc.client_name ?? new URL(clientId).hostname).slice(0, 80);
    await ctx.db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration) VALUES ($1,$2,$3,'cimd')
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
      [clientId, name, JSON.stringify(uris)],
    );
    return { client_id: clientId, client_name: name, redirect_uris: uris, registration: 'cimd' };
  }
  throw new OAuthError('invalid_client', 'unknown client');
}

// ---------------- Authorization request ----------------
export interface AuthzRequest {
  client: Client;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  scopes: Scope[];
  resource: string;
}

/**
 * Validates an authorization request. Errors that happen before the client and redirect URI
 * are trusted are thrown (shown on our page, never redirected: prevents open redirects).
 */
export async function parseAuthzRequest(ctx: Ctx, p: Record<string, string | undefined>, fetcher = fetchClientMetadata): Promise<AuthzRequest> {
  const client = await getClient(ctx, p.client_id ?? '', fetcher);
  const redirect = p.redirect_uri ?? '';
  if (!redirectMatches(client.redirect_uris, redirect)) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
  if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'response_type must be code');
  if (p.code_challenge_method !== 'S256' || !p.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) {
    throw new OAuthError('invalid_request', 'PKCE with S256 is required');
  }
  const resource = p.resource ?? ctx.cfg.mcpResourceUrl;
  if (resource.replace(/\/$/, '') !== ctx.cfg.mcpResourceUrl) throw new OAuthError('invalid_target', 'Unknown resource');
  const requested = (p.scope ?? '').split(/\s+/).filter(Boolean);
  let scopes = requested.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  // No Unyly scope named (no scope, or only offline_access/openid): offer all; the user can untick on the consent page.
  if (!scopes.length) {
    const unknown = requested.filter((s) => !['offline_access', 'openid'].includes(s));
    if (unknown.length) throw new OAuthError('invalid_scope', 'No supported scopes requested');
    scopes = [...SCOPES];
  }
  return { client, redirect_uri: redirect, state: p.state?.slice(0, 500), code_challenge: p.code_challenge, scopes, resource: ctx.cfg.mcpResourceUrl };
}

export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export async function issueCode(ctx: Ctx, userId: string, req: AuthzRequest, grantedScopes: Scope[]): Promise<string> {
  const scopes = grantedScopes.filter((s) => req.scopes.includes(s));
  if (!scopes.length) throw new OAuthError('access_denied', 'No scopes granted');
  const code = randomToken();
  await ctx.db.tx(async (q) => {
    const g = await q.query(
      'INSERT INTO oauth_grants (user_id, client_id, client_name, scopes, resource) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [userId, req.client.client_id, req.client.client_name, scopes, req.resource],
    );
    await q.query('INSERT INTO oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      sha256(code), g.rows[0].id, req.client.client_id, req.redirect_uri, req.code_challenge, new Date(Date.now() + CODE_TTL_MS),
    ]);
    await audit(q, { userId, actor: 'web', action: 'mcp.connected', entity: 'oauth_grant', entityId: g.rows[0].id, details: { client: req.client.client_name, scopes } });
  });
  return code;
}

async function issueTokens(ctx: Ctx, q: Queryable, grantId: string, scopes: string[]) {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  await q.query('INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)', [
    sha256(access), grantId, 'access', new Date(now + ctx.cfg.accessTokenTtlSec * 1000), sha256(refresh), 'refresh', new Date(now + ctx.cfg.refreshTokenTtlSec * 1000),
  ]);
  return { access_token: access, token_type: 'Bearer', expires_in: ctx.cfg.accessTokenTtlSec, refresh_token: refresh, scope: scopes.join(' ') };
}

async function revokeGrant(q: Queryable, grantId: string) {
  await q.query('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [grantId]);
  await q.query('DELETE FROM oauth_tokens WHERE grant_id = $1', [grantId]);
}

export async function tokenEndpoint(ctx: Ctx, body: Record<string, string | undefined>) {
  const grantType = body.grant_type;
  if (body.resource && body.resource.replace(/\/$/, '') !== ctx.cfg.mcpResourceUrl) throw new OAuthError('invalid_target', 'Unknown resource');
  if (grantType === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = body;
    if (!code || !redirect_uri || !client_id || !code_verifier) throw new OAuthError('invalid_request', 'Missing parameters');
    const out = await ctx.db.tx(async (q) => {
      const r = await q.query('SELECT c.*, g.scopes, g.revoked_at FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = $1 FOR UPDATE OF c', [sha256(code)]);
      const row = r.rows[0];
      if (!row) throw new OAuthError('invalid_grant', 'Invalid code');
      if (row.consumed_at) {
        // Code replay: revoke everything issued from it (committed before the error is returned).
        await revokeGrant(q, row.grant_id);
        return new OAuthError('invalid_grant', 'Code already used');
      }
      if (new Date(row.expires_at).getTime() < Date.now() || row.revoked_at) throw new OAuthError('invalid_grant', 'Code expired');
      if (row.client_id !== client_id || row.redirect_uri !== redirect_uri) throw new OAuthError('invalid_grant', 'Client or redirect mismatch');
      if (!safeEqual(sha256b64url(code_verifier), row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
      await q.query('UPDATE oauth_codes SET consumed_at = now() WHERE code_hash = $1', [row.code_hash]);
      return issueTokens(ctx, q, row.grant_id, row.scopes);
    });
    if (out instanceof OAuthError) throw out;
    return out;
  }
  if (grantType === 'refresh_token') {
    const { refresh_token, client_id } = body;
    if (!refresh_token || !client_id) throw new OAuthError('invalid_request', 'Missing parameters');
    const out = await ctx.db.tx(async (q) => {
      const r = await q.query(
        `SELECT t.*, g.client_id, g.scopes, g.revoked_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
        [sha256(refresh_token)],
      );
      const row = r.rows[0];
      if (!row || row.revoked_at) throw new OAuthError('invalid_grant', 'Invalid refresh token');
      if (row.client_id !== client_id) throw new OAuthError('invalid_grant', 'Client mismatch');
      if (row.consumed_at) {
        await revokeGrant(q, row.grant_id); // refresh token reuse: assume theft
        return new OAuthError('invalid_grant', 'Refresh token reuse detected; access revoked');
      }
      if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('invalid_grant', 'Refresh token expired');
      await q.query('UPDATE oauth_tokens SET consumed_at = now() WHERE token_hash = $1', [row.token_hash]);
      return issueTokens(ctx, q, row.grant_id, row.scopes);
    });
    if (out instanceof OAuthError) throw out;
    return out;
  }
  throw new OAuthError('unsupported_grant_type', 'Unsupported grant_type');
}

export async function revokeToken(ctx: Ctx, token: string | undefined) {
  if (!token) return;
  await ctx.db.tx(async (q) => {
    const r = await q.query('SELECT grant_id FROM oauth_tokens WHERE token_hash = $1', [sha256(token)]);
    if (r.rows[0]) await revokeGrant(q, r.rows[0].grant_id);
  });
}

export async function revokeGrantForUser(ctx: Ctx, userId: string, grantId: string) {
  await ctx.db.tx(async (q) => {
    const r = await q.query('SELECT id FROM oauth_grants WHERE id = $1 AND user_id = $2', [grantId, userId]);
    if (!r.rows[0]) return;
    await revokeGrant(q, grantId);
    await audit(q, { userId, actor: 'web', action: 'mcp.revoked', entity: 'oauth_grant', entityId: grantId });
  });
}

export interface TokenInfo {
  userId: string;
  clientId: string;
  scopes: Scope[];
  grantId: string;
}

/** Resource-server check: token exists, not expired, grant not revoked, audience = this MCP resource. */
export const PAT_PREFIX = 'unyly_pat_';

export async function createPersonalToken(ctx: Ctx, userId: string, name: string, scopes: Scope[], days = 90) {
  const clean = scopes.filter((s) => (SCOPES as readonly string[]).includes(s));
  if (!clean.length) throw new OAuthError('invalid_scope', 'Choose at least one permission');
  const days2 = Math.min(Math.max(Math.round(days), 1), 365);
  const token = `${PAT_PREFIX}${randomToken(32)}`;
  const r = await ctx.db.tx(async (q) => {
    const n = (await q.query('SELECT count(*)::int n FROM personal_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()', [userId])).rows[0].n;
    if (n >= 10) throw new OAuthError('invalid_request', 'Too many active tokens (max 10). Revoke one first.');
    const row = await q.query(
      `INSERT INTO personal_tokens (user_id, name, token_hash, scopes, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [userId, name.trim().slice(0, 60) || 'Personal token', sha256(token), clean, days2],
    );
    await audit(q, { userId, actor: 'web', action: 'pat.created', entity: 'personal_token', entityId: row.rows[0].id, details: { scopes: clean } });
    return row.rows[0];
  });
  return { id: r.id as string, token, expires_at: r.expires_at as string };
}

export async function revokePersonalToken(ctx: Ctx, userId: string, id: string) {
  await ctx.db.tx(async (q) => {
    const r = await q.query('UPDATE personal_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id', [id, userId]);
    if (r.rowCount) await audit(q, { userId, actor: 'web', action: 'pat.revoked', entity: 'personal_token', entityId: id });
  });
}

export async function verifyAccessToken(ctx: Ctx, token: string): Promise<TokenInfo | null> {
  if (!token || token.length > 200) return null;
  if (token.startsWith(PAT_PREFIX)) {
    const p = await ctx.db.query(
      `SELECT t.id, t.user_id, t.scopes FROM personal_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND u.deleted_at IS NULL AND NOT u.is_guest`,
      [sha256(token)],
    );
    const row = p.rows[0];
    if (!row) return null;
    ctx.db.query(`UPDATE personal_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [row.id]).catch(() => {});
    return { userId: row.user_id, clientId: `pat:${row.id}`, scopes: row.scopes, grantId: `pat:${row.id}` };
  }
  const r = await ctx.db.query(
    `SELECT g.id AS grant_id, g.user_id, g.client_id, g.scopes, g.resource FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now() AND g.revoked_at IS NULL AND u.deleted_at IS NULL`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.resource !== ctx.cfg.mcpResourceUrl) return null;
  ctx.db.query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', [row.grant_id]).catch(() => {});
  return { userId: row.user_id, clientId: row.client_id, scopes: row.scopes, grantId: row.grant_id };
}
