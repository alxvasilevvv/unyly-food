import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './context.js';
import { sha256 } from './domain/crypto.js';
import { isDomainError } from './domain/errors.js';
import {
  asMetadata, clientIdFrom, issueCode, OAuthError, oauthParams, parseAuthzRequest, prMetadata, prMetadataUrl, redirectWith, registerClient, revokeToken,
  Scope, SCOPES, TokenInfo, tokenEndpoint, verifyAccessToken,
} from './auth/oauth.js';
import { checkCsrf, loadSession, requireSameOrigin } from './auth/session.js';
import { buildMcpServer } from './mcp/tools.js';
import { ingestWebhook } from './services/orders.js';
import { ASSET_VERSION, loadStaticAssets } from './web/assets.js';
import { html } from './web/html.js';
import { page } from './web/layout.js';
import { fmt, Locale, msg } from './web/messages.js';
import { detectLocale, registerWebRoutes } from './web/routes.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Static files served from memory: exempt from the global per-IP request limit. */
export const isStaticPath = (url: string) => {
  const path = url.split('?')[0];
  return path.startsWith('/static/') || path === '/favicon.ico' || path === '/manifest.webmanifest';
};

/**
 * Rate-limit key for a client IP. IPv6 is grouped by /64: one subscriber or VM usually owns a whole
 * /64, so per-address keys would be trivially rotated. IPv4-mapped IPv6 is folded back to IPv4.
 */
