import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './context.js';
import { sha256 } from './domain/crypto.js';
import { isDomainError } from './domain/errors.js';
import {
  asMetadata, issueCode, OAuthError, parseAuthzRequest, prMetadata, prMetadataUrl, redirectWith, registerClient, revokeToken,
  Scope, SCOPES, tokenEndpoint, verifyAccessToken,
} from './auth/oauth.js';
import { checkCsrf, loadSession } from './auth/session.js';
import { buildMcpServer } from './mcp/tools.js';
import { ingestWebhook } from './services/orders.js';
import { html } from './web/html.js';
import { page } from './web/layout.js';
import { fmt, Locale, msg } from './web/messages.js';
import { registerWebRoutes } from './web/routes.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.cfg.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: ctx.cfg.trustProxy,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
  });

  await app.register(cookie);
  await app.register(formbody);
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
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth?.startsWith('Bearer ') ? `t:${sha256(auth.slice(7)).slice(0, 16)}` : `ip:${req.ip}`;
    },
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (isDomainError(err)) {
      if (req.headers.accept?.includes('text/html')) {
        return reply.code(err.httpStatus).type('text/html').send(page({ title: 'Error', locale: 'ru', loggedIn: false, body: html`<h1>${err.message}</h1><p><a href="/app">←</a></p>` }));
      }
      return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many requests' });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'VALIDATION_FAILED', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  // ---------------- Static ----------------
  const assets: Record<string, [string, string]> = { 'app.css': ['text/css; charset=utf-8', ''], 'app.js': ['text/javascript; charset=utf-8', ''] };
  for (const f of Object.keys(assets)) assets[f][1] = await readFile(join(here, 'web', 'static', f), 'utf8');
  app.get('/static/:file', async (req, reply) => {
    const a = assets[(req.params as any).file];
    if (!a) return reply.code(404).send();
    return reply.header('content-type', a[0]).header('cache-control', 'public, max-age=3600').send(a[1]);
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
  app.get('/.well-known/openid-configuration', async () => asMetadata(ctx));
  const prmPath = new URL(prMetadataUrl(ctx)).pathname;
  app.get('/.well-known/oauth-protected-resource', async () => prMetadata(ctx));
  if (prmPath !== '/.well-known/oauth-protected-resource') app.get(prmPath, async () => prMetadata(ctx));

  const oauthErr = (reply: FastifyReply, e: unknown) => {
    if (e instanceof OAuthError) return reply.code(e.status).header('cache-control', 'no-store').send({ error: e.error, error_description: e.description });
    throw e;
  };

  app.post('/oauth/register', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
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

  app.post('/oauth/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const t = await tokenEndpoint(ctx, (req.body ?? {}) as Record<string, string>);
      return reply.header('cache-control', 'no-store').send(t);
    } catch (e) {
      return oauthErr(reply, e);
    }
  });

  app.post('/oauth/revoke', async (req, reply) => {
    await revokeToken(ctx, (req.body as any)?.token);
    return reply.code(200).send({});
  });

  const authorizeLocale = (req: FastifyRequest, s: Awaited<ReturnType<typeof loadSession>>): Locale =>
    s?.user.locale ?? (/^en/i.test(String(req.headers['accept-language'] ?? '')) ? 'en' : 'ru');

  app.get('/oauth/authorize', async (req, reply) => {
    const p = req.query as Record<string, string>;
    const s = await loadSession(ctx, req);
    const l = authorizeLocale(req, s);
    const m = msg(l);
    let areq;
    try {
      areq = await parseAuthzRequest(ctx, p);
    } catch (e) {
      // Never redirect on an untrusted client/redirect_uri: show the error here.
      const desc = e instanceof OAuthError ? `${e.error}: ${e.description}` : 'invalid_request';
      return reply.code(400).type('text/html').send(page({ title: m.errorTitle, locale: l, loggedIn: !!s, narrow: true, body: html`<h1>${m.errorTitle}</h1><p class="notice bad">${desc}</p>` }));
    }
    if (!s) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
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
    if (!s) return reply.code(401).send({ error: 'login_required' });
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
  const unauthorized = (reply: FastifyReply, error = 'invalid_token') =>
    reply
      .code(401)
      .header('www-authenticate', `Bearer resource_metadata="${prMetadataUrl(ctx)}", error="${error}", scope="${SCOPES.join(' ')}"`)
      .send({ error, error_description: 'Authorization required' });

  const mcpPath = new URL(ctx.cfg.mcpResourceUrl).pathname || '/mcp';
  app.post(mcpPath, { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return unauthorized(reply, 'invalid_request');
    const info = await verifyAccessToken(ctx, auth.slice(7).trim());
    if (!info) return unauthorized(reply);
    const server = buildMcpServer(ctx, { userId: info.userId, via: 'mcp', clientId: info.clientId, scopes: info.scopes });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      // Closing the HTTP request never cancels a real order: submissions run to completion server-side.
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless (POST only).' }, id: null });
  app.get(mcpPath, methodNotAllowed);
  app.delete(mcpPath, methodNotAllowed);

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
