import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { PROMPTS } from '../src/mcp/prompts.js';
import { demoUser, Harness, mcpClient, oauthToken, startHarness, webLogin } from './helpers.js';

describe('MCP prompts, server info and server card', () => {
  let h: Harness;
  let u: Awaited<ReturnType<typeof demoUser>>;

  beforeAll(async () => {
    h = await startHarness();
    u = await demoUser(h, 'prompts@example.com');
  });
  afterAll(async () => {
    await u?.mcp.close();
    await h?.close();
  });

  it('initialize advertises prompts and serverInfo with websiteUrl and icons', async () => {
    const c = u.mcp.client;
    expect(c.getServerCapabilities()?.prompts).toBeTruthy();
    expect(c.getServerCapabilities()?.tools).toBeTruthy();
    const info = c.getServerVersion()!;
    expect(info.name).toBe('unyly');
    expect(info.version).toBe('1.0.0');
    expect(info.websiteUrl).toBe('http://localhost:3000');
    expect(info.icons).toEqual([
      { src: 'http://localhost:3000/static/brand/icon-192.png', mimeType: 'image/png', sizes: ['192x192'] },
      { src: 'http://localhost:3000/static/brand/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
    ]);
    for (const icon of info.icons!) {
      const r = await h.app.inject({ method: 'GET', url: new URL(icon.src).pathname });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('image/png');
    }
  });

  it('prompts/list returns every prompt with titles and arguments', async () => {
    const { prompts } = await u.mcp.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual(['book_ride', 'buy_groceries', 'order_cake', 'order_food', 'pharmacy', 'send_flowers', 'send_parcel', 'track_orders']);
    expect(names).toEqual(Object.keys(PROMPTS).sort());
    for (const p of prompts) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
    }
    const food = prompts.find((p) => p.name === 'order_food')!;
    expect(food.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'request', required: true }),
      expect.objectContaining({ name: 'budget', required: false }),
    ]));
    expect(prompts.find((p) => p.name === 'track_orders')!.arguments ?? []).toEqual([]);
  });

  it('prompts work for a read-only token (no scope beyond listing)', async () => {
    const s = await webLogin(h, 'readonly-prompts@example.com');
    const tok = await oauthToken(h, s, 'orders:read');
    const m = await mcpClient(h, tok.access_token);
    try {
      expect((await m.client.listPrompts()).prompts.length).toBe(8);
      const r = await m.client.getPrompt({ name: 'track_orders' });
      expect(r.messages[0].content).toMatchObject({ type: 'text' });
    } finally {
      await m.close();
    }
  });

  it('prompts/get renders the arguments and the confirmation rule', async () => {
    const r = await u.mcp.client.getPrompt({ name: 'order_food', arguments: { request: 'green curry for two', budget: '600 THB', people: '2', avoid: 'peanuts', } });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe('user');
    const text = (r.messages[0].content as { text: string }).text;
    for (const s of ['green curry for two', '600 THB', 'People: 2', 'peanuts', 'search_stores', 'create_cart', 'confirm_url', 'get_checkout_status', 'Confirm on the Unyly page', 'full price']) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('\u2014');

    const flowers = await u.mcp.client.getPrompt({ name: 'send_flowers', arguments: { what: 'red roses', recipient: 'Nok, Ari', card_text: 'Happy anniversary!', } });
    const ft = (flowers.messages[0].content as { text: string }).text;
    expect(ft).toContain('red roses');
    expect(ft).toContain('Nok, Ari');
    expect(ft).toContain('Happy anniversary!');
    expect(ft).toContain('deliver_to');

    // Blank optional arguments (sent by some clients) are treated as omitted.
    const ride = await u.mcp.client.getPrompt({ name: 'book_ride', arguments: { to: 'ICONSIAM', from: '', passengers: '' } });
    const rt = (ride.messages[0].content as { text: string }).text;
    expect(rt).toContain('ICONSIAM');
    expect(rt).toContain('Ask me for the pickup place.');
    expect(rt).not.toContain('Passengers:');

    const parcel = await u.mcp.client.getPrompt({ name: 'send_parcel', arguments: { to: 'Silom', weight_kg: '3.5' } });
    expect((parcel.messages[0].content as { text: string }).text).toContain('3.5 kg');

    const ph = await u.mcp.client.getPrompt({ name: 'pharmacy', arguments: { need: 'plasters' } });
    expect((ph.messages[0].content as { text: string }).text).toContain('no prescription medicines');
  });

  it('prompts/get rejects invalid arguments and unknown prompts', async () => {
    await expect(u.mcp.client.getPrompt({ name: 'order_food', arguments: {} })).rejects.toThrow(/Invalid arguments/);
    await expect(u.mcp.client.getPrompt({ name: 'order_food', arguments: { request: 'x'.repeat(301) } })).rejects.toThrow(/Invalid arguments/);
    await expect(u.mcp.client.getPrompt({ name: 'send_parcel', arguments: { to: 'Silom', weight_kg: 'heavy' } })).rejects.toThrow(/Invalid arguments/);
    await expect(u.mcp.client.getPrompt({ name: 'place_order_now', arguments: {} })).rejects.toThrow(/not found/);
  });

  it('serves the server card on both paths, built from the registered tools and prompts', async () => {
    const { tools } = await u.mcp.client.listTools();
    for (const url of ['/.well-known/mcp/server-card.json', '/.well-known/mcp.json']) {
      const r = await h.app.inject({ method: 'GET', url, headers: { origin: 'https://inspector.example' } });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.headers['access-control-allow-origin']).toBe('*');
      expect(r.headers['cache-control']).toBe('public, max-age=3600');
      expect(r.headers['set-cookie']).toBeUndefined();
      const card = r.json();
      expect(card.version).toBe('1.0');
      expect(card.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      expect(card.serverInfo).toMatchObject({ name: 'unyly', title: 'Unyly', version: '1.0.0', websiteUrl: 'http://localhost:3000' });
      expect(card.serverInfo.icons).toHaveLength(2);
      expect(card.transport).toEqual({ type: 'streamable-http', endpoint: 'http://localhost:3000/mcp' });
      expect(card.capabilities).toMatchObject({ tools: {}, prompts: {} });
      expect(card.authentication).toMatchObject({ required: true, schemes: ['oauth2'] });
      expect(card.authentication.oauth2.protectedResourceMetadata).toMatch(/\/\.well-known\/oauth-protected-resource/);
      expect(card.documentationUrl).toBe('http://localhost:3000/docs');
      expect(card.disclaimer).toMatch(/not affiliated with or endorsed by Grab/);
      expect(card.tools.map((t: any) => t.name)).toEqual(tools.map((t) => t.name));
      for (const t of card.tools) {
        const live = tools.find((x) => x.name === t.name)!;
        expect(t.title).toBe(live.title);
        expect(t.description).toBe(live.description);
      }
      expect(card.prompts.map((p: any) => p.name).sort()).toEqual(Object.keys(PROMPTS).sort());
      expect(JSON.stringify(card)).not.toContain('\u2014');
    }
    // CORS preflight for the card.
    const pre = await h.app.inject({ method: 'OPTIONS', url: '/.well-known/mcp/server-card.json', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'GET' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
  });
});
