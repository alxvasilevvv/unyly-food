// Discovery files for search engines and AI assistants: robots.txt, sitemap.xml and llms.txt.
import type { FastifyInstance } from 'fastify';
import { prMetadataUrl } from '../auth/oauth.js';
import type { Ctx } from '../context.js';
import { LOCALE_CODES } from '../domain/locales.js';
import { PUBLIC_PATHS, setSiteOrigin } from './layout.js';

const CACHE = 'public, max-age=3600';

/** Paths crawlers should skip: signed-in pages, single-use flows and machine endpoints. */
export function disallowedPaths(mcpPath: string): string[] {
  return [...new Set(['/app', '/confirm', '/confirm-cancel', '/oauth', '/login/code', mcpPath, '/auth', '/webhooks'])];
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function robotsTxt(origin: string, mcpPath: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    ...disallowedPaths(mcpPath).map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(origin: string, lastmod: string): string {
  const url = (path: string) => {
    const alt = LOCALE_CODES.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${xmlEscape(`${origin}${path}?lang=${l}`)}"/>`);
    return [
      '  <url>',
      `    <loc>${xmlEscape(`${origin}${path}?lang=en`)}</loc>`,
      ...alt,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(`${origin}${path}`)}"/>`,
      `    <lastmod>${lastmod}</lastmod>`,
      '  </url>',
    ].join('\n');
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...PUBLIC_PATHS.map(url),
    '</urlset>',
    '',
  ].join('\n');
}

export function llmsTxt(ctx: Ctx): string {
  const o = ctx.cfg.webOrigin;
  const mcp = ctx.cfg.mcpResourceUrl;
  return `# Unyly

> Unyly for Grab is an independent concept: a remote MCP server that lets AI assistants (Claude, ChatGPT, Gemini and any MCP client) prepare Grab orders such as food, groceries, rides and parcels. The assistant only prepares the order; a human reviews and confirms it with one tap on Unyly before anything is placed.

Unyly is not affiliated with, endorsed by or sponsored by Grab. "Grab" is a trademark of its owner and is used here only to describe the concept. In demo mode stores, drivers and prices are fictional: nothing is delivered and nothing is charged. In handoff mode the user finishes the order and payment in Grab themselves.

## MCP server

- MCP endpoint (Streamable HTTP, POST only): ${mcp}
- [Protected resource metadata (RFC 9728)](${prMetadataUrl(ctx)}): lists the authorization server and supported scopes
- [Authorization server metadata (RFC 8414)](${o}/.well-known/oauth-authorization-server): OAuth 2.1 with PKCE (S256), dynamic client registration and Client ID Metadata Documents
- [Server card](${o}/.well-known/mcp/server-card.json): machine-readable summary of the server and its tools

## How an assistant connects

- OAuth: add ${mcp} as a custom connector or remote MCP server. The client discovers the metadata above, registers itself and sends the user to Unyly to sign in and approve scopes (orders:read, orders:prepare, orders:submit, orders:cancel).
- Personal token: the user creates a token under Connections on Unyly and the client sends it as "Authorization: Bearer unyly_pat_...". Tokens in the URL query string are never accepted.
- Every order is confirmed by the human on Unyly. The assistant cannot place an order on its own.
- [Connect guide](${o}/connect): step by step setup for popular assistants and MCP clients

## Docs

- [Documentation](${o}/docs): tools, order flow, statuses and errors
- [Docs in English (Markdown)](${o}/docs/unyly-docs-en.md)
- [Docs in Russian (Markdown)](${o}/docs/unyly-docs-ru.md)
- [Docs in Thai (Markdown)](${o}/docs/unyly-docs-th.md)

## Optional

- [Try the demo](${o}/try): guided demo in the browser, no sign-up needed
- [Proposal for Grab](${o}/for-grab): what the concept is and the full disclaimer
- [Help](${o}/help)
- [Privacy](${o}/privacy)
- [Contact](${o}/contact)
`;
}

export function registerDiscoveryRoutes(app: FastifyInstance, ctx: Ctx) {
  const origin = ctx.cfg.webOrigin.replace(/\/$/, '');
  setSiteOrigin(origin);
  const mcpPath = new URL(ctx.cfg.mcpResourceUrl).pathname || '/mcp';
  const lastmod = new Date().toISOString().slice(0, 10);
  const robots = robotsTxt(origin, mcpPath);
  const sitemap = sitemapXml(origin, lastmod);
  const llms = llmsTxt(ctx);

  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').header('cache-control', CACHE).send(robots));
  app.get('/sitemap.xml', async (_req, reply) => reply.type('application/xml; charset=utf-8').header('cache-control', CACHE).send(sitemap));
  app.get('/llms.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').header('cache-control', CACHE).send(llms));
}
