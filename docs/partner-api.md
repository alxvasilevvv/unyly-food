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

All paths start with `/partner/v1`. `{uid}` is your user id; `{cid}`, `{oid}`, `{xid}` and `{pid}` are the checkout, order, cancellation and place ids (UUIDs) that Unyly returns. The OpenAPI document uses the same names. Every success answers `200` with `{ "ok": true, ... }` unless the table says otherwise.

| Method and path | Purpose |
| --- | --- |
| `GET /openapi.json` | OpenAPI document (public, unsigned) |
| `GET /ping` | Check credentials and clock; returns `partner`, `mode`, `time` |
| `GET /catalog?lang=en\|ru\|th` | Grab products and markets with integration status |
| `GET /tools` | Tool definitions (name, description, JSON Schema) and system instructions for your LLM |
| `PUT /users/{uid}` | Create or update the user: `locale`, `region`, `display_name` (all optional). `201` when created, `200` afterwards. Returns `user` and `grab` |
| `GET /users/{uid}` | Read the user and the Grab link status: `user`, `grab` |
| `DELETE /users/{uid}` | Delete the user and all their Unyly data: `{ deleted: true }` |
| `GET /users/{uid}/places` | Saved places (delivery addresses, ride shortcuts such as Home): `places[]` with `place_id`, `label`, `area`, `is_default` |
| `POST /users/{uid}/places` | Add a place: `label`, `line1` (with a house number), `district`, `city`, optional `country`, `instructions`, `latitude`, `longitude`, `is_default`. Answers `201` with `place` |
| `DELETE /users/{uid}/places/{pid}` | Delete a place |
| `POST /users/{uid}/tools/{name}` | Call a tool with `{ "arguments": { ... } }`. Returns the tool envelope plus `card`. `422` when the tool refused |
| `GET /users/{uid}/checkouts/{cid}` | Current checkout card: `card` |
| `POST /users/{uid}/checkouts/{cid}/confirm` | The user confirmed. Approves and places the order. Idempotent. Returns `checkout`, `order` |
| `POST /users/{uid}/checkouts/{cid}/decline` | The user tapped Not now (no body). Returns `checkout` |
| `GET /users/{uid}/orders?limit=10` | Recent orders, newest first (1 to 50): `orders[]`, `next_before`, `handoffs[]` |
| `GET /users/{uid}/orders/{oid}` | Order card with live status: `card` |
| `POST /users/{uid}/orders/{oid}/cancel` | Prepare a cancellation (no body): returns `cancellation` and a `card` with the fee. Nothing is cancelled yet |
| `GET /users/{uid}/cancellations/{xid}` | Cancellation card: `card` |
| `POST /users/{uid}/cancellations/{xid}/confirm` | The user confirmed the cancellation: `{ confirm_hash, user_verification }`. Returns `cancellation`, `order` |
| `GET /users/{uid}/events?after=0` | Events after a sequence number, oldest first, up to 50 per call: `events[]` |
| `GET /users/{uid}/grab` | Grab account link status: `grab` with `linked`, `linked_at`, `simulated` |
| `POST /users/{uid}/grab/link` | Start Login with Grab (no body). Demo: `{ status: "linked", linked, linked_at, simulated: true }` |
| `DELETE /users/{uid}/grab` | Unlink the Grab account: `grab` |

Every route except `PUT /users/{uid}` needs an existing user (404 `NOT_FOUND` otherwise). There are no trailing slashes.

### Tools

The tool catalog is the same one the Unyly MCP server exposes, minus `submit_order` and `cancel_order` (those happen through the confirm endpoints). The two shortest paths:

- Food or shop: `search_stores`, then `create_cart { store_id, items }`.
- Ride or parcel: `estimate_trip { service, pickup, dropoff }`, then `create_cart { service, pickup, dropoff, items: [{ item_id, quantity: 1 }] }` (`parcel_weight_kg` for `express`).

`estimate_trip` also takes `passengers` (1 to 10): vehicles with fewer seats stay on the card with `disabled_reason` (for example "Seats 4 only") and no `action`. `create_cart` has no `passengers` argument.

A tool call answers `200` with `{ ok: true, mode, data_as_of, result, next_actions, notices, card }`, or `422` with `{ ok: false, error, next_actions, notices, operation_id, card: null }` when the tool refused (unknown place, closed store, invalid arguments). Every tool refusal is a `422`: branch on `error.code`. `result` is for your model, `card` is for the app.

