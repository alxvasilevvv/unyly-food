# Unyly Partner API (v1)

Server-to-server API for assistant apps (Ari first) that order Grab services through Unyly. JSON in, JSON out, every request signed. The machine-readable description is public at `GET /partner/v1/openapi.json`; the Russian integration guide is served at `/static/docs/ari-integration-ru.md`.

The flow is always the same: call a tool, render the card that comes back, let the user tap, report the tap to the confirm endpoint, then follow the order through events.

## Setup

A partner is configured on the Unyly server with environment variables:

| Variable | Meaning |
| --- | --- |
| `PARTNERS=ari` | Comma-separated partner ids |
| `PARTNER_ARI_SECRET` | Request signing secret, 32+ characters (`openssl rand -hex 32`) |
| `PARTNER_ARI_MODE` | `demo` (default) or `live` |
| `PARTNER_ARI_NAME` | Display name |
| `PARTNER_ARI_WEBHOOK_URL` | Where Unyly sends events (optional; https in production) |
| `PARTNER_ARI_WEBHOOK_SECRET` | Webhook signing secret. Required with a webhook URL, 32+ characters, different from the request secret |
| `PARTNER_ARI_RETURN_URL` | Where Login with Grab returns (https or an app scheme) |

## Authentication

Every request carries four headers:

| Header | Value |
| --- | --- |
| `X-Unyly-Partner` | Partner id, for example `ari` |
| `X-Unyly-Timestamp` | Unix seconds, within 300 s of the server clock (`GET /partner/v1/ping` returns the server time) |
| `X-Unyly-Nonce` | 16 to 64 characters of `A-Z a-z 0-9 _ -`, single use |
| `X-Unyly-Signature` | `v1=` + hex HMAC-SHA256 of the canonical string with the partner secret |

```
canonical = "v1\n" + METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(sha256(raw body))
```

Rules that matter in practice:

- `PATH_WITH_QUERY` is the request target exactly as sent, for example `/partner/v1/users/user%3A1/events?after=12`. Sign the same bytes you put on the wire. Action paths inside cards are already encoded: use them as they are.
- The body hash covers the exact bytes sent. An empty body hashes the empty string.
- GET and HEAD requests must not carry a body (it is ignored, so a signature computed over it fails).
- A missing, wrong, stale or replayed signature always answers the same `401 PARTNER_AUTH_FAILED`.
- Bodies are JSON objects with `Content-Type: application/json`, at most 64 KB.
- User ids are yours: 1 to 128 characters of letters, digits and `. _ : @ -`. Unyly never sees your users' credentials.

## Endpoints

All paths start with `/partner/v1`. `{uid}` is your user id.

| Method and path | Purpose |
| --- | --- |
| `GET /openapi.json` | OpenAPI document (public, unsigned) |
| `GET /ping` | Check credentials and clock; returns `partner`, `mode`, `time` |
| `GET /catalog?lang=en\|ru\|th` | Grab products and markets with integration status |
| `GET /tools` | Tool definitions (name, description, JSON Schema) and system instructions for your LLM |
| `PUT /users/{uid}` | Create or update the user: `locale`, `region`, `display_name`. 201 on first use |
| `GET /users/{uid}` | Read the user and the Grab link status |
| `DELETE /users/{uid}` | Delete the user and all their Unyly data |
| `GET /users/{uid}/places` | Saved places (delivery addresses, ride shortcuts such as Home) |
| `POST /users/{uid}/places` | Add a place: `label`, `line1`, `district`, `city`, optional `country`, `instructions`, `latitude`, `longitude`, `is_default` |
| `DELETE /users/{uid}/places/{pid}` | Delete a place |
| `POST /users/{uid}/tools/{name}` | Call a tool with `{ "arguments": { ... } }`. Returns the tool envelope plus `card` |
| `GET /users/{uid}/checkouts/{cid}` | Current checkout card |
| `POST /users/{uid}/checkouts/{cid}/confirm` | The user confirmed. Approves and places the order. Idempotent |
| `POST /users/{uid}/checkouts/{cid}/decline` | The user tapped Not now |
| `GET /users/{uid}/orders?limit=10` | Recent orders (1 to 50) |
| `GET /users/{uid}/orders/{oid}` | Order card with live status |
| `POST /users/{uid}/orders/{oid}/cancel` | Prepare a cancellation: returns a card with the fee |
| `GET /users/{uid}/cancellations/{xid}` | Cancellation card |
| `POST /users/{uid}/cancellations/{xid}/confirm` | The user confirmed the cancellation |
| `GET /users/{uid}/events?after=0` | Events after a sequence number, up to 50 per call |
| `GET /users/{uid}/grab` | Grab account link status |
| `POST /users/{uid}/grab/link` | Start Login with Grab |
| `DELETE /users/{uid}/grab` | Unlink the Grab account |

