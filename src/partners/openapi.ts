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
  '400': json(ref('Error'), 'VALIDATION_FAILED: the path, query or body is wrong (the message names the field). Also: invalid JSON, a Content-Type other than application/json, a body that is not a JSON object, a user id outside [A-Za-z0-9._:@-]{1,128}.'),
  '401': json(ref('Error'), 'PARTNER_AUTH_FAILED: signature missing, wrong, stale (more than 300 s) or replayed (nonce already used). Always the same answer.'),
  '404': json(ref('Error'), 'NOT_FOUND: unknown user (create it with PUT /partner/v1/users/{uid}), tool, checkout, order, cancellation or place; also any unknown path, wrong method or trailing slash under /partner/v1'),
  '413': json(ref('Error'), 'PAYLOAD_TOO_LARGE: the request body is larger than 64 KB'),
  '429': json(ref('Error'), 'RATE_LIMITED. Per partner user and per endpoint: 600 requests a minute, 120 a minute for tool calls. Separately, more than 300 requests a minute with a missing or invalid signature from one IP address get 429 instead of 401. Same error envelope as every other error.'),
};
const conflict = (what: string) => ({ '409': json(ref('Error'), what) });
const money = { type: 'object', properties: { amount_minor: { type: 'integer' }, currency: { type: 'string' }, formatted: { type: 'string' } } };