export function ipKey(ipRaw: string | undefined): string {
  const ip = String(ipRaw ?? '').split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const expand = (part: string) => (part ? part.split(':') : []).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const [head, tail] = ip.split('::');
  const h = expand(head);
  const t = tail === undefined ? [] : expand(tail);
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

/**
 * Fastify's trustProxy. A hop count is turned into a trust function (trust the nearest N hops):
 * Fastify 5.12 deliberately fails closed on a plain number (req.ip would always be the proxy, so
 * every client would share one rate-limit bucket). Prefer a CIDR list where the proxy IPs are known.
 */
function fastifyTrustProxy(tp: Ctx['cfg']['trustProxy']) {
  if (typeof tp === 'number') return tp > 0 ? (_addr: string, i: number) => i < tp : false;
  return tp;
}

// Scope needed per tool, duplicated from scopeFor() in src/mcp/tools.ts (keep in sync; tools.ts
// still enforces it per call). Used to answer tools/call with HTTP 403 insufficient_scope up front,
// so that clients can step up authorization (MCP authorization spec, scope challenge handling).
const TOOL_SCOPE: Record<string, Scope> = {
  create_cart: 'orders:prepare', update_cart: 'orders:prepare', quote_cart: 'orders:prepare', prepare_checkout: 'orders:prepare', create_handoff: 'orders:prepare',
  submit_order: 'orders:submit',
  prepare_cancellation: 'orders:cancel', cancel_order: 'orders:cancel',
};
const toolScope = (name: string): Scope => TOOL_SCOPE[name] ?? 'orders:read';

/** RFC 7235: the auth scheme is case-insensitive. */
const bearerToken = (h: string | undefined): string | undefined => /^bearer[ \t]+(\S+)[ \t]*$/i.exec(h ?? '')?.[1];

/** Rewrites a header on the raw request, including rawHeaders (the MCP SDK's Node adapter reads those). */
function setRawHeader(raw: IncomingMessage, name: string, value: string) {
  raw.headers[name] = value;
  const rh = raw.rawHeaders;
  let found = false;
  for (let i = 0; i < rh.length; i += 2) {
    if (rh[i].toLowerCase() === name) {
      if (found) {
        rh.splice(i, 2);
        i -= 2;
      } else {
        rh[i + 1] = value;
        found = true;
      }
    }
  }
  if (!found) rh.push(name, value);
}

type McpRequest = FastifyRequest & { mcpAuth?: TokenInfo | null; mcpTokenKey?: string };

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.cfg.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    // TRUST_PROXY: hop count or CIDR list (see config.ts). Default 1 in production (Caddy in front).
    trustProxy: fastifyTrustProxy(ctx.cfg.trustProxy) as any,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
  });

  await app.register(cookie);
  await app.register(formbody);
  // gzip/brotli for HTML, CSS and JS (fonts are already compressed). MCP replies are hijacked and bypass it.
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: ctx.cfg.webOrigin.startsWith('https://') ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // 'no-referrer' makes browsers send `Origin: null` on same-site form posts, which our CSRF origin check rejects.
    referrerPolicy: { policy: 'same-origin' },
  });
  // Keyed by client IP everywhere. A client-supplied header (e.g. any Bearer value) must never pick
  // the bucket: that gave every request its own fresh limit. The MCP route keys by token only after
  // the token is verified, and the token endpoint by client_id + IP (see below).
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => `ip:${ipKey(req.ip)}`,
    // Static files (CSS, JS, fonts, icons) are cheap and cached. Counting them let one page view
    // spend ~10 of the budget, so users behind a shared carrier IP (CGNAT) got unstyled pages.
    allowList: (req) => isStaticPath(req.url),
  });

  const mcpPath = new URL(ctx.cfg.mcpResourceUrl).pathname || '/mcp';
  const mcpPaths = mcpPath === '/' ? ['/'] : [mcpPath, `${mcpPath}/`];
  const pathOf = (url: string) => url.split('?')[0];
  const isMcpPath = (url: string) => mcpPaths.includes(pathOf(url));

  // ---------------- CORS (public OAuth/MCP endpoints only) ----------------
  // Browser-based MCP clients (inspectors, web IDEs) call these cross-origin with a bearer token,
  // never with cookies, so a wildcard origin is safe here. Cookie pages and /oauth/authorize never
  // get CORS headers.
  const CORS_EXACT = new Set(['/oauth/register', '/oauth/token', '/oauth/revoke', ...mcpPaths]);
  const isCorsPath = (url: string) => {
    const path = pathOf(url);
    return path.startsWith('/.well-known/') || CORS_EXACT.has(path);
  };
  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
    'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id',
    'access-control-max-age': '86400',
    'cross-origin-resource-policy': 'cross-origin',
  };
  app.addHook('onRequest', async (req, reply) => {
    if (isCorsPath(req.url)) reply.headers(CORS_HEADERS);
  });
  // onSend runs after helmet's headers, so the CORP override sticks.
  app.addHook('onSend', async (req, reply, payload) => {
    if (isCorsPath(req.url)) reply.header('cross-origin-resource-policy', 'cross-origin');
    return payload;
  });
  const preflight = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(204).headers(CORS_HEADERS).send();
  for (const p of ['/.well-known/*', '/oauth/register', '/oauth/token', '/oauth/revoke', ...mcpPaths]) app.options(p, preflight);

  // ---------------- Login CSRF ----------------
  // The sign-in forms have no session (hence no CSRF token) yet: require a same-origin Origin or
  // Referer so another site cannot sign a victim into the attacker's account. Requests with neither
  // header come from non-browser clients (which cannot mount login CSRF); they are refused in
  // production and allowed elsewhere for scripts and the test harness.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && (req.routeOptions.url === '/login' || req.routeOptions.url === '/login/verify')) {
      requireSameOrigin(ctx, req, { allowMissing: false });
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if ((err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') && isMcpPath(req.url)) {
      return reply.code(400).send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null });
    }
    if (isDomainError(err)) {
      if (req.headers.accept?.includes('text/html')) {
        return reply.code(err.httpStatus).type('text/html').send(page({ title: 'Error', locale: detectLocale(req, null), loggedIn: false, body: html`<h1>${err.message}</h1><p><a href="/app">←</a></p>` }));
      }
      return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many requests' });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'VALIDATION_FAILED', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  // ---------------- Static ----------------
  const assets = await loadStaticAssets(join(here, 'web', 'static'));
  app.get('/static/*', async (req, reply) => {
    const key = String((req.params as any)['*'] ?? '');
    const a = /^[a-z0-9._/-]+$/i.test(key) && !key.includes('..') ? assets.get(key) : undefined;
    if (!a) return reply.code(404).send();
    // Only css/js carry a content hash (?v=); fonts get a long but finite cache.
    const versioned = (req.query as any)?.v === ASSET_VERSION;
    const fontCache = key.startsWith('fonts/') ? 'public, max-age=2592000' : 'public, max-age=300';
    return reply
      .header('content-type', a.type)
      .header('cache-control', versioned ? 'public, max-age=31536000, immutable' : fontCache)
      .header('x-content-type-options', 'nosniff')
      .send(a.body);
  });

  // ---------------- Health ----------------
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const db = await ctx.db.ping();
    const mig = db ? (await ctx.db.query('SELECT count(*)::int n FROM schema_migrations').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n : 0;
    const ok = db && mig > 0;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', db, migrations: mig });
  });

  // ---------------- OAuth metadata ----------------
  app.get('/.well-known/oauth-authorization-server', async () => asMetadata(ctx));
  // No /.well-known/openid-configuration: this is not an OpenID Provider (no id_token, jwks_uri,
  // subject types), and a non-compliant OIDC document makes some clients fail harder than a 404.
  const prmPath = new URL(prMetadataUrl(ctx)).pathname;
  app.get('/.well-known/oauth-protected-resource', async () => prMetadata(ctx));
  if (prmPath !== '/.well-known/oauth-protected-resource') app.get(prmPath, async () => prMetadata(ctx));

  const oauthErr = (reply: FastifyReply, e: unknown) => {
    if (e instanceof OAuthError) return reply.code(e.status).header('cache-control', 'no-store').send({ error: e.error, error_description: e.description });
    throw e;
  };

  // DCR per IP: assistant platforms register from shared egress IPs, so the limit is generous.
  // Unused registrations are garbage-collected by ops (clients without grants older than N days).
  app.post('/oauth/register', { config: { rateLimit: { max: 200, timeWindow: '1 hour' } } }, async (req, reply) => {
    try {
      const c = await registerClient(ctx, req.body);
      return reply.code(201).send({
        client_id: c.client_id, client_id_issued_at: c.client_id_issued_at, client_name: c.client_name, redirect_uris: c.redirect_uris,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      });
    } catch (e) {
      return oauthErr(reply, e);
    }
  });

  // Keyed by client_id + IP (the body is parsed by then: preHandler): many users of one assistant
  // platform refresh from the same egress IPs.
  const tokenRateKey = (req: FastifyRequest) => {
    let cid = '';
    try {
      cid = clientIdFrom(oauthParams(req.body), req.headers.authorization) ?? '';
    } catch {
      /* malformed: rejected by the handler */
    }
    return `tok:${sha256(cid).slice(0, 16)}:${ipKey(req.ip)}`;
  };
  app.post('/oauth/token', { config: { rateLimit: { hook: 'preHandler', max: 300, timeWindow: '1 minute', keyGenerator: tokenRateKey } } }, async (req, reply) => {
    try {
      const t = await tokenEndpoint(ctx, req.body ?? {}, { authorization: req.headers.authorization });
      return reply.header('cache-control', 'no-store').send(t);
    } catch (e) {
      return oauthErr(reply, e);
    }
  });

  app.post('/oauth/revoke', async (req, reply) => {
    try {
      await revokeToken(ctx, req.body);
    } catch (e) {
      return oauthErr(reply, e);
    }
    return reply.code(200).send({});
  });

  const authorizeLocale = (req: FastifyRequest, s: Awaited<ReturnType<typeof loadSession>>): Locale => detectLocale(req, s);

  app.get('/oauth/authorize', async (req, reply) => {
    const s = await loadSession(ctx, req);
    // Sign-in first (the query is kept in next): anonymous visitors never trigger a client metadata
    // fetch. Guest demo sessions cannot grant assistant access: a real account is required.
    if (!s || s.user.is_guest) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    const l = authorizeLocale(req, s);
    const m = msg(l);
    let p: Record<string, string | undefined>;
    let areq;
    try {
      p = oauthParams(req.query);
      areq = await parseAuthzRequest(ctx, p);
    } catch (e) {
      // Never redirect on an untrusted client/redirect_uri: show the error here.
      const desc = e instanceof OAuthError ? `${e.error}: ${e.description}` : 'invalid_request';
      return reply.code(400).type('text/html').send(page({ title: m.errorTitle, locale: l, loggedIn: !!s, narrow: true, body: html`<h1>${m.errorTitle}</h1><p class="notice bad">${desc}</p>` }));
    }
    const scopeName = (sc: string) => (m as any)[`scope_${sc.replace(':', '_')}`] ?? sc;
    const redirectOrigin = new URL(areq.redirect_uri).origin;
    // Allow the consent form's redirect target explicitly (form-action applies to redirects in some browsers).
    reply.header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self' ${redirectOrigin}`);
    return reply.type('text/html').header('cache-control', 'no-store').send(
      page({
        title: fmt(m.consentTitle, { client: areq.client.client_name }), locale: l, loggedIn: true, csrf: s.csrf, narrow: true, mode: s.user.mode,
        body: html`<h1>${fmt(m.consentTitle, { client: areq.client.client_name })}</h1>
<p class="lead">${m.consentLead}</p>
<p class="notice warn small">${m.unverifiedClient}</p>
<form method="post" action="/oauth/authorize" class="card stack">
  <input type="hidden" name="_csrf" value="${s.csrf}">
  ${Object.entries(p).filter(([k]) => ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].includes(k)).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
  <fieldset style="border:0;padding:0;margin:0"><legend class="sr-only">Scopes</legend><div class="stack">
  ${areq.scopes.map((sc) => html`<label class="radio-card"><input type="checkbox" name="grant" value="${sc}" checked><span>${scopeName(sc)}<br><span class="small muted">${sc}</span></span></label>`)}
  </div></fieldset>
  <p class="small muted">${s.user.email} · ${fmt(m.redirectTo, { host: new URL(areq.redirect_uri).host })}</p>
  <div class="actions"><button class="btn" type="submit" name="decision" value="allow">${m.allow}</button><button class="btn secondary" type="submit" name="decision" value="deny">${m.deny}</button></div>
</form>`,
      }),
    );
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const s = await loadSession(ctx, req);
    if (!s || s.user.is_guest) return reply.code(401).send({ error: 'login_required' });
    checkCsrf(ctx, req, s);
    let areq;
    try {
      areq = await parseAuthzRequest(ctx, b);
    } catch (e) {
      return oauthErr(reply, e);
    }
    if (b.decision !== 'allow') return reply.redirect(redirectWith(areq.redirect_uri, { error: 'access_denied', state: areq.state, iss: ctx.cfg.webOrigin }));
    const granted = (Array.isArray(b.grant) ? b.grant : b.grant ? [b.grant] : []).filter((x: string) => (SCOPES as readonly string[]).includes(x)) as Scope[];
    try {
      const code = await issueCode(ctx, s.user.id, areq, granted);
      return reply.redirect(redirectWith(areq.redirect_uri, { code, state: areq.state, iss: ctx.cfg.webOrigin }));
    } catch (e) {
      if (e instanceof OAuthError) return reply.redirect(redirectWith(areq.redirect_uri, { error: e.error, state: areq.state, iss: ctx.cfg.webOrigin }));
      throw e;
    }
  });

  // ---------------- MCP (Streamable HTTP, stateless) ----------------
  const challenge = (extra = '') => `Bearer resource_metadata="${prMetadataUrl(ctx)}"${extra}, scope="${SCOPES.join(' ')}"`;
  // RFC 6750 3.1: no error code when the request carried no credentials at all.
  const unauthorized = (reply: FastifyReply, error?: 'invalid_request' | 'invalid_token') =>
    reply
      .code(401)
      .header('www-authenticate', challenge(error ? `, error="${error}"` : ''))
      .send({ error: error ?? 'unauthorized', error_description: 'Authorization required' });
  const rpcError = (reply: FastifyReply, status: number, code: number, message: string, id: unknown = null) =>
    reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: id ?? null });

  // Verifies the token before rate limiting, so that the MCP limit is keyed by the verified token
  // (per user and client) and never by a value the caller can vary freely; unverified callers are
  // keyed by IP. The 401 itself is sent by the handler, after the limiter ran.
  const mcpAuth = async (req: FastifyRequest) => {
    const r = req as McpRequest;
    const token = bearerToken(req.headers.authorization);
    r.mcpAuth = token ? await verifyAccessToken(ctx, token) : null;
    if (r.mcpAuth && token) r.mcpTokenKey = sha256(token).slice(0, 32);
  };
  const mcpRoute = {
    preHandler: mcpAuth,
    config: {
      rateLimit: {
        hook: 'preHandler' as const,
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => {
          const k = (req as McpRequest).mcpTokenKey;
          return k ? `mcp:t:${k}` : `mcp:ip:${ipKey(req.ip)}`;
        },
      },
    },
  };
  const mcpHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const info = (req as McpRequest).mcpAuth;
    if (!info) {
      const h = req.headers.authorization;
      return unauthorized(reply, h === undefined || h === '' ? undefined : bearerToken(h) ? 'invalid_token' : 'invalid_request');
    }
    const body = req.body as any;
    // JSON-RPC batching was removed from MCP in protocol 2025-06-18; accepting batches would also let
    // one HTTP request carry many tool calls past the per-request rate limit. Reject them outright.
    if (Array.isArray(body)) return rpcError(reply, 400, -32600, 'Invalid Request: JSON-RPC batches are not supported');
    if (!body || typeof body !== 'object') return rpcError(reply, 400, -32600, 'Invalid Request');
    if (body.method === 'tools/call') {
      if (body.params === undefined || body.params === null) body.params = {};
      // Some clients omit arguments for tools without parameters; the SDK would reject that.
      if (body.params && typeof body.params === 'object' && (body.params.arguments === undefined || body.params.arguments === null)) body.params.arguments = {};
      const name = body.params?.name;
      // OAuth tokens only: a client can answer 403 insufficient_scope by re-authorizing with more
      // scopes. Personal tokens cannot step up, so they keep the in-band INSUFFICIENT_SCOPE tool
      // error from tools.ts, which the assistant can explain to the user.
      if (typeof name === 'string' && !info.clientId.startsWith('pat:')) {
        const need = toolScope(name);
        if (!info.scopes.includes(need)) {
          const want = [...new Set([...info.scopes, need])].join(' ');
          return reply
            .code(403)
            .header('www-authenticate', `Bearer error="insufficient_scope", scope="${want}", resource_metadata="${prMetadataUrl(ctx)}", error_description="This action needs the ${need} permission"`)
            .send({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32003, message: `Insufficient scope: this action needs the "${need}" permission. Reconnect Unyly and grant it.`, data: { error: 'insufficient_scope', required_scope: need } } });
        }
      }
    }
    // Responses are plain JSON (enableJsonResponse), so a client that accepts only application/json,
    // */* or sends no Accept header is served too: the SDK insists on seeing both types.
    const accept = String(req.headers.accept ?? '');
    if (!(accept.includes('application/json') && accept.includes('text/event-stream'))) setRawHeader(req.raw, 'accept', 'application/json, text/event-stream');
    const server = buildMcpServer(ctx, { userId: info.userId, via: 'mcp', clientId: info.clientId, scopes: info.scopes });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    // The reply is hijacked: write the CORS headers onto the raw response ourselves.
    for (const [k, v] of Object.entries(CORS_HEADERS)) reply.raw.setHeader(k, v);
    reply.raw.on('close', () => {
      // Closing the HTTP request never cancels a real order: submissions run to completion server-side.
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, body);
  };
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless (POST only).' }, id: null });
  for (const p of mcpPaths) {
    app.post(p, mcpRoute, mcpHandler);
    app.get(p, methodNotAllowed);
    app.delete(p, methodNotAllowed);
  }

  // ---------------- Webhooks (raw body for signature verification) ----------------
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/demo', async (req, reply) => {
      try {
        const r = await ingestWebhook(ctx, 'demo', String(req.body ?? ''), req.headers as any);
        return reply.send({ ok: true, ...r });
      } catch (e) {
        if (isDomainError(e) && e.code === 'AUTH_REQUIRED') return reply.code(401).send({ ok: false, error: 'invalid_signature' });
        throw e;
      }
    });
  });

  registerWebRoutes(app, ctx);
  return app;
}