Every route except `PUT /users/{uid}` needs an existing user (404 `NOT_FOUND` otherwise). There are no trailing slashes.

### Tools

The tool catalog is the same one the Unyly MCP server exposes, minus `submit_order` and `cancel_order` (those happen through the confirm endpoints). The two shortest paths:

- Food or shop: `search_stores`, then `create_cart { store_id, items }`.
- Ride or parcel: `estimate_trip { service, pickup, dropoff }`, then `create_cart { service, pickup, dropoff, items: [{ item_id, quantity: 1 }] }` (`parcel_weight_kg` for `express`).

A tool call answers `200` with `{ ok: true, mode, result, next_actions, notices, card }`, or `422` with `{ ok: false, error, card: null }` when the tool refused (unknown place, closed store, invalid arguments). `card` is `null` when the result has nothing to show.

### Confirming

The checkout card has a `confirm` action with a ready `endpoint` (method, path, body with `confirm_hash`). After the user taps (and passes Face ID or the passcode when `requires_user_verification` is `biometric`), send:

```json
{ "confirm_hash": "<from the card>", "user_verification": "tap | biometric | passcode", "confirmed_at": "<ISO time of the tap>", "device_id": "<optional>" }
```

The answer is `{ ok: true, checkout, order: { id, card } }`.

- `confirm_hash` binds the confirmation to the cart, price, address and payment method the card showed. If anything changed: `409 CONFIRM_HASH_MISMATCH`; fetch the checkout card again and ask the user again.
- Totals at or above the step-up threshold (about 2,000 THB) need `biometric` or `passcode`; `tap` answers `403 STEP_UP_REQUIRED`.
- `confirmed_at` must be within the last 10 minutes.
- Repeating the call, including several calls in parallel, never creates a second order: every call returns the same order. If the provider is still answering, `order` is `null` and `checkout.submission.status` is `in_flight`; call confirm again or wait for `order.created`.
- A chat message that says "yes" is not a confirmation. Only the tap on the card is.

## Cards

One schema, `unyly.card.v1`, for every service. Texts are localized to the user's locale (English, Russian, Thai; other locales get English).

| Field | Meaning |
| --- | --- |
| `type` | `options`, `checkout`, `order`, `cancellation`, `handoff` or `message` |
| `id`, `service`, `title`, `subtitle`, `badges`, `footnote` | Identity and display texts |
| `demo` | `true` when nothing is delivered or charged |
| `route` | Trips: `from`, `to`, `distance_km`, `minutes` |
| `options[]` | `id`, `title`, `subtitle`, `price`, `eta`, `badges`, and either `action` or `disabled_reason` |
| `lines[]`, `breakdown[]`, `total` | Checkout and order contents; `total` has `amount_minor` and `currency` |
| `status` | Orders: `code`, `label`, `progress` (0 to 1), `is_final`, `eta_at`, `steps[]` |
| `courier` | Demo orders: a fictional driver or courier (`fictional: true`) |
| `actions[]` | `id`, `label`, `style`, `kind`, plus what to do |
| `expires_at` | Open checkouts and cancellations |

Action kinds: `tool` (call `tool.name` with `tool.arguments`), `confirm` (verify the user as `requires_user_verification` says, then call `endpoint` adding `user_verification`), `decline` (call `endpoint` when present, otherwise just close the card), `prepare_cancel` (call `endpoint`, show the cancellation card), `open_url`.

## Events

The same events are delivered by webhook (when a webhook URL is configured) and readable by polling `GET /users/{uid}/events?after=<seq>`.

```json
{ "event_id": "uuid", "seq": 245, "type": "order.status_changed", "partner_id": "ari", "user_id": "<your id>", "created_at": "...", "data": { }, "notify": { } }
```

Types: `order.created`, `order.status_changed`, `checkout.confirmed`, `cancellation.confirmed`, `grab.linked`, `grab.unlinked`. Order events carry `notify` with a localized `title` and `body`, a `level` (`info`, `important`, `urgent`), a `live_activity` state and `suggest_call` when the assistant should ring the user.

Webhooks are POSTed with the same four signature headers, signed with the webhook secret over the webhook URL's path and query, plus `X-Unyly-Event` and `X-Unyly-Delivery` (the event id, for deduplication). Answer 2xx within 4 seconds. Failed deliveries are retried up to 12 times with exponential backoff (10 seconds up to 1 hour). `seq` is the same number in both channels, so a receiver that missed webhooks can resume by polling from the last `seq` it saw. Events are kept for 30 days.

## Errors