| Tool | Card |
| --- | --- |
| `search_stores`, `estimate_trip` | `options` |
| `create_cart`, `update_cart` | `checkout`, or `message` when something blocks the order |
| `get_order_status` | `order` |
| `prepare_cancellation` | `cancellation` |
| `get_capabilities`, `get_store`, `quote_cart`, `prepare_checkout`, `get_checkout_status`, `list_orders` | `null` |

`create_cart` and `update_cart` already quote the cart and prepare the checkout, so `quote_cart` and `prepare_checkout` are rarely needed. After `prepare_checkout` read the card with `GET /users/{uid}/checkouts/{cid}` using `result.checkout_id`.

### Confirming

The checkout card has a `confirm` action with a ready `endpoint` (method, path, body with `confirm_hash`). After the user taps (and passes Face ID or the passcode when `requires_user_verification` is `biometric`), send:

```json
{ "confirm_hash": "<from the card>", "user_verification": "tap | biometric | passcode", "confirmed_at": "<ISO time of the tap>", "device_id": "<optional>" }
```

`confirm_hash` and `user_verification` are required (`400 VALIDATION_FAILED` otherwise). The answer is `{ ok: true, checkout, order: { id, card } }`; `checkout` has `checkout_id`, `status` (`consumed` once the order was sent), `total`, `expires_at`, `approved_at`, `submission`, `order_id`, `summary`.

- `confirm_hash` binds the confirmation to the cart, price, address and payment method the card showed. A hash that is not the one of this card: `409 CONFIRM_HASH_MISMATCH`; fetch the checkout card again and ask the user again.
- A checkout whose cart changed afterwards (`update_cart`) or that the user declined is closed: `409 CONFIRMATION_INVALIDATED` with `details.reason` `CART_CHANGED` or `DECLINED`. Show the card from the latest `create_cart` or `update_cart` result. `409 CONFIRMATION_EXPIRED` after 15 minutes and `409 PRICE_CHANGED`: call `create_cart` again.
- Totals at or above the step-up threshold (2,000 THB by default) come with `requires_user_verification: "biometric"` and need `biometric` or `passcode`; `tap` answers `403 STEP_UP_REQUIRED`.
- `confirmed_at` is optional (default: now) and must be within the last 10 minutes.
- Repeating the call, including several calls in parallel, never creates a second order: every call returns the same order. `order` is `null` while the outcome is open, with `checkout.submission.status` `unknown` (the provider has not answered; Unyly keeps checking) or `in_flight` (a parallel call is still sending): call confirm again or wait for `order.created`, never confirm a second checkout for the same thing.
- When the provider refuses the order the call answers `422 PROVIDER_REJECTED` (or `409` `OUT_OF_STOCK`, `RESTAURANT_CLOSED`, `DELIVERY_UNAVAILABLE`): nothing was ordered. A repeated call then answers `200` with `order: null` and `submission.status` `rejected`.
- A chat message that says "yes" is not a confirmation. Only the tap on the card is.

### Cancelling

`POST /users/{uid}/orders/{oid}/cancel` (the `prepare_cancel` action of the order card) returns `cancellation { cancellation_id, order_id, status, fee, terms, expires_at, message }` and a `cancellation` card; `409 CANCELLATION_NOT_ALLOWED` when the order can no longer be cancelled. The card's `confirm` action carries the endpoint and `confirm_hash`; send `{ "confirm_hash": "...", "user_verification": "tap" }` within 5 minutes. The answer is `{ ok: true, cancellation, order: { id, card } }` with `cancellation.status` `executed`, `rejected` (the order continues), `invalidated` (the fee changed: prepare again) or `unknown`. The "Keep order" action is a `decline` without an endpoint: just close the card.

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
| `status` | Orders: `code` (`submitted`, `accepted`, `preparing`, `picked_up`, `delivered`, `cancelled`, `failed`), `label`, `progress` (0 to 1), `is_final`, `eta_at`, `steps[]` of `{ code, label, done }` |
| `courier` | `name`, `vehicle`, `plate`, `rating`. Present only when the provider supplies driver or courier details. Demo: a fictional one (`fictional: true`) while the order is `accepted`, `preparing` or `picked_up` |
| `actions[]` | `id`, `label`, `style`, `kind`, plus what to do |
| `expires_at` | Open checkouts (up to 15 minutes) and cancellations (5 minutes) |

