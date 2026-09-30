import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { prMetadataUrl, SCOPES } from '../auth/oauth.js';
import type { Ctx } from '../context.js';
import { buildMcpServer, SERVER_DESCRIPTION, serverInfo } from './tools.js';

// Discovery document in the style of the draft MCP Server Card proposal (SEP-1649).
// Tools and prompts come from the live server definitions (tools/list and prompts/list over an
// in-memory transport), so the card can never drift from what /mcp actually serves.

export const SERVER_CARD_PATHS = ['/.well-known/mcp/server-card.json', '/.well-known/mcp.json'] as const;

type Listing = {
  tools: { name: string; title?: string; description?: string }[];
  prompts: { name: string; title?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[];
};

const listings = new WeakMap<Ctx, Promise<Listing>>();

/** tools/list and prompts/list exactly as a client sees them. Listing touches no database. */
export function listDefinitions(ctx: Ctx): Promise<Listing> {
  let p = listings.get(ctx);
  if (!p) {
    p = (async () => {
      const server = buildMcpServer(ctx, { userId: 'server-card', via: 'mcp', scopes: [] });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'unyly-server-card', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        const [{ tools }, { prompts }] = await Promise.all([client.listTools(), client.listPrompts()]);
        return {
          tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description })),
          prompts: prompts.map((x) => ({ name: x.name, title: x.title, description: x.description, arguments: x.arguments })),
        };
      } finally {
        await client.close();
        await server.close();
      }
    })();
    p.catch(() => listings.delete(ctx));
    listings.set(ctx, p);
  }
  return p;
}

export async function serverCard(ctx: Ctx) {
  const { tools, prompts } = await listDefinitions(ctx);
  const info = serverInfo(ctx);
  const base = ctx.cfg.webOrigin;
  return {
    version: '1.0',
    protocolVersion: LATEST_PROTOCOL_VERSION,
    serverInfo: { name: info.name, title: info.title, version: info.version, websiteUrl: info.websiteUrl, icons: info.icons },
    description: SERVER_DESCRIPTION,
    documentationUrl: `${base}/docs`,
    transport: { type: 'streamable-http', endpoint: ctx.cfg.mcpResourceUrl },
    capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    authentication: {
      required: true,
      schemes: ['oauth2'],
      oauth2: {
        protectedResourceMetadata: prMetadataUrl(ctx),
        authorizationServer: base,
        scopes: [...SCOPES],
      },
    },
    tools,
    prompts,
    disclaimer: 'Independent concept, not affiliated with or endorsed by Grab.',
  };
}

/** Public, cacheable, cookie-free. CORS for /.well-known/* is added in app.ts. */
export function registerServerCard(app: FastifyInstance, ctx: Ctx) {
  const handler = async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply
      .header('cache-control', 'public, max-age=3600')
      .header('access-control-allow-origin', '*')
      .type('application/json; charset=utf-8')
      .send(await serverCard(ctx));
  for (const p of SERVER_CARD_PATHS) app.get(p, handler);
}