Every error from `/partner/v1/*` has one shape:

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "...", "details": { }, "user_action": "..." } }
```

`details` and `user_action` are optional. Tool refusals use the same `error` object inside the tool envelope.

| HTTP | Codes |
| --- | --- |
| 400 | `VALIDATION_FAILED` (invalid JSON, wrong content type, non-object body, bad field) |
| 401 | `PARTNER_AUTH_FAILED` |
| 403 | `STEP_UP_REQUIRED` |
| 404 | `NOT_FOUND` (unknown user, id, tool, path or method) |
| 409 | `CONFIRM_HASH_MISMATCH`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_INVALIDATED`, `CANCELLATION_NOT_ALLOWED`, and cart or place problems such as `PLACE_AMBIGUOUS` |
| 413 | `PAYLOAD_TOO_LARGE` (body above 64 KB) |
| 422 | Tool refusals, `PROVIDER_REJECTED` |
| 429 | `RATE_LIMITED` |
| 503 | `NOT_CONFIGURED`, `SUBMISSIONS_PAUSED`, `PROVIDER_UNAVAILABLE` |

Unknown paths, wrong methods and trailing slashes under `/partner/v1` answer the JSON `404 NOT_FOUND` after the signature check; without a valid signature they answer `401` like everything else. One exception is outside the API's control: a URL with a broken percent escape (`%ZZ`) is refused by the HTTP layer with its own 400 body before routing.

Rate limits: 600 requests per minute per user, 120 per minute per user for tool calls. More than 300 requests per minute with a missing or bad signature from one IP address (one /64 for IPv6) get `429` instead of `401` for the rest of that minute. Correctly signed requests are never refused by this limit.

Every signed response carries `Server-Timing: app;dur=<ms>`: the time Unyly spent on the request, which helps to tell server time from network time.

## Demo and live

| | `demo` | `live` |
| --- | --- | --- |
| Stores, fares, places | Synthetic (Bangkok landmarks and districts) | Grab APIs that are switched on for this deployment |
| Orders | Simulated, nothing delivered or charged; a trip plays through in about two minutes | Real orders through Grab |
| Cards | `demo: true`, a demo badge and a fictional courier | No demo badge, no courier block |
| Login with Grab | Links a simulated account at once | `503 NOT_CONFIGURED` until GrabID credentials and the partner redirect URI are registered |
| Prepaid orders (GrabPay) | Not applicable | Confirm answers `503 NOT_CONFIGURED` until the GrabPay merchant account is enabled; nothing is ordered or charged |

`GET /ping` and every tool result report the mode. Tell the user when it is a demo.

## Example: a ride end to end (Node 18+)

Start a local server with `PARTNERS=ari PARTNER_ARI_SECRET=<64 hex> PARTNER_ARI_MODE=demo PORT=3300`, save this as `ride.mjs` and run `PARTNER_ARI_SECRET=<same> node ride.mjs`.

```js
import { createHash, createHmac, randomBytes } from 'node:crypto';
const BASE = 'http://localhost:3300', ID = 'ari', SECRET = process.env.PARTNER_ARI_SECRET;
async function api(method, path, body) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(18).toString('base64url');
  const canonical = ['v1', method, path, ts, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  const sig = 'v1=' + createHmac('sha256', SECRET).update(canonical).digest('hex');
  const headers = { 'x-unyly-partner': ID, 'x-unyly-timestamp': ts, 'x-unyly-nonce': nonce, 'x-unyly-signature': sig, ...(raw && { 'content-type': 'application/json' }) };
  const res = await fetch(BASE + path, { method, headers, body: raw || undefined });
  const json = await res.json();
  if (!json.ok) throw new Error(`${res.status} ${json.error.code}: ${json.error.message}`);
  return json;
}
const U = '/partner/v1/users/demo-user-1';
await api('PUT', U, { locale: 'en', region: 'TH' });
const trip = await api('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi airport' } });
const choice = trip.card.options.find((o) => o.action); // the user picks a vehicle
const cart = await api('POST', `${U}/tools/create_cart`, { arguments: choice.action.tool.arguments });
const confirm = cart.card.actions.find((a) => a.kind === 'confirm'); // the user taps Confirm (Face ID when "biometric")
const done = await api('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: confirm.requires_user_verification, confirmed_at: new Date().toISOString() });
console.log(`${choice.title} ${cart.card.total.value}: order ${done.order.id}, ${done.order.card.status.label}`);
console.log((await api('GET', `${U}/events?after=0`)).events.map((e) => `${e.seq} ${e.type}`).join(', '));
```

## Smoke test

`scripts/partner-smoke.mjs` runs ping, user upsert, `estimate_trip`, `create_cart`, confirm, order status and events against any deployment and prints PASS or FAIL per step:

```
BASE=https://<host> PARTNER_ID=ari PARTNER_SECRET=<secret> node scripts/partner-smoke.mjs
```

It deletes its test user at the end (`KEEP_USER=1` keeps it) and refuses to confirm when the partner runs in live mode unless `ALLOW_LIVE=1` is set, because that would place a real order.
