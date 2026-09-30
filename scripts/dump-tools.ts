// Writes the exact MCP server info, tool definitions (JSON Schemas, annotations) and prompts to docs/mcp-tools.schema.json.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createCtx } from '../src/context.js';
import { createDb } from '../src/db/db.js';
import { buildMcpServer } from '../src/mcp/tools.js';

const db = createDb('postgres://unused@localhost:1/unused', 1);
const server = buildMcpServer(createCtx(loadConfig({ env: 'test' }), db), { userId: 'n/a', via: 'mcp', scopes: [] });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'dump', version: '1' });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
writeFileSync('docs/mcp-tools.schema.json', JSON.stringify({ generated_at: new Date().toISOString(), server_info: client.getServerVersion(), instructions: client.getInstructions(), tools, prompts }, null, 2));
console.log(`wrote ${tools.length} tools, ${prompts.length} prompts`);
await client.close();
await db.close();