type Op = Record<string, unknown>;
const TAGS: [string, string][] = [
  ['/users/{uid}/places', 'Places'], ['/users/{uid}/tools', 'Tools'], ['/users/{uid}/checkouts', 'Checkout'], ['/users/{uid}/orders', 'Orders'],
  ['/users/{uid}/cancellations', 'Orders'], ['/users/{uid}/events', 'Events'], ['/users/{uid}/grab', 'Grab account'], ['/users/{uid}', 'Users'],
];
/** Adds a tag to every operation (operationId is written next to each operation). */
function tagged(paths: Record<string, Record<string, Op>>) {
  for (const [path, item] of Object.entries(paths)) {
    const tag = TAGS.find(([prefix]) => path.startsWith(`/partner/v1${prefix}`))?.[1] ?? 'Service';
    for (const op of Object.values(item)) op.tags = [tag];
  }
  return paths;
}

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
        'Nothing is ordered until the user taps Confirm on a checkout card in the app and the app calls the confirm endpoint with the card\'s confirm_hash. ' +
        'Path parameters: {uid} is the partner\'s own user id; {cid}, {oid}, {xid} and {pid} are the checkout, order, cancellation and place ids (UUIDs) that Unyly returns. ' +
        'In demo mode every store, fare, order, driver and courier is fictional and nothing is delivered or charged.',
      contact: { name: 'Unyly', email: 'alxvasilevv@gmail.com', url: ctx.cfg.webOrigin },
    },
    servers: [{ url: ctx.cfg.webOrigin }],
    security: [{ partner: [], timestamp: [], nonce: [], signature: [] }],
    tags: [
      { name: 'Service' }, { name: 'Users' }, { name: 'Places' }, { name: 'Tools' }, { name: 'Checkout' }, { name: 'Orders' }, { name: 'Events' }, { name: 'Grab account' },
    ],
    paths: tagged({
      '/partner/v1/openapi.json': { get: { operationId: 'getOpenApi', summary: 'This document (public, no signature)', security: [], responses: { '200': json({ type: 'object' }) } } },
      '/partner/v1/ping': { get: { operationId: 'ping', summary: 'Check credentials and clock', responses: { '200': json(okEnvelope({ partner: { type: 'string' }, mode: { enum: ['demo', 'live'] }, time: { type: 'string', format: 'date-time', description: 'Server time: compare with your clock when signatures fail' } })), ...errors } } },
      '/partner/v1/catalog': {
        get: {
          operationId: 'getCatalog',
          summary: 'Grab products and markets with integration status',
          parameters: [{ name: 'lang', in: 'query', description: 'Default en; any other value is treated as en', schema: { enum: ['en', 'ru', 'th'] } }],
          responses: { '200': json(okEnvelope({ products: { type: 'array', items: { type: 'object' } }, markets: { type: 'array', items: { type: 'object' } } })), ...errors },
        },
      },
      '/partner/v1/tools': {
        get: {
          operationId: 'listTools',
          summary: 'Tool definitions for your LLM (name, description, JSON Schema input) and the instructions to put in its system prompt',
          responses: { '200': json(okEnvelope({ instructions: { type: 'string' }, tools: { type: 'array', items: ref('ToolDef') } })), ...errors },
        },
      },
      '/partner/v1/users/{uid}': {
        put: {
          operationId: 'upsertUser',
          summary: 'Create or update the user (call on first use and when locale or region changes). 201 when created, 200 when it existed.', parameters: [uid],
          requestBody: { description: 'Optional: without a body a new user gets locale en and region TH.', content: { 'application/json': { schema: ref('UserInput') } } },
          responses: { '200': json(okEnvelope({ user: ref('User'), grab: ref('GrabLink') }), 'Existing user (user.created is false)'), '201': json(okEnvelope({ user: ref('User'), grab: ref('GrabLink') }), 'Created (user.created is true)'), ...errors },
        },
        get: { operationId: 'getUser', summary: 'Read the user', parameters: [uid], responses: { '200': json(okEnvelope({ user: ref('User'), grab: ref('GrabLink') })), ...errors } },
        delete: { operationId: 'deleteUser', summary: 'Delete the user and all their Unyly data. The same id can be created again later and starts empty.', parameters: [uid], responses: { '200': json(okEnvelope({ deleted: { const: true } })), ...errors } },
      },
      '/partner/v1/users/{uid}/places': {
        get: { operationId: 'listPlaces', summary: 'Saved places (delivery addresses, ride shortcuts)', parameters: [uid], responses: { '200': json(okEnvelope({ places: { type: 'array', items: ref('Place') } })), ...errors } },
        post: {
          operationId: 'addPlace',
          summary: 'Add a place (becomes the default unless is_default is false). Answers 201.', parameters: [uid],
          description: '400 VALIDATION_FAILED with error.details.fields when a required field is missing or the address is incomplete (for example line1 without a house number).',
          requestBody: { required: true, content: { 'application/json': { schema: ref('PlaceInput') } } },
          responses: { '201': json(okEnvelope({ place: ref('Place') }), 'Created'), ...errors },
        },
      },
      '/partner/v1/users/{uid}/places/{pid}': { delete: { operationId: 'deletePlace', summary: 'Delete a place', parameters: [uid, idp('pid', 'Place')], responses: { '200': json(okEnvelope({ deleted: { const: true } })), ...errors } } },
      '/partner/v1/users/{uid}/tools/{name}': {
        post: {
          operationId: 'callTool',
          summary: 'Call a tool for this user. The result is the same envelope as the MCP server plus a renderable card.',
          description:
            'Every error a tool itself reports comes back as HTTP 422 with ok: false and the reason in error.code (for example PLACE_NOT_FOUND, PLACE_AMBIGUOUS, ' +
            'VALIDATION_FAILED for wrong arguments, NOT_FOUND for an unknown order id, PRICE_CHANGED): branch on error.code, not on the HTTP status. ' +
            'HTTP 404 means the user or the tool name is unknown; HTTP 400 means the request itself is malformed or the tool is not available to partner apps (submit_order, cancel_order). ' +
            'Cards: search_stores and estimate_trip return an options card; create_cart and update_cart return a checkout card (or a message card when something blocks the order); ' +
            'prepare_cancellation returns a cancellation card. Other tools return card: null: after prepare_checkout read the card with GET /partner/v1/users/{uid}/checkouts/{cid}, ' +
            'after get_order_status with GET /partner/v1/users/{uid}/orders/{oid}. When card is not null, show it.',
          parameters: [uid, { name: 'name', in: 'path', required: true, description: 'A tool name from GET /partner/v1/tools', schema: { type: 'string', examples: ['search_stores', 'estimate_trip', 'create_cart'] } }],
          requestBody: { description: 'Optional for tools without arguments.', content: { 'application/json': { schema: { type: 'object', properties: { arguments: { type: 'object', description: 'Arguments as the tool\'s input_schema describes them' } } } } } },
          responses: { '200': json(ref('ToolResult')), '422': json(ref('ToolResult'), 'Tool error (ok: false, error.code, error.message, error.user_action, next_actions, card: null). All tool-level errors use 422.'), ...errors },
        },
      },
      '/partner/v1/users/{uid}/checkouts/{cid}': { get: { operationId: 'getCheckoutCard', summary: 'Current card of this checkout (re-fetch after CONFIRM_HASH_MISMATCH). A checkout that was confirmed, replaced or declined returns its card with an empty actions list; the new card comes in the create_cart or update_cart result.', parameters: [uid, idp('cid', 'Checkout')], responses: { '200': json(okEnvelope({ card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/checkouts/{cid}/confirm': {
        post: {
          operationId: 'confirmCheckout',
          summary: 'The user tapped Confirm (Face ID for large totals). Approves and places the order. Idempotent.',
          description:
            'Returns 200 with order { id, card } once the provider accepted the order. order is null in three cases, told apart by checkout.submission.status: ' +
            '"unknown" (the provider has not answered; Unyly keeps checking), "in_flight" (a parallel confirm call is still sending the order) and, on a repeated call only, "rejected" (the provider refused, nothing was ordered). ' +
            'For "unknown" and "in_flight" do not confirm a second checkout: wait for the order.created event or repeat this call (it never creates a second order). ' +
            '409 CONFIRM_HASH_MISMATCH: the hash sent is not the one of this card. 409 CONFIRMATION_INVALIDATED: the cart changed after the card was shown (details.reason CART_CHANGED) ' +
            'or the user declined (details.reason DECLINED); this checkout stays closed and the current card is in the latest create_cart or update_cart result.',
          parameters: [uid, idp('cid', 'Checkout')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ConfirmInput') } } },
          responses: {
            '200': json(okEnvelope({ checkout: ref('CheckoutStatus'), order: { oneOf: [ref('OrderRef'), { type: 'null' }] } })),
            '403': json(ref('Error'), 'STEP_UP_REQUIRED: the card said requires_user_verification "biometric" and the call sent "tap". Verify with Face ID or passcode and send user_verification "biometric" or "passcode".'),
            ...conflict('CONFIRM_HASH_MISMATCH: the hash is not the one from the card (details.card_path is the card to re-fetch). CONFIRMATION_INVALIDATED (details.reason CART_CHANGED, DECLINED...), CONFIRMATION_EXPIRED, PRICE_CHANGED: this checkout can no longer be confirmed; call create_cart again and show the new card. OUT_OF_STOCK, RESTAURANT_CLOSED, DELIVERY_UNAVAILABLE: the provider refused at submission, nothing was ordered.'),
            '422': json(ref('Error'), 'PROVIDER_REJECTED: the provider refused the order. Nothing was ordered or charged.'),
            '503': json(ref('Error'), 'SUBMISSIONS_PAUSED or PROVIDER_UNAVAILABLE: nothing was ordered, repeat later. NOT_CONFIGURED: prepaid Live orders are not switched on for partner apps yet.'),
            ...errors,
          },
        },
      },
      '/partner/v1/users/{uid}/checkouts/{cid}/decline': { post: { operationId: 'declineCheckout', summary: 'The user tapped Not now. No body. The checkout is closed (status declined).', parameters: [uid, idp('cid', 'Checkout')], responses: { '200': json(okEnvelope({ checkout: ref('CheckoutStatus') })), ...errors } } },
      '/partner/v1/users/{uid}/orders': {
        get: {
          operationId: 'listOrders', summary: 'Recent orders, newest first',
          parameters: [uid, { name: 'limit', in: 'query', description: 'Default 10. Values outside 1 to 50 are clamped.', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }],
          responses: { '200': json(okEnvelope({ orders: { type: 'array', items: ref('OrderSummary') }, next_before: { type: ['string', 'null'], description: 'Set when there are older orders than this page (the list_orders tool takes it as before)' }, handoffs: { type: 'array', items: { type: 'object' }, description: 'Recent Handoff checklists (not orders); empty in demo and live modes' } })), ...errors },
        },
      },
      '/partner/v1/users/{uid}/orders/{oid}': { get: { operationId: 'getOrderCard', summary: 'Order card with live status (refreshed from the provider)', parameters: [uid, idp('oid', 'Order')], responses: { '200': json(okEnvelope({ card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/orders/{oid}/cancel': {
        post: {
          operationId: 'prepareCancellation',
          summary: 'Prepare a cancellation: returns a card with the fee to confirm. No body. Nothing is cancelled by this call.', parameters: [uid, idp('oid', 'Order')],
          responses: {
            '200': json(okEnvelope({ cancellation: ref('Cancellation'), card: ref('Card') })),
            ...conflict('CANCELLATION_NOT_ALLOWED: the provider no longer allows it (for example after pickup) or the order is already finished; the reason is in error.message.'),
            '503': json(ref('Error'), 'PROVIDER_UNAVAILABLE: the cancellation terms could not be read, repeat later'),
            ...errors,
          },
        },
      },
      '/partner/v1/users/{uid}/cancellations/{xid}': { get: { operationId: 'getCancellationCard', summary: 'Cancellation card (actions are empty once it is confirmed)', parameters: [uid, idp('xid', 'Cancellation')], responses: { '200': json(okEnvelope({ card: ref('Card') })), ...errors } } },
      '/partner/v1/users/{uid}/cancellations/{xid}/confirm': {
        post: {
          operationId: 'confirmCancellation',
          summary: 'The user confirmed the cancellation (and any fee). cancellation.status is executed, rejected, invalidated (the fee changed: prepare again) or unknown. Idempotent.', parameters: [uid, idp('xid', 'Cancellation')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ConfirmInput') } } },
          responses: {
            '200': json(okEnvelope({ cancellation: ref('Cancellation'), order: ref('OrderRef') })),
            ...conflict('CONFIRM_HASH_MISMATCH: the hash is not the one from the cancellation card. CONFIRMATION_EXPIRED (5 minutes passed), PRICE_CHANGED (the fee changed) or CONFIRMATION_INVALIDATED: prepare the cancellation again and show the new card. CANCELLATION_NOT_ALLOWED: another cancellation of this order is in progress.'),
            '503': json(ref('Error'), 'PROVIDER_UNAVAILABLE: nothing was cancelled, repeat later'),
            ...errors,
          },
        },
      },
      '/partner/v1/users/{uid}/events': {
        get: {
          operationId: 'listEvents',
          summary: 'Events for this user after a sequence number (same events as the webhook), oldest first, at most 50 per call',
          parameters: [uid, { name: 'after', in: 'query', description: 'Return events with seq greater than this. Default 0.', schema: { type: 'integer', minimum: 0, default: 0 } }],
          responses: { '200': json(okEnvelope({ events: { type: 'array', items: ref('Event') } })), ...errors },
        },
      },
      '/partner/v1/users/{uid}/grab': {
        get: { operationId: 'getGrabLink', summary: 'Grab account link status', parameters: [uid], responses: { '200': json(okEnvelope({ grab: ref('GrabLink') })), ...errors } },
        delete: { operationId: 'unlinkGrab', summary: 'Unlink the Grab account', parameters: [uid], responses: { '200': json(okEnvelope({ grab: ref('GrabLink') })), ...errors } },
      },
      '/partner/v1/users/{uid}/grab/link': { post: { operationId: 'startGrabLink', summary: 'Start Login with Grab. No body. Demo: links a simulated account at once.', parameters: [uid], responses: { '200': json(okEnvelope({ status: { enum: ['linked'] }, linked: { type: 'boolean' }, linked_at: { type: ['string', 'null'], format: 'date-time' }, simulated: { type: 'boolean', description: 'true for the demo link' } })), '503': json(ref('Error'), 'NOT_CONFIGURED in live mode until GrabID credentials are issued and the partner redirect URI is registered with GrabID'), ...errors } } },
    }),
    webhooks: {
      partnerEvent: {
        post: {
          operationId: 'partnerEventWebhook',
          summary: 'Unyly to partner: order and account events',
          description:
            'Signed with the same scheme as requests, using the webhook secret and the path and query of the webhook URL. Headers: the four X-Unyly signature headers, ' +
            'X-Unyly-Event (the event type) and X-Unyly-Delivery (the event_id, for deduplication). Unyly waits 4 seconds for the answer.',
          requestBody: { content: { 'application/json': { schema: ref('Event') } } },
          responses: { '200': { description: 'Received. Any 2xx stops retries (up to 12 attempts with exponential backoff from 10 seconds to 1 hour).' } },
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
        Error: {
          type: 'object', required: ['ok', 'error'],
          properties: {
            ok: { const: false },
            error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string', description: 'English, for logs and for the model; not a text for the user' }, details: { type: 'object' }, user_action: { type: 'string' } } },
          },
        },
        Money: money,
        UserInput: { type: 'object', properties: { locale: { enum: ['en', 'th', 'vi', 'id', 'ms', 'fil', 'km', 'my', 'zh', 'ru'] }, region: { enum: ['TH', 'SG', 'MY', 'ID', 'VN', 'PH', 'KH', 'MM'] }, display_name: { type: 'string', maxLength: 60, description: 'Longer values are cut to 60 characters' } } },
        User: { type: 'object', properties: { user_id: { type: 'string', description: 'Your id for this user ({uid})' }, display_name: { type: ['string', 'null'] }, locale: { type: 'string' }, region: { type: 'string' }, mode: { enum: ['demo', 'live'] }, created: { type: 'boolean', description: 'true only in the answer that created the user' } } },
        GrabLink: { type: 'object', properties: { linked: { type: 'boolean' }, linked_at: { type: ['string', 'null'] }, simulated: { type: 'boolean' } } },
        PlaceInput: { type: 'object', required: ['label', 'line1', 'district', 'city'], properties: { label: { type: 'string', description: 'Up to 40 characters, for example Home' }, line1: { type: 'string', description: 'Street address with the house number (at least 5 characters and one digit)' }, district: { type: 'string' }, city: { type: 'string' }, country: { type: 'string', description: 'One of the region codes (TH, SG, MY, ID, VN, PH, KH, MM); default: the user\'s region' }, instructions: { type: 'string' }, latitude: { type: 'number', description: 'Optional, together with longitude: exact point (needed for Live couriers and fares)' }, longitude: { type: 'number' }, is_default: { type: 'boolean', description: 'Default true' } } },
        Place: { type: 'object', properties: { place_id: { type: 'string', format: 'uuid' }, address_id: { type: 'string', format: 'uuid', description: 'Same value as place_id (the name the tools use, for example create_cart address_id)' }, label: { type: 'string' }, area: { type: 'string', description: 'District and city; the street line is not returned' }, is_default: { type: 'boolean' } } },
        ToolDef: { type: 'object', properties: { name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, input_schema: { type: 'object' }, read_only: { type: 'boolean' } } },
        ToolResult: {
          type: 'object', required: ['ok', 'card'],
          properties: {
            ok: { type: 'boolean' }, mode: { enum: ['demo', 'live', 'handoff', null] }, data_as_of: { type: 'string' }, result: { type: 'object', description: 'Data for the model (present when ok is true)' },
            error: { type: 'object', description: 'Present when ok is false', properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' }, user_action: { type: 'string' } } },
            next_actions: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, why: { type: 'string' } } } },
            notices: { type: 'array', items: { type: 'string' } }, operation_id: { type: 'string', description: 'On tool errors: quote it when asking Unyly about a failed call' },
            card: { oneOf: [ref('Card'), { type: 'null' }], description: 'For the app. null when the result has nothing to show and on every error.' },
          },
        },
        ConfirmInput: {
          type: 'object', required: ['confirm_hash', 'user_verification'],
          properties: {
            confirm_hash: { type: 'string', description: 'From endpoint.body of the confirm action of the card the user saw' },
            user_verification: { enum: ['tap', 'biometric', 'passcode'], description: 'biometric or passcode is required when the card says requires_user_verification: biometric' },
            confirmed_at: { type: 'string', format: 'date-time', description: 'Time of the tap (within the last 10 minutes). Default: now.' },
            device_id: { type: 'string', maxLength: 80 },
          },
        },
        CheckoutStatus: {
          type: 'object',
          properties: {
            checkout_id: { type: 'string', format: 'uuid' }, mode: { enum: ['demo', 'live'] },
            status: { enum: ['awaiting_user', 'awaiting_payment', 'approved', 'consumed', 'expired', 'invalidated', 'declined'], description: 'consumed: the confirmation was used to send the order' },
            invalid_reason: { type: ['string', 'null'] }, total: ref('Money'), expires_at: { type: 'string', format: 'date-time' }, approved_at: { type: ['string', 'null'], format: 'date-time' },
            submission: {
              type: ['object', 'null'], description: 'The attempt to place the order with the provider',
              properties: { submission_id: { type: 'string' }, status: { enum: ['in_flight', 'accepted', 'rejected', 'unknown'] }, provider_order_ref: { type: ['string', 'null'] }, error_code: { type: ['string', 'null'] }, message: { type: 'string' }, started_at: { type: 'string' }, finished_at: { type: ['string', 'null'] } },
            },
            order_id: { type: ['string', 'null'] }, step_up_required: { type: 'boolean' }, summary: { type: 'string', description: 'One English sentence for the model' },
          },
        },
        OrderRef: { type: 'object', required: ['id', 'card'], properties: { id: { type: 'string', format: 'uuid' }, card: ref('Card') } },
        OrderSummary: {
          type: 'object',
          properties: {
            order_id: { type: 'string', format: 'uuid' }, mode: { type: 'string' }, provider_order_ref: { type: 'string' }, service: { enum: ['food', 'mart', 'ride', 'express'] }, title: { type: 'string' },
            items: { type: 'array', items: { type: 'object' } }, trip: { type: ['string', 'null'] }, total: ref('Money'),
            fulfillment_status: { enum: ['submitted', 'accepted', 'preparing', 'picked_up', 'delivered', 'cancelled', 'failed'] }, status_label: { type: 'string' }, payment_status: { type: 'string' },
            is_final: { type: 'boolean' }, status_updated_at: { type: 'string' }, eta_estimate_at: { type: ['string', 'null'] }, placed_at: { type: 'string' },
          },
        },
        Cancellation: {
          type: 'object',
          properties: {
            cancellation_id: { type: 'string', format: 'uuid' }, order_id: { type: 'string', format: 'uuid' },
            status: { enum: ['awaiting_user', 'approved', 'executing', 'executed', 'rejected', 'expired', 'unknown', 'invalidated'] },
            fee: ref('Money'), terms: { type: 'string' }, expires_at: { type: 'string', format: 'date-time', description: '5 minutes after it was prepared' }, message: { type: 'string' },
          },
        },
        CardAction: {
          type: 'object', required: ['id', 'label', 'style', 'kind'],
          properties: {
            id: { type: 'string' }, label: { type: 'string' }, style: { enum: ['primary', 'secondary', 'destructive', 'link'] },
            kind: { enum: ['confirm', 'decline', 'tool', 'open_url', 'prepare_cancel', 'refresh'], description: 'tool: call tool.name with tool.arguments. confirm: verify the user, then call endpoint with its body plus user_verification. decline: call endpoint when present, otherwise just close the card. prepare_cancel: call endpoint and show the cancellation card. open_url: open url.' },
            requires_user_verification: { enum: ['tap', 'biometric'], description: 'On confirm actions' },
            endpoint: { type: 'object', properties: { method: { enum: ['GET', 'POST'] }, path: { type: 'string', description: 'Already percent-encoded: sign and send it as it is' }, body: { type: 'object' } } },
            tool: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } },
            url: { type: 'string' },
          },
        },
        Card: {
          type: 'object', required: ['schema', 'type', 'id', 'title', 'demo', 'actions'],
          properties: {
            schema: { const: 'unyly.card.v1' }, type: { enum: ['options', 'checkout', 'order', 'cancellation', 'handoff', 'message'] },
            id: { type: 'string', description: 'checkout, order and cancellation cards: the checkout, order or cancellation id' }, service: { enum: ['food', 'mart', 'ride', 'express'] }, title: { type: 'string' }, subtitle: { type: 'string' },
            demo: { type: 'boolean', description: 'true: fictional data, nothing is delivered or charged' },
            badges: { type: 'array', items: { type: 'string' } },
            route: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, distance_km: { type: 'number' }, minutes: { type: 'number' } } },
            options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' }, price: { type: 'string' }, eta: { type: 'string' }, badges: { type: 'array', items: { type: 'string' } }, disabled_reason: { type: 'string', description: 'Present instead of action when the option cannot be chosen (for example "Seats 4 only")' }, action: ref('CardAction') } } },
            lines: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, quantity: { type: 'integer' }, detail: { type: 'string' }, value: { type: 'string' } } } },
            breakdown: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } },
            total: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, amount_minor: { type: 'integer' }, currency: { type: 'string' } } },
            status: {
              type: 'object',
              properties: {
                code: { enum: ['submitted', 'accepted', 'preparing', 'picked_up', 'delivered', 'cancelled', 'failed'] }, label: { type: 'string' }, progress: { type: 'number', minimum: 0, maximum: 1 }, is_final: { type: 'boolean' }, eta_at: { type: ['string', 'null'] },
                steps: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, label: { type: 'string' }, done: { type: 'boolean' } } } },
              },
            },
            courier: { type: 'object', description: 'Present only when the provider supplies driver or courier details (in demo: a fictional one while the order is under way). Absent otherwise.', properties: { name: { type: 'string' }, vehicle: { type: 'string' }, plate: { type: 'string' }, rating: { type: 'number' }, fictional: { type: 'boolean' } } },
            actions: { type: 'array', items: ref('CardAction') }, footnote: { type: 'string' }, expires_at: { type: 'string', format: 'date-time', description: 'Open checkout (up to 15 minutes) and cancellation (5 minutes) cards' },
          },
        },
        Event: {
          type: 'object', required: ['event_id', 'seq', 'type', 'partner_id', 'user_id', 'created_at', 'data'],
          description:
            'The same object in the webhook body and in GET .../events. notify is present on order.created and order.status_changed, in English, Russian or Thai (English for every other user locale). ' +
            'data by type: order.created { order_id, checkout_id, service, status, total_minor, currency, title }; order.status_changed { order_id, service, status, status_label, is_final, eta_at }; ' +
            'checkout.confirmed { checkout_id, order_id (null until the provider accepts), user_verification }; cancellation.confirmed { cancellation_id, order_id, status }; grab.linked { simulated }; grab.unlinked { }.',
          properties: {
            event_id: { type: 'string', format: 'uuid' }, seq: { type: 'integer', description: 'Grows with every event (numbers are shared by all users, so one user sees gaps); pass the last one you processed as ?after= to resume' },
            type: { enum: ['order.created', 'order.status_changed', 'checkout.confirmed', 'cancellation.confirmed', 'grab.linked', 'grab.unlinked'] },
            partner_id: { type: 'string' }, user_id: { type: 'string', description: 'Your id for the user ({uid})' }, created_at: { type: 'string', format: 'date-time' }, data: { type: 'object' },
            notify: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, level: { enum: ['info', 'important', 'urgent'] }, suggest_call: { type: 'boolean', description: 'Present (true) only when the assistant should call the user' }, live_activity: { type: 'object', properties: { state: { type: 'string', description: 'The order status code' }, progress: { type: 'number' }, eta_at: { type: ['string', 'null'] } } } } },
          },
        },
      },
    },
  };
}
