// OpenAPI 3.1 description of the Partner API, served at /partner/v1/openapi.json.
import type { Ctx } from '../context.js';

const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const okEnvelope = (props: Record<string, unknown>) => ({
  type: 'object', required: ['ok'], properties: { ok: { const: true }, ...props },
});
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const uid = { name: 'uid', in: 'path', required: true, description: 'Your (Ari) user id, opaque, 1 to 128 chars of [A-Za-z0-9._:@-]', schema: { type: 'string' } };
const idp = (name: string, what: string) => ({ name, in: 'path', required: true, description: `${what} id (UUID)`, schema: { type: 'string', format: 'uuid' } });
const errors = {
  '401': json(ref('Error'), 'Signature missing or invalid (PARTNER_AUTH_FAILED)'),
  '404': json(ref('Error'), 'Not found'),
  '409': json(ref('Error'), 'Conflict (for example CONFIRM_HASH_MISMATCH, CONFIRMATION_EXPIRED, PRICE_CHANGED)'),
  '429': json(ref('Error'), 'Rate limited'),
};

export function openApiDocument(ctx: Ctx) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Unyly Partner API (Ari x Grab)',
      version: '1.0.0',
      description:
        'Server-to-server API that lets a partner assistant app (Ari) order Grab services for its users. ' +
        'Every request is signed with HMAC-SHA256: canonical = "v1\\n" + METHOD + "\\n" + PATH_WITH_QUERY + "\\n" + X-Unyly-Timestamp + "\\n" + X-Unyly-Nonce + "\\n" + hex(sha256(raw body)); ' +
        'X-Unyly-Signature = "v1=" + hex(HMAC_SHA256(partner secret, canonical)). Timestamps must be within 300 s; each nonce is accepted once. ' +
        'Nothing is ordered until the user taps Confirm on a checkout card in the app and the app calls the confirm endpoint with the card\'s confirm_hash.',
      contact: { name: 'Unyly', email: 'alxvasilevv@gmail.com', url: ctx.cfg.webOrigin },
    },
    servers: [{ url: ctx.cfg.webOrigin }],
    security: [{ partner: [], timestamp: [], nonce: [], signature: [] }],
    paths: {
      '/partner/v1/ping': { get: { summary: 'Check credentials and clock', responses: { '200': json(okEnvelope({ partner: { type: 'string' }, mode: { enum: ['demo', 'live'] }, time: { type: 'string', format: 'date-time' } })), ...errors } } },
      '/partner/v1/catalog': {
        get: {
          summary: 'Grab products and markets with integration status',
          parameters: [{ name: 'lang', in: 'query', schema: { enum: ['en', 'ru', 'th'] } }],
          responses: { '200': json(okEnvelope({ products: { type: 'array', items: { type: 'object' } }, markets: { type: 'array', items: { type: 'object' } } })), ...errors },
        },
      },
      '/partner/v1/tools': {
        get: {
          summary: 'Tool definitions for your LLM (name, description, JSON Schema input) and the instructions to put in its system prompt',
          responses: { '200': json(okEnvelope({ instructions: { type: 'string' }, tools: { type: 'array', items: ref('ToolDef') } })), ...errors },
        },
      },
      '/partner/v1/users/{uid}': {
        put: {
          summary: 'Create or update the user (call on first use and when locale or region changes)', parameters: [uid],
          requestBody: { content: { 'application/json': { schema: ref('UserInput') } } },
          responses: { '200': json(okEnvelope({ user: ref('User'), grab: ref('GrabLink') })), '201': json(okEnvelope({ user: ref('User'), grab: ref('GrabLink') }), 'Created'), ...errors },
        },
        get: { summary: 'Read the user', parameters: [uid], responses: { '200': json(okEnvelope({ user: ref('User'), grab: ref('GrabLink') })), ...errors } },
        delete: { summary: 'Delete the user and all their Unyly data', parameters: [uid], responses: { '200': json(okEnvelope({ deleted: { const: true } })), ...errors } },
      },
      '/partner/v1/users/{uid}/places': {
        get: { summary: 'Saved places (delivery addresses, ride shortcuts)', parameters: [uid], responses: { '200': json(okEnvelope({ places: { type: 'array', items: ref('Place') } })), ...errors } },
        post: {
          summary: 'Add a place (becomes the default unless is_default is false)', parameters: [uid],
          requestBody: { required: true, content: { 'application/json': { schema: ref('PlaceInput') } } },
          responses: { '201': json(okEnvelope({ place: ref('Place') }), 'Created'), ...errors },
        },
      },
      '/partner/v1/users/{uid}/places/{pid}': { delete: { summary: 'Delete a place', parameters: [uid, idp('pid', 'Place')], responses: { '200': json(okEnvelope({ deleted: { const: true } })), ...errors } } },
      '/partner/v1/users/{uid}/tools/{name}': {
        post: {
          summary: 'Call a tool for this user. The result is the same envelope as the MCP server plus a renderable card.',
          parameters: [uid, { name: 'name', in: 'path', required: true, schema: { type: 'string', examples: ['search_stores', 'estimate_trip', 'create_cart'] } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { arguments: { type: 'object' } } } } } },
          responses: { '200': json(ref('ToolResult')), '422': json(ref('ToolResult'), 'Tool error (ok: false, error.code, error.user_action, next_actions)'), ...errors },
        },
      },
      '/partner/v1/users/{uid}/checkouts/{cid}': { get: { summary: 'Current checkout card (re-fetch after CONFIRM_HASH_MISMATCH)', parameters: [uid, idp('cid', 'Checkout')], responses: { '200': json(okEnvelope({ card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/checkouts/{cid}/confirm': {
        post: {
          summary: 'The user tapped Confirm (Face ID for large totals). Approves and places the order. Idempotent.',
          parameters: [uid, idp('cid', 'Checkout')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ConfirmInput') } } },
          responses: {
            '200': json(okEnvelope({ checkout: { type: 'object' }, order: { type: ['object', 'null'], properties: { id: { type: 'string' }, card: ref('Card') } }, payment: { type: 'object', description: 'Live GrabPay only: pay_url to open' } })),
            '403': json(ref('Error'), 'STEP_UP_REQUIRED: verify with Face ID or passcode and send user_verification "biometric"'),
            ...errors,
          },
        },
      },
      '/partner/v1/users/{uid}/checkouts/{cid}/decline': { post: { summary: 'The user tapped Not now', parameters: [uid, idp('cid', 'Checkout')], responses: { '200': json(okEnvelope({ checkout: { type: 'object' } })), ...errors } } },
      '/partner/v1/users/{uid}/orders': { get: { summary: 'Recent orders', parameters: [uid, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }], responses: { '200': json(okEnvelope({ orders: { type: 'array', items: { type: 'object' } } })), ...errors } } },
      '/partner/v1/users/{uid}/orders/{oid}': { get: { summary: 'Order card with live status (refreshed from the provider)', parameters: [uid, idp('oid', 'Order')], responses: { '200': json(okEnvelope({ card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/orders/{oid}/cancel': { post: { summary: 'Prepare a cancellation: returns a card with the fee to confirm', parameters: [uid, idp('oid', 'Order')], responses: { '200': json(okEnvelope({ cancellation: { type: 'object' }, card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/cancellations/{xid}': { get: { summary: 'Cancellation card', parameters: [uid, idp('xid', 'Cancellation')], responses: { '200': json(okEnvelope({ card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/cancellations/{xid}/confirm': {
        post: {
          summary: 'The user confirmed the cancellation (and any fee)', parameters: [uid, idp('xid', 'Cancellation')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ConfirmInput') } } },
          responses: { '200': json(okEnvelope({ cancellation: { type: 'object' }, order: { type: 'object' } })), ...errors },
        },
      },
      '/partner/v1/users/{uid}/events': {
        get: {
          summary: 'Events for this user after a sequence number (same events as the webhook)', parameters: [uid, { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } }],
          responses: { '200': json(okEnvelope({ events: { type: 'array', items: ref('Event') } })), ...errors },
        },
      },
      '/partner/v1/users/{uid}/grab': {
        get: { summary: 'Grab account link status', parameters: [uid], responses: { '200': json(okEnvelope({ grab: ref('GrabLink') })), ...errors } },
        delete: { summary: 'Unlink the Grab account', parameters: [uid], responses: { '200': json(okEnvelope({ grab: ref('GrabLink') })), ...errors } },
      },
      '/partner/v1/users/{uid}/grab/link': { post: { summary: 'Start Login with Grab (demo: links a simulated account at once)', parameters: [uid], responses: { '200': json(okEnvelope({ status: { enum: ['linked', 'authorize'] }, authorize_url: { type: 'string' } })), '503': json(ref('Error'), 'NOT_CONFIGURED until GrabID is issued'), ...errors } } },
    },
    webhooks: {
      partnerEvent: {
        post: {
          summary: 'Unyly to partner: order and account events (signed with the same scheme, using the webhook secret)',
          requestBody: { content: { 'application/json': { schema: ref('Event') } } },
          responses: { '200': { description: 'Received. Any 2xx stops retries (up to 12 attempts with exponential backoff).' } },
        },
      },
    },
    components: {
      securitySchemes: {
        partner: { type: 'apiKey', in: 'header', name: 'X-Unyly-Partner', description: 'Partner id, for example "ari"' },
        timestamp: { type: 'apiKey', in: 'header', name: 'X-Unyly-Timestamp', description: 'Unix seconds' },
        nonce: { type: 'apiKey', in: 'header', name: 'X-Unyly-Nonce', description: '16 to 64 chars [A-Za-z0-9_-], single use' },
        signature: { type: 'apiKey', in: 'header', name: 'X-Unyly-Signature', description: 'v1=<hex HMAC-SHA256>' },
      },
      schemas: {
        Error: { type: 'object', properties: { ok: { const: false }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' }, user_action: { type: 'string' } } } } },
        UserInput: { type: 'object', properties: { locale: { enum: ['en', 'th', 'vi', 'id', 'ms', 'fil', 'km', 'my', 'zh', 'ru'] }, region: { enum: ['TH', 'SG', 'MY', 'ID', 'VN', 'PH', 'KH', 'MM'] }, display_name: { type: 'string', maxLength: 60 } } },
        User: { type: 'object', properties: { user_id: { type: 'string' }, display_name: { type: ['string', 'null'] }, locale: { type: 'string' }, region: { type: 'string' }, mode: { enum: ['demo', 'live'] }, created: { type: 'boolean' } } },
        GrabLink: { type: 'object', properties: { linked: { type: 'boolean' }, linked_at: { type: ['string', 'null'] }, simulated: { type: 'boolean' } } },
        PlaceInput: { type: 'object', required: ['label', 'line1', 'district', 'city'], properties: { label: { type: 'string' }, line1: { type: 'string' }, district: { type: 'string' }, city: { type: 'string' }, country: { type: 'string' }, instructions: { type: 'string' }, is_default: { type: 'boolean' } } },
        Place: { type: 'object', properties: { place_id: { type: 'string' }, label: { type: 'string' }, area: { type: 'string' }, is_default: { type: 'boolean' } } },
        ToolDef: { type: 'object', properties: { name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, input_schema: { type: 'object' }, read_only: { type: 'boolean' } } },
        ToolResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, mode: { enum: ['demo', 'live', 'handoff', null] }, data_as_of: { type: 'string' }, result: { type: 'object' },
            error: { type: 'object' }, next_actions: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, why: { type: 'string' } } } },
            notices: { type: 'array', items: { type: 'string' } }, card: { oneOf: [ref('Card'), { type: 'null' }] },
          },
        },
        ConfirmInput: {
          type: 'object', required: ['confirm_hash', 'user_verification'],
          properties: {
            confirm_hash: { type: 'string', description: 'From the confirm action of the card the user saw' },
            user_verification: { enum: ['tap', 'biometric', 'passcode'], description: 'biometric or passcode is required when the card says requires_user_verification: biometric' },
            confirmed_at: { type: 'string', format: 'date-time', description: 'Time of the tap (within the last 10 minutes)' },
            device_id: { type: 'string', maxLength: 80 },
          },
        },
        CardAction: {
          type: 'object',
          properties: {
            id: { type: 'string' }, label: { type: 'string' }, style: { enum: ['primary', 'secondary', 'destructive', 'link'] },
            kind: { enum: ['confirm', 'decline', 'tool', 'open_url', 'prepare_cancel', 'refresh'] },
            requires_user_verification: { enum: ['tap', 'biometric'] },
            endpoint: { type: 'object', properties: { method: { enum: ['GET', 'POST'] }, path: { type: 'string' }, body: { type: 'object' } } },
            tool: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } },
            url: { type: 'string' },
          },
        },
        Card: {
          type: 'object', required: ['schema', 'type', 'id', 'title', 'demo', 'actions'],
          properties: {
            schema: { const: 'unyly.card.v1' }, type: { enum: ['options', 'checkout', 'order', 'orders', 'cancellation', 'handoff', 'message'] },
            id: { type: 'string' }, service: { enum: ['food', 'mart', 'ride', 'express'] }, title: { type: 'string' }, subtitle: { type: 'string' }, demo: { type: 'boolean' },
            badges: { type: 'array', items: { type: 'string' } },
            route: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, distance_km: { type: 'number' }, minutes: { type: 'number' } } },
            options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' }, price: { type: 'string' }, eta: { type: 'string' }, badges: { type: 'array', items: { type: 'string' } }, disabled_reason: { type: 'string' }, action: ref('CardAction') } } },
            lines: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, quantity: { type: 'integer' }, detail: { type: 'string' }, value: { type: 'string' } } } },
            breakdown: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } },
            total: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, amount_minor: { type: 'integer' }, currency: { type: 'string' } } },
            status: { type: 'object', properties: { code: { type: 'string' }, label: { type: 'string' }, progress: { type: 'number' }, is_final: { type: 'boolean' }, eta_at: { type: ['string', 'null'] }, steps: { type: 'array', items: { type: 'object' } } } },
            courier: { type: 'object', properties: { name: { type: 'string' }, vehicle: { type: 'string' }, plate: { type: 'string' }, rating: { type: 'number' }, fictional: { type: 'boolean' } } },
            actions: { type: 'array', items: ref('CardAction') }, footnote: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' },
          },
        },
        Event: {
          type: 'object',
          properties: {
            event_id: { type: 'string' }, seq: { type: 'integer' },
            type: { enum: ['order.created', 'order.status_changed', 'checkout.confirmed', 'cancellation.confirmed', 'grab.linked', 'grab.unlinked'] },
            partner_id: { type: 'string' }, user_id: { type: 'string' }, created_at: { type: 'string' }, data: { type: 'object' },
            notify: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, level: { enum: ['info', 'important', 'urgent'] }, suggest_call: { type: 'boolean' }, live_activity: { type: 'object', properties: { state: { type: 'string' }, progress: { type: 'number' }, eta_at: { type: ['string', 'null'] } } } } },
          },
        },
      },
    },
  };
}