Action kinds: `tool` (call `tool.name` with `tool.arguments`), `confirm` (verify the user as `requires_user_verification` says, then call `endpoint` adding `user_verification`), `decline` (call `endpoint` when present, otherwise just close the card), `prepare_cancel` (call `endpoint`, show the cancellation card), `open_url`.

## Events

The same events are delivered by webhook (when a webhook URL is configured) and readable by polling `GET /users/{uid}/events?after=<seq>`.

```json
{ "event_id": "uuid", "seq": 245, "type": "order.status_changed", "partner_id": "ari", "user_id": "<your id>", "created_at": "...", "data": { }, "notify": { } }
```

| Type | `data` |
| --- | --- |
| `order.created` | `order_id`, `checkout_id`, `service`, `status`, `total_minor`, `currency`, `title` |
| `order.status_changed` | `order_id`, `service`, `status`, `status_label`, `is_final`, `eta_at` |
| `checkout.confirmed` | `checkout_id`, `order_id` (null until the provider accepts), `user_verification` |
| `cancellation.confirmed` | `cancellation_id`, `order_id`, `status` |
| `grab.linked`, `grab.unlinked` | `simulated` on `grab.linked` |

`order.created` and `order.status_changed` carry `notify` with a localized `title` and `body`, a `level` (`info`, `important`, `urgent`), `live_activity { state, progress, eta_at }` and `suggest_call: true` when the assistant should ring the user (absent otherwise). The first status of an order ("Driver assigned") arrives in `order.created`; `order.status_changed` follows for every later status. `seq` grows with every event but is shared by all users, so one user's events have gaps.

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
| 404 | `NOT_FOUND` (unknown user, id, tool, path or method). Ids that are not UUIDs answer 404 too |
| 409 | `CONFIRM_HASH_MISMATCH`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_INVALIDATED`, `PRICE_CHANGED`, `CANCELLATION_NOT_ALLOWED`; on confirm also `OUT_OF_STOCK`, `RESTAURANT_CLOSED`, `DELIVERY_UNAVAILABLE` |
| 413 | `PAYLOAD_TOO_LARGE` (body above 64 KB) |
| 422 | Every tool refusal on `POST /users/{uid}/tools/{name}`, whatever its `error.code` (`PLACE_NOT_FOUND`, `PLACE_AMBIGUOUS`, `VALIDATION_FAILED` for wrong arguments...); `PROVIDER_REJECTED` on confirm |
| 429 | `RATE_LIMITED` |
| 503 | `NOT_CONFIGURED`, `SUBMISSIONS_PAUSED`, `PROVIDER_UNAVAILABLE` |

Unknown paths, wrong methods and trailing slashes under `/partner/v1` answer the JSON `404 NOT_FOUND` after the signature check; without a valid signature they answer `401` like everything else. One exception is outside the API's control: a URL with a broken percent escape (`%ZZ`) is refused by the HTTP layer with its own 400 body before routing.

Rate limits are counted per user and per endpoint: 600 requests per minute, 120 per minute for tool calls. More than 300 requests per minute with a missing or bad signature from one IP address (one /64 for IPv6) get `429` instead of `401` for the rest of that minute. Correctly signed requests are never refused by this limit.

Every signed response carries `Server-Timing: app;dur=<ms>`: the time Unyly spent on the request, which helps to tell server time from network time.

## Demo and live

| | `demo` | `live` |
| --- | --- | --- |
| Stores, fares, places | Fictional stores and fares; places are Bangkok landmarks, districts and the user's saved places | Grab APIs that are switched on for this deployment |
| Orders | Simulated, nothing delivered or charged; a trip plays through in about two minutes | Real orders through Grab |
| Cards | `demo: true`, a demo badge and a fictional driver or courier | No demo badge; `courier` only when the provider supplies it |
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

`scripts/partner-smoke.mjs` runs ping, user upsert, a saved place, `estimate_trip`, `create_cart`, confirm, order status, events, cancellation and the error shape against any deployment and prints PASS or FAIL per step:

```
BASE=https://<host> PARTNER_ID=ari PARTNER_SECRET=<secret> node scripts/partner-smoke.mjs
```

It deletes its test user at the end (`KEEP_USER=1` keeps it) and refuses to confirm when the partner runs in live mode unless `ALLOW_LIVE=1` is set, because that would place a real order.
