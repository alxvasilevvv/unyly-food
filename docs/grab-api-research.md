# Grab Developer APIs: integration research for Unyly

Date read: 2026-10-01. Source: public pages on https://developer.grab.com/docs/ (read in a browser; no login, no forms). Descriptions are paraphrased; field names, paths, enums and identifiers are copied exactly. Where the docs are silent, this file says "not documented" rather than guessing.

Common facts across Grab partner APIs:

- Gateway hosts: production `https://partner-api.grab.com`, staging `https://partner-api.stg-myteksi.com` (GrabExpress is the exception: its sandbox is a path prefix on the production host, see section 1).
- Token endpoint (GrabID): `POST {host}/grabid/v1/oauth2/token`.
- Debug header returned on responses: `X-Grabkit-Grab-Requestid` (GrabExpress also mentions `X-Request-ID`). Log it.
- HTTPS only; TLS 1.2 or 1.3. Plain HTTP calls are dropped.
- Credentials are issued per project in the Grab Developer Portal (production https://developer.grab.com, staging portal https://developer.stg-myteksi.com). Access to every commercial API is gated by a Grab business contact; there is no public self-serve production key.

---

## 1. GrabExpress API (on-demand courier delivery)

Source: https://developer.grab.com/docs/grab-express/ (single long page) and https://developer.grab.com/docs/grab-express-city-codes/. Read 2026-10-01.

### Purpose
Lets a shipper (merchant/platform) get delivery quotes, book a courier, read delivery state, cancel, tip, and receive status webhooks. Grab says typical integration is about 2 weeks on sandbox plus 1 week production setup, guided by an integration manager.

### Who can get access and how
- Sandbox: any developer project; all countries testable; select the country under the project's configurations tab. No extra approval.
- Production: access and configuration are granted per country and city. You must tell your GrabExpress Business PIC (person in charge) which countries/cities you need. Pricing is negotiated with the business team.
- Go-live: run all happy and unhappy paths in the developer console, then request production credentials, and give GrabExpress Tech Support your production webhook URL plus the auth credentials Grab should send to it.
- Support runs through a Slack group set up by the Business PIC. Response SLA: staging 6h response / 24h resolution; production 2h / 6h.

### Countries
Listed: Indonesia (IDR), Malaysia (MYR), Philippines (PHP), Singapore (SGD), Thailand (THB), Vietnam (VND), Myanmar (MMK), Cambodia (KHR). The intro says "6 countries" while the table lists 8; treat production availability as per contract. City codes use airport-style codes (for example `SIN`, `BKK`, `KUL`, `MNL`, `CGK`, `SGN`, `HAN`, `PNH`), full list on the city codes page.

### Base URLs
- Staging: `https://partner-api.grab.com/grab-express-sandbox`
- Production: `https://partner-api.grab.com/grab-express`
- Paths below are appended, for example `POST https://partner-api.grab.com/grab-express/v1/deliveries/quotes`.

### Authentication
- OAuth 2.0 client credentials. Create an OAuth 2.0 client in the GrabPlatform dashboard (Project -> Add OAuth 2.0 Clients).
- Token: `POST https://partner-api.grab.com/grabid/v1/oauth2/token` (same URL for staging and production per this page).
  - Headers: `Cache-Control: no-cache`, `Content-Type: application/json`.
  - Body (JSON): `client_id` (string), `client_secret` (string), `grant_type: "client_credentials"`, `scope: "grab_express.partner_deliveries"`.
  - Response: `access_token` (JWT), `token_type: "Bearer"`, `expires_in` (seconds; default lifetime 7 days, sample 604799).
  - Reuse the token until it expires; only re-request on expiry or a `401`.
- API calls: `Authorization: Bearer <access_token>`, `Content-Type: application/json`. The page also mentions an HMAC-signature alternative in boilerplate text but OAuth is the recommended and documented path.

### Rate limits
| API | Production | Staging |
|---|---|---|
| Get Delivery Quotes | 300 rps | 5 rps |
| Create Delivery | 33 rps | 5 rps |
| Get Delivery Details | 33 rps | 5 rps |
| Cancel Delivery | 33 rps | 5 rps |
| Cancel by merchantOrderID | 33 rps | 5 rps |
| Tracking Webhook (outbound to you) | 33 rps | 5 rps |
| Submit Tip | 5 rps | 5 rps |

### Endpoints

| Name | Method + path |
|---|---|
| Get Delivery Quotes | `POST /v1/deliveries/quotes` |
| Create Delivery | `POST /v1/deliveries` |
| Get Delivery Details | `GET /v1/deliveries/{deliveryID}` |
| Cancel Delivery | `DELETE /v1/deliveries/{deliveryID}` |
| Cancel by Merchant Order ID | `DELETE /v1/merchant/deliveries/{merchantOrderID}` |
| Submit Tip | `POST /v1/deliveries/tip/submit` |
| Tracking Webhook | `POST` to partner-defined URL |

#### 1.1 Get Delivery Quotes: `POST /v1/deliveries/quotes`
Returns an array of quotes per service. Quotes vary with distance, time of day and parcel size. If package details are omitted, the cheapest single package category is assumed.

Request body:
| Field | Type | Req | Notes |
|---|---|---|---|
| `serviceType` | string | no | `INSTANT`, `SAME_DAY`, `BULK` (must match your agreement) |
| `vehicleType` | string | no | `BIKE` (default), `CAR`, `JUSTEXPRESS`, `VAN`, `TRUCK`, `TRIKE`, `EBIKE`, `SUV`, `BOXPICKUPTRUCK`, `TRICYCLE`, `CYCLE`, `FOOT` (must match agreement) |
| `codType` | string | no | `REGULAR`, `ADVANCED` |
| `packages[]` | array | yes | |
| `packages[].name` | string | yes | max 500 chars |
| `packages[].description` | string | yes | max 500 chars |
| `packages[].quantity` | integer | yes | |
| `packages[].price` | decimal | no | goods value |
| `packages[].dimensions` | object | yes | `height`, `width`, `depth` (integer cm), `weight` (integer grams), all required; zeros accepted in samples |
| `origin` / `destination` | object | yes | |
| `.address` | string | yes | street address |
| `.keywords` | string | no | building or shop name |
| `.cityCode` | string | no | airport-style code; needed only when coordinates are not sent |
| `.coordinates.latitude` / `.longitude` | float64 | yes | at least 6 decimal places |
| `.address_L1` / `_L2` / `_L3` | string | no | province / district / ward for coordinate resolution; L1 required if L2 set, L2 required if L3 set |
| `.extra` | object | no | not shown to driver or customer |
| `cashOnDelivery.amount` | float64 | no | only send for COD orders |
| `paymentMethod` | string | no | `CASH`, `CASHLESS`; required if `promoCode` sent |
| `promoCode` | string | no | |

Response: `quotes[]` with `service{id,type,name}`, `currency{code,symbol,exponent}`, `amount` (float64 delivery fee), `estimatedTimeline{pickup,dropoff}` (RFC3339 UTC), `distance` (metres), `discountInfo{success,amount,errorMsg}`; plus echoed `origin`, `destination`, `packages`.

Promo note: an invalid promo on quotes does not error; check `discountInfo.success`. Sandbox promo codes: `VALIDPROMO`, `OODRPROMO` (out of date range), `FULLPROMO` (fully redeemed).

#### 1.2 Create Delivery: `POST /v1/deliveries`
Request body: all quote fields above, plus:
| Field | Type | Req | Notes |
|---|---|---|---|
| `merchantOrderID` | string | yes | partner order ID (represents the goods); one merchantOrderID can map to several deliveries |
| `serviceType` | string | yes | required here |
| `paymentMethod` | string | no | default `CASHLESS`; Grab advises making this switchable without code changes for COD vs non-COD |
| `payer` | string | no | `SENDER` (default) or `RECIPIENT`; `RECIPIENT` with `CASHLESS` is an error |
| `highValue` | boolean | no | default false |
| `sender` | object | yes | `firstName` (req), `lastName`, `title`, `companyName`, `email`, `phone` (E.164 without `+`), `smsEnabled` (bool, req; sender SMS not supported), `instruction` (max 1000, shown to driver at pickup). Either email or phone must be present |
| `recipient` | object | yes | same shape; `smsEnabled` sends SMS on pickup; `instruction` currently unused |
| `schedule` | object | no | `pickupTimeFrom`, `pickupTimeTo` (RFC3339 with offset); must differ (1 to 3h window recommended); same day, T+1 or T+2 only (up to 48h); order sits in `QUEUEING` until window; works in production, not in staging console |

Response: `deliveryID` (Grab tracking ID, for example `IN-2-0BTPB1C1G8IL6W72ZHK8`; docs call it a 64-char string), `merchantOrderID`, `paymentMethod`, `payer`, `quote{...}`, `sender`, `recipient`, `status` (initially `ALLOCATING` or `QUEUEING`), `trackingURL` (empty until driver allocated; mocked in staging), `courier` (always null at create), `timeline`, `schedule`, `cashOnDelivery`, `invoiceNo`, `pickupPin` (4 digits, not currently used), `advanceInfo` (null).

Multi-city: not supported, except origin in Bangkok, Nakhon Pathom, Ayutthaya, Pathum Thani, Nonthaburi with `INSTANT`.

Idempotency: the docs do not describe an idempotency key or duplicate-`merchantOrderID` rejection. `merchantOrderID` is explicitly allowed to link multiple deliveries, so do not rely on it to dedupe; implement your own retry guard (for example check via your DB before re-POSTing after a timeout). `409 Conflict` means "unable to create a delivery".

#### 1.3 Get Delivery Details: `GET /v1/deliveries/{deliveryID}`
Callable any time after successful create. Response adds over create: `courier{name,phone,pictureURL,rating,coordinates{latitude,longitude},vehicle{licensePlate,model,physicalVehicleType}}`, `timeline{create,allocate,pickup,dropoff,completed,cancel,return,fail}` (RFC3339), `cashOnDelivery{enable,amount}`, `advanceInfo.failedReason`.

Failure reason codes: `2|Driver canceled : fake sender/order`, `5|Canceled by Grab Operator`, `6|Could not find driver`.

#### 1.4 Cancel Delivery: `DELETE /v1/deliveries/{deliveryID}`
Success `204 No Content`. Errors: `404` (unknown order), `409` (already picked up / cannot cancel). No cancellation fee.

#### 1.5 Cancel by Merchant Order ID: `DELETE /v1/merchant/deliveries/{merchantOrderID}`
Cancels all deliveries for that order, only if all are in `QUEUEING`, `ALLOCATING`, `PENDING_PICKUP` or `PICKING_UP`. `204` on success; `404`, `409` as above.

Cancellation allowed by state: Allocating yes, Pending_PickUp yes, Picking_Up yes; Pending_Drop_off, In_Delivery, Failed, Canceled, Completed no.

#### 1.6 Submit Tip: `POST /v1/deliveries/tip/submit`
Body: `deliveryID` (string, req), `amount` (float64, req). Only completed orders, within 48h of completion, once per order, not refundable once disbursed; not for CASH or COD orders. Response `{"status":"success","reason":""}`; error shape `{target, reason, message}`. Errors: `400` (amount out of range, overtime, not completed, CASH, COD, no bookingCode, no paymentTokenID), `403` (not your order), `409` (duplicate tip), `412` (prepaid partner credit balance insufficient), `500`.

#### 1.7 Tracking Webhook (Grab -> partner)
- `POST https://{your-host}/{your-path}`; URL configured by Grab from what you provide (per environment).
- Auth: Grab sends the credentials you supplied, as headers `Authorization: <your secret/token>` and optionally `Authorization-Id: <your id>`. There is no HMAC signature; verification is a shared-secret header compare. Use a long random secret and HTTPS, and consider re-reading state via Get Delivery Details before acting.
- Body: `deliveryID` (64), `merchantOrderID` (64), `timestamp` (Unix seconds UTC), `status`, `trackURL` (map link, available after pickup, expires in 48h, mocked in staging), `pickupPin` (4-char string), `failedReason` (only with `FAILED`), `sender{name,address,relationship}`, `recipient{name,address,relationship}`, `driver{name,phone,licensePlate,photoURL (expires 180 min),currentLat,currentLng}`, `distance` (metres), `pickupProofURL`, `dropoffProofURL`, `cancelProofURL` (signed image links, 10 min per click, expire in 2h).
- Respond `200` or `204`. Retry behaviour is not documented; make the handler idempotent on (`deliveryID`, `status`, `timestamp`).

### Status enum
| Get Details value | Webhook value | Meaning |
|---|---|---|
| `QUEUEING` | `QUEUEING` | scheduled order waiting |
| `ALLOCATING` | `ALLOCATING` | finding driver |
| `PENDING_PICKUP` | `PENDING_PICKUP` | driver assigned, not started |
| `PICKING_UP` | `PICKING_UP` | driver heading to pickup |
| `PENDING_DROP_OFF` | `PENDING_DROP_OFF` | parcel collected, heading to recipient |
| `IN_DELIVERY` | `IN_DELIVERY` | driver at recipient |
| `COMPLETED` | `COMPLETED` | final |
| `IN_RETURN` | `IN_RETURN` | drop-off failed, returning |
| `RETURNED` | `RETURNED` | final |
| `CANCELED` | `CANCELLED` | final, cancelled by sender (note the spelling difference) |
| `FAILED` | `FAILED` | final: SLA exceeded, driver cancel, or Grab ops cancel |

Allocation window: `INSTANT` broadcasts immediately, usually allocated in 5 to 10 min, not configurable. `SAME_DAY` default 1 hour, configurable via country PIC. Unallocated orders end as `FAILED` via webhook.

### Limits and configuration (per contract)
- Default max package size 50 x 50 x 50 cm; weight and dimension limits per agreement.
- Default max distance 35 km.
- Pickup window, drop window, allocation window, batching, payment types (`CASH`, `CASHLESS`) configured per project.

### Error codes
HTTP: `200`, `204`, `400`, `401`, `403`, `404`, `409` (unable to create delivery), `429`, `500` (retryable), `503` (retry later), `504` (retry later).
Business 4xx messages (quotes and create): Distance SLA Exceeded; Order ETA SLA has exceeded; Package over weight limit; Package over size limit; Invalid ServiceType; Invalid vehicleType; Invalid codType; Failed to match taxiTypeID with assigned type; City not supported; Taxi type ID not found (payment type not enabled for city); Multi-City Delivery not supported; Empty City ID; Invalid parameters; Invalid payment method; Offer is invalid; Invalid payer value; Only SENDER payer value supported for CASHLESS payment method; The time chosen is outside the service available time.

### Partner obligations
- Log request URL, headers, body and the `X-Grabkit-Grab-Requestid` / `X-Request-ID` from responses.
- Send precise coordinates (6+ decimals), keep origin and destination in the same city.
- Pass full happy/unhappy test suite before production credentials.

---

## 2. Partner Farefeed API (ride fare estimates)

Source: https://developer.grab.com/docs/partner-farefeed/. Read 2026-10-01.

### Purpose
Returns fare ranges and pickup ETA for popular Grab ride services between two points, plus deep links that open the Grab app with the trip prefilled. It does not book rides; booking happens in the Grab app via the deep link.

### Access
Not described on the page beyond needing an OAuth client with scope `ride.estimate`. In practice this means a Grab-approved partner project; no public application flow, terms, display rules, caching or quota rules are documented on the page.

### Auth
Two-legged OAuth 2.0 (client credentials) via GrabID, scope `ride.estimate`. Header `Authorization: Bearer <token>`.

### Base URLs
- Staging: `https://partner-api.stg-myteksi.com`
- Production: `https://partner-api.grab.com`

### Endpoint: `POST /farefeed/v1/estimate`
Headers: `Content-Type: application/json`, `Authorization: Bearer <token>`.

Request:
| Field | Type | Req |
|---|---|---|
| `pickUp.latitude` | float64 | yes |
| `pickUp.longitude` | float64 | yes |
| `pickUp.address` | string | yes |
| `dropOff.latitude` | float64 | yes |
| `dropOff.longitude` | float64 | yes |
| `dropOff.address` | string | yes |

Response `services[]`:
| Field | Type | Notes |
|---|---|---|
| `serviceID` | integer | Grab taxi type ID (sample: 227 GrabShare, 302 JustGrab) |
| `serviceName` | string | |
| `eta` | integer | minutes until a car reaches pickup |
| `fare.currency` | string | |
| `fare.minFare` / `fare.maxFare` | float64 | estimated range |
| `deepLink` | string | `grab.onelink.me` link, works without the app installed |
| `directDeepLink` | string | `grab://open?...&screenType=BOOKING&taxiTypeId=...`, app must be installed |
| `iconLink` | string | service icon URL |
| `surgeNotice` | enum | `NONE`, `LOW_SURGE`, `HIGH_SURGE`, `FRACTIONAL_SURGE` |

Status codes: `200`; `400` (missing/invalid lat/lng); `401` (token missing, invalid, expired); `404` (Grab has no service at those coordinates).

Not documented: country list, vehicle/service whitelist, rate limits, caching rules, attribution or "display only" terms. Ask Grab before showing these prices to end users.

---

## 3. Login with Grab (GrabID, OAuth 2.0 / OpenID Connect)

Sources: https://developer.grab.com/docs/grab-id/ and the newer Partner Apps GrabID reference https://developer.grab.com/docs/partner-apps/pages/developer-resources/grab-id-api/. Read 2026-10-01.

### Purpose
Sign users in with their Grab account and obtain tokens to call Grab APIs on their behalf. Also the token service for all two-legged (server) Grab APIs.

### Who can get access
Account setup is manual: you need a Grab partner account and must contact the GrabID team. Credentials issued: `partner_id`, `partner_secret` (for HMAC on payment APIs), `client_id`, `client_secret`, `merchant_id`. Scopes beyond `openid` are granted at onboarding. Grab requires direct integration with the endpoints (no SDK) for web partners, backend-only secret handling, secrets in a KMS (not config files, not Redis), encrypted storage of user tokens, and no cURL/Postman testing against production.

### Environments
- Staging: `https://partner-api.stg-myteksi.com`
- Production: `https://partner-api.grab.com`
- Issuer: `https://idp.grab.com`

### Discovery: `GET /grabid/v1/oauth2/.well-known/openid-configuration`
Returns (staging sample, production same paths on production host):
- `authorization_endpoint`: `/grabid/v1/oauth2/authorize`
- `token_endpoint`: `/grabid/v1/oauth2/token`
- `userinfo_endpoint`: `/grabid/v1/oauth2/userinfo`
- `revocation_endpoint`: `/grabid/v1/oauth2/revoke`
- `jwks_uri`: `/grabid/v1/oauth2/public_keys`
- `id_token_verification_endpoint`: `/grabid/v1/oauth2/id_tokens/token_info`
- `response_types_supported`: `code`, `token`, `id_token`, `id_token token`
- `code_challenge_methods_supported`: `S256`
- `scopes_supported`: `openid`, `profile.read`
- `claims_supported`: `aud`, `sub`, `exp`, `iat`, `iss`, `nbf`, `name`, `email`
- `id_token_signing_alg_values_supported`: `RS256`
- `token_endpoint_auth_methods_supported`: `client_secret_post`
- `grant_types_supported`: `authorization_code`, `refresh_token`, `client_credentials`
- `acr_values_supported`: `service`, `consent_ctx`
Grab asks partners to read paths from discovery rather than hardcoding.

### Authorize: `GET /grabid/v1/oauth2/authorize`
Query parameters:
| Param | Req | Notes |
|---|---|---|
| `client_id` | yes | |
| `scope` | yes | space separated; `openid` required |
| `response_type` | yes | `code` |
| `redirect_uri` | yes | must be registered; HTTPS absolute, no fragment (localhost allowed for dev) |
| `code_challenge` | yes in practice | `BASE64URL(SHA256(code_verifier))`; verifier 43 to 128 chars of `[A-Za-z0-9-._~]` |
| `code_challenge_method` | | `S256` only; `plain` is rejected. PKCE is mandatory |
| `state` | optional (recommended) | CSRF |
| `nonce` | optional (recommended) | compare with ID token |
| `acr_values` | optional | `service:<id>`, `deviceid:<id>`, `consent_ctx:country=<cc>` |
| `prompt` | optional | `none` or `login` |
| `id_token_hint` | optional | skip login if valid |
| `request` | optional | only for GrabPay one-time charge |
Response: `302` to `redirect_uri?code=...&state=...` or `?error=...&error_description=...`. `400` / `404` when redirect is impossible.

### Token: `POST /grabid/v1/oauth2/token`
Content type: the GrabID page says `application/x-www-form-urlencoded`; the GrabExpress, GrabPay and Partner Apps pages use JSON bodies. Both appear to be accepted; test in staging.
| Field | When |
|---|---|
| `client_id` | always |
| `grant_type` | `authorization_code`, `client_credentials`, `refresh_token` |
| `client_secret` | client_credentials, refresh_token (and sent in auth-code examples on newer pages) |
| `scope` | client_credentials |
| `code`, `code_verifier`, `redirect_uri` | authorization_code |
| `refresh_token` | refresh_token |
Response: `access_token`, `token_type` (`Bearer`), `expires_in`, `id_token` (auth code only), `refresh_token`, or `error` / `error_description`. Grab recommends re-running the authorize flow instead of using refresh tokens.

Token lifetimes seen in docs: GrabID sample `expires_in` 863999 s (about 10 days); Partner Apps sample 7776000 s (90 days, configurable per client in the portal); GrabExpress client-credentials default 7 days; GrabPay OTC access token 1 year. Treat `expires_in` as authoritative.

### Verify ID token
`/grabid/v1/oauth2/id_tokens/token_info` (older page shows `POST .../token-info` and `GET .../id-tokens/token-info`; discovery and the newer page use `id_tokens/token_info`). Body/params: `client_id` (req), `id_token` (req), `nonce` (optional; only if used in authorize). Response claims: `acr`, `aud`, `exp`, `iat`, `iss`, `jti`, `nbf`, `nonce`, `pid`, `sub`, `svc` (for example `PASSENGER`), `tk_type` (`id`). Grab says you must call this and discard tokens if it fails. Error: `400` with `errors[{code (for example 15280), message, details{func,requestID}}]`.

### UserInfo: `GET` or `POST /grabid/v1/oauth2/userinfo`
Header `Authorization: Bearer <access_token>`. Requires `openid`; `profile.read` unlocks profile fields. Response: `sub`, `aud`, `pid`, `svc`, `name`, `email`, `phoneNumber` (country code + number, no `+`, for example `6512345678`). Phone needs the `phone` scope on the Partner Apps flow.

### Scopes available to partners (documented)
`openid`, `profile.read`, `phone` (backend scopes). Partner Apps also have mobile scopes `mobile.geolocation`, `mobile.profile`, `mobile.checkout`. Service scopes seen elsewhere: `grab_express.partner_deliveries`, `ride.estimate`, `payment.one_time_charge`, `payment.online_acceptance`, `gfb.partners.api`, `partner_app.offline_transaction`, `message.notifications`. Each is granted by Grab, not self-selected.

Identity rules: `sub` is partner-scoped and the only stable user key; email can change.

### Errors
HTTP: `200`, `201`, `302`, `400`, `401`, `403`, `404`, `409`, `500`, `503`. OAuth: `invalid_request`, `unauthorized_client`, `access_denied`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable`, `invalid_token`, `invalid_grant`, `invalid_client`. OIDC: `interaction_required`, `login_required`, `account_selection_required`, `consent_required`, `invalid_request_uri`, `invalid_request_object`, `request_not_supported`, `request_uri_not_supported`, `registration_not_supported`.

---

## 4. GrabPay One-Time Charge (OTC) API v2

Source: https://developer.grab.com/docs/payment-otc/api/v2/ (Redoc, "GrabPay Integration", OTC section; changelog last entry 17 May 2023). Read 2026-10-01.

### Purpose and model
A merchant (or a partner acting for several merchants) charges a Grab user's GrabPay balance (and, where enabled, PayLater `POSTPAID` / `INSTALMENT`, or `CARD` in Thailand) through a hosted Grab checkout. Partner model: one `partner_id` can own several `merchantID`s; each merchant account is tied to one currency. Funds settle to the merchant wallet; settlement reports via SFTP or the Grab Merchant Portal (T+1 12:00, cut-off 23:59:59, CSV pipe-delimited or XLS).

### Access
An Integration Manager collects your Redirect URL and Webhook URL, then issues production test credentials and a test Grab customer account (testing happens on production with test credentials). Live credentials follow once go-live URLs are provided. A low-code SDK exists for PHP, Node.js, .NET, Java, Python, Go (GitHub).

### Hosts
Samples use `https://partner-api.stg-myteksi.com` (staging); production is `https://partner-api.grab.com`.

### Authentication (three schemes)
1. Request HMAC (used by `/charge/init`, one-time-charge status, webhooks):
   - `body_digest = base64(sha256(raw_body))` (empty string for GET).
   - `signing_payload = METHOD + "\n" + Content-Type + "\n" + Date + "\n" + request_path + "\n" + body_digest + "\n"`.
   - `signature = base64(HMAC_SHA256(partner_secret, signing_payload))`.
   - Headers: `Authorization: {partner_id}:{signature}`, `Date: <RFC 7231 GMT>`, `Content-Type: application/json`. Clock skew over 5 min causes 401.
2. OAuth bearer from the user's authorization code (used by `/charge/complete`, partner charge status, refund, refund status): `Authorization: Bearer <access_token>`.
3. Proof of possession header `X-GID-AUX-POP` (sent together with the bearer):
   - `sig = base64url(HMAC_SHA256(client_secret, str(unix_ts) + access_token))` (padding stripped).
   - `X-GID-AUX-POP = base64url(JSON.stringify({"time_since_epoch": unix_ts, "sig": sig}))`.
   - Regenerate per request.

Amounts: integer minor units (SGD/MYR/PHP/THB x100; IDR listed as 2 decimals in the table, VND 0 decimals). Currency enum on endpoints: `SGD`, `MYR`, `PHP`, `IDR`, `THB`.

Rate limit: partner must self-limit to 50 calls/s per `partner_id`; on `429` use exponential backoff with jitter.

### Flow
1. (Optional) GrabID discovery for authorize/token URLs.
2. `POST /grabpay/partner/v2/charge/init` (HMAC) -> returns `request` (unsigned JWT).
3. Redirect user to `GET /grabid/v1/oauth2/authorize` with `request`, scope `payment.one_time_charge`, PKCE, `acr_values=consent_ctx:countryCode=SG,currency=SGD`.
4. User logs in, enters phone + SMS OTP, presses Pay; funds are earmarked; Grab redirects to `redirect_uri?code&state` (or `error&state`).
5. `POST /grabid/v1/oauth2/token` with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`, `client_secret` -> `access_token` (OTC lifetime 1 year), `id_token`.
6. `POST /grabpay/partner/v2/charge/complete` (Bearer + X-GID-AUX-POP) -> money moves.
7. Webhook and/or status polling; refund later with the same access token.
Timeouts: request code valid 20 min (init to user confirmation); OAuth code valid 15 min (confirmation to complete); must call complete within 10 min of the Auth webhook or redirect, otherwise `cancelled/auth_expired` and auto-refund (FAQ also says 15 min from init).

### Endpoints
**Init: `POST /grabpay/partner/v2/charge/init`** (HMAC)
| Field | Type | Req | Constraints |
|---|---|---|---|
| `partnerGroupTxID` | string | yes | <= 32, `^[a-zA-Z0-9\-_]+$`; receipt-level ID |
| `partnerTxID` | string | yes | <= 32, same pattern; unique per attempt |
| `amount` | int64 | yes | minor units |
| `currency` | string | yes | enum above |
| `merchantID` | string | yes | |
| `description` | string | no | <= 255 |
| `hidePaymentMethods` | string[] | no | `INSTALMENT`, `POSTPAID`, `CARD` (wallet cannot be hidden) |
| `metaInfo` | object | no (required for PayLater instalment) | `brandName`, `location`, `device`, `subMerchant`, `partnerUserInfo`, `echo` |
| `items` | object[] | no | |
| `shippingDetails` | object | no | `firstName`, `lastName`, `address`, `city`, `postalCode`, `phone`, `email`, `countryCode` |
Response 200: `partnerTxID`, `request`. Errors: `400`, `401`, `403`, `409` reasons `currency_mismatch`, `invalid_merchant`, `transaction_already_exists`, `client_error`, `user_does_not_exist` (legacy), `no_record_found` (legacy); `429`; `5xx`.

**Authorize redirect: `GET /grabid/v1/oauth2/authorize`** with required `acr_values`, `client_id`, `code_challenge`, `code_challenge_method=S256`, `nonce`, `redirect_uri`, `request`, `response_type=code`, `scope=payment.one_time_charge`, `state`. Redirect errors: `user_canceled`, `session_expired`, `invalid_acr_values`, `invalid_token`, `invalid_argument`, `invalid_scope`, `mfa_not_completed`, `transaction_not_found`, `kyc_compliance_decline`, `transaction_declined`, `server_error`, `client_error`, `insufficient_balance`, `unknown`, `confirm_failed` (legacy), `invalid_request` (legacy).

**Token: `POST /grabid/v1/oauth2/token`** (JSON): `code`, `client_id`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier`, `client_secret`.

**Complete: `POST /grabpay/partner/v2/charge/complete`** (Bearer + `X-GID-AUX-POP` + `Date`). Body: `partnerTxID`. Response: `txID`, `status` (deprecated), `paymentMethod` (for example `GPWALLET`), `description`, `txStatus`, `reason`. Errors `400`, `401`, `404`, `429`, `5xx`.

**One-time charge status: `GET /grabpay/partner/v2/one-time-charge/{partnerTxID}/status?currency=XXX`** (HMAC). Usable any time after init; returns `txID`, `oAuthCode`, `paymentMethod`, `status`, `txStatus`, `reason`. `oAuthCode` lets you finish the flow from the webhook even if the redirect was lost. Poll no more than once every 2 minutes.

**Partner charge status: `GET /grabpay/partner/v2/charge/{partnerTxID}/status?currency=XXX`** (Bearer + POP). Only after token redeemed.

**Refund: `POST /grabpay/partner/v2/refund`** (Bearer + POP). Body: `partnerGroupTxID` (req), `partnerTxID` (req, new unique ID for the refund), `amount` (req), `currency` (req), `merchantID` (req), `description`, `originTxID` (32 hex GrabPay txID of the charge), `echo` (<= 64, returned in webhook). Full or partial. Window: 365 days (SG/MY/PH), 180 days (TH). 409 reasons: `concurrent_refunds_not_supported`, `invalid_merchant`, `payment_not_found`, `client_error`, `unknown` (legacy), `no_record_found` (legacy). Note: merchant wallet is cashed out daily, so refunds can fail with `merchant_insufficient_balance`.

**Refund status: `GET /grabpay/partner/v2/refund/{partnerTxID}/status?currency=XXX`** (Bearer + POP). Before processing returns `txStatus: processing`, `reason: refunding`.

### Webhook (Grab -> merchant)
- URL registered via the Integration Manager / portal.
- Headers: `Authorization: {partner_id}:{hmac}`, `Date`, `Content-Type`. Verify by recomputing the same HMAC (with your webhook path, received Date and body digest) using `partner_secret`.
- Body: `txType` (`Init`, `Auth`, `Charge`, `Capture`, and `Refund` per description), `txStatus`, `partnerID`, `partnerTxID`, `txID` (32 hex), `origTxID` (original charge for refunds, else empty), `amount`, `currency`, `status` (deprecated), `createdAt`, `completedAt` (Unix), `payload{partnerGroupTxID, newStatus (deprecated), reason, paymentMethod, rewardsMeta, echo}`.
- On `txType: Auth` you may call one-time-charge status to get `oAuthCode`, redeem token and complete.

### Status enums
`txStatus` (charge): `success`, `failed`, `processing`, `cancelled`, `authorised`, `authorisation_declined`, `transaction_already_exist` (legacy). Only `success` and `failed` are final for charges.
Charge `reason`: `currency_mismatch`, `no_record_found`, `authorising`, `capturing`, `user_fail_consent`, `pending_user_consent`, `pending_capture`, `cancelling`, `auth_expired`, `unknown`, `kyc_compliance_decline`, `transaction_decline`, `insufficient_balance`, `err_capture_failed`, plus legacy `kyc_check_failed`, `kyb_check_failed`, `user_compliance_check_failed`.
Refund `txStatus`: `success`, `failed`, `processing`, `transaction_already_exist` (legacy). Refund `reason`: `partial_refund_not_allowed`, `pending_approval`, `unknown`, `payment_not_found`, `transaction_decline`, `merchant_insufficient_balance`, `exceed_payment_amount`, `refunding`.

Idempotency: `partnerTxID` must be unique per attempt; reuse on init gives `409 transaction_already_exists`. For newer merchants, repeating `/charge/complete` or `/refund` with a used `partnerTxID` returns the latest status (safe retry).

Partner obligations: backend-only secrets, KMS storage, encrypted token storage, handle unknown reason codes gracefully, honour poll limits.

---

## 5. Grab For Business (GFB) Partner API

Sources: https://developer.grab.com/docs/gfb/, /docs/gfb/api-environment/, /docs/gfb/get-transactions/. Read 2026-10-01.

### Purpose
Lets an organisation (or a partner such as an expense-management tool) manage its Grab For Business company account. Overview claims employee data management, policy management and transaction access, but the only documented endpoint is read-only transaction export. It does NOT book rides, food or deliveries.

### Access
Register a partner account, obtain credentials (process not detailed). Markets: Cambodia, Indonesia, Malaysia, Myanmar, Philippines, Singapore, Thailand, Vietnam.

### Auth
OAuth 2.0 client credentials: `POST https://[HOST]/grabid/v1/oauth2/token`, JSON `{client_id, client_secret, grant_type: "client_credentials", scope: "gfb.partners.api"}`. Calls send `Authorization: <Bearer token>` plus `X-GFB-Company-ID: <company id>`.

### Environment
Production only: `https://partner-api.grab.com` (no staging documented).

### Rate limits
`GET /gfb/partner/v1/transactions`: 200 requests/min per partner; all other endpoints 50/min.

### Endpoint: `GET /gfb/partner/v1/transactions`
Parameters (sample sends them as a JSON body on GET): `vertical` (req: `TRANSPORT`, `EXPRESS`, `FOOD`, `MART`), `fromDate` (req, `YYYY-MM-DD`), `toDate` (req), `page` (req, starts at 1).
Response: `page`, `hasNextPage`, `transactions[]` with `creationTime`, `completionTime`, `updatedTime`, `bookingID`, `vertical`, `source` (for example `IPHONE`, `ANDROID`), `type` (for example `IMMEDIATE`), `userInfo{companyName, companyID, email, employeeID, groupName, tripCode, tripDescription, name}`, `fare{baseFare, otherFees, amount, currency, paymentMethod[{type, cardNumber (masked), amount, billingType}], billingType, promo, tollsAndSurcharges, parkingFee, gigWorkerLevy, deliveryFee, smallOrderFee, subtotal, bookingFee, lateFees, insurance, platformPartnerFee, tip}`, one of `transport` / `express` / `food` / `mart` (with `taxiType` or `merchantName`, `city`, `country`, `pickUp{city,address,keyword,time}`, `dropOff`, `intermediateDropOff[]`, `distance`, `items[{name,quantity,cost}]`), `expenseCode`, `expenseDescription`, `refundTransactions[{refundTime, refundTotal}]`.
Errors: `200`, `400`, `401`, `403`, `404`, `429`, `500`.

---

## 6. Partner Apps (mini apps inside the Grab super app)

Sources: https://developer.grab.com/docs/partner-apps/ and sub-pages integrations/user-identity, integrations/payments, developer-resources/grab-id-api, developer-resources/payment, developer-resources/superapp-sdk. Read 2026-10-01.

### What they are
A partner web app (HTML/JS/CSS) runs in a native webview inside the Grab app, surfaced to Grab users (Grab cites 120M+ users in Southeast Asia). Examples listed: Firsty (eSIM), HelloRide, Drive lah, redBus, Jolibox. Grab can promote them through in-app placements and GrabAds; GrabCoins rewards are available.

### How to apply
Email the partnerships team: partnerapp.partnerships@grabtaxi.com. Projects are then set up in the Developer Portal (staging https://developer.stg-myteksi.com, production https://developer.grab.com). There is a requirements checklist (look and feel, compatibility, performance, security, data privacy, content, analytics, customer support).

### SDK
`npm install @grabjs/superapp-sdk` (reference at grab.github.io/superapp-sdk). Modules: `IdentityModule`, `ScopeModule`, `CheckoutModule`, `LocationModule`, `ProfileModule`, `ContainerModule`, `CameraModule`, `DeviceModule`, `FileModule`, `LocaleModule`, `MediaModule`, `NetworkModule`, `PlatformModule`, `SplashScreenModule`, `StorageModule`, `SystemWebViewKitModule`, `UserAttributesModule`. The legacy `@grab-id/grab-id-client` is deprecated.

### Login
- Users are always already signed in to Grab. Partner Apps must not offer their own login, signup, logout or account switching, and must not let users edit Grab-provided PII.
- `identityModule.authorize({clientId, scope: "openid profile.read phone", responseMode: "in_place", redirectUri})` shows a native consent sheet. Result `status_code`: `200` (returns `code`, `codeVerifier`, `nonce`, `state`, `redirectUri`), `302` (web fallback on older apps), `204` (user cancelled).
- Backend exchanges code at `/grabid/v1/oauth2/token` with `client_secret` and PKCE verifier, verifies the ID token at `/grabid/v1/oauth2/id_tokens/token_info`, then keys the user on `sub`. Then `clearAuthorizationArtifacts()` and `scopeModule.reloadScopes()`.
- Scopes: backend `profile.read`, `phone`; mobile `mobile.geolocation`, `mobile.profile`, `mobile.checkout`; auto-granted `openid`, `mobile.profile`, `mobile.checkout` (still must be requested). Redirect and page URLs must be whitelisted in the portal; HTTPS only. Access token validity is set per OAuth client in the portal. Guest mode (defer login until needed) is allowed.

### Payment
- Partner Apps MUST use Grab payments for one-time upfront payments and MUST NOT redirect to external payment providers. Subscriptions, recurring, instalments, split payments, pre-auth/capture need Grab approval.
- Currencies: SGD, MYR, PHP, IDR, THB; one merchant account per currency. Needs `merchantID`, `partnerID`, `partnerSecret`, scopes `payment.online_acceptance`, `payment.one_time_charge`.
- Init: `POST https://partner-api.grab.com/grabpay/partner/v4/charge/init` (HMAC as in section 4). Body: `partnerTxID`, `partnerGroupTxID`, `merchantID`, `currency`, `amount`, `description`, `items[{itemName, quantity, price, category, pointAwarding, completionTime}]`, `isMiniApp: true` (required). Response: `partnerTxID`, `request`, `sessionID` (valid 15 min).
- Frontend: `checkoutModule.triggerCheckout(response)` -> `status` `Success`, `Failure` (`errorCode`, `errorReason`), `Cancel`, `Pending`. Requires `mobile.checkout` scope.
- Status: `GET /grabpay/partner/v4/one-time-charge/{partnerTxID}/status?currency=&partnerGroupTxID=&isMiniApp=true` -> `txID`, `paymentMethod` (`GPWALLET`, `POSTPAID`, `INSTALMENT_4`, `CARD`), `txStatus` (`success`, `inProgress`, `failed`), `reason`, `statusDetails{status, statusCode, statusReason}`.
- Refund: `POST /grabpay/partner/v4/direct/refund` (same `partnerGroupTxID` as the charge, new `partnerTxID`, `isMiniApp: true`); status `GET /grabpay/partner/v4/direct/refund/{partnerTxID}/status?...`. Status codes include `BUS-TXN-SUC`, `BUS-TXN-NTF`, `BUS-TXN-001` to `-012`, `BUS-TXN-023` to `-028`, `BUS-TXN-101` to `-112`, `BUS-TXN-201` to `-207`, `COM-TXN-001` (compliance), `RSK-TXN-001` (risk); for example `BUS-TXN-009` refund exceeds payment.
- Webhooks: configured manually by Grab (not in the portal). HMAC in `Authorization: partner_id:signature`; verify with the received `Content-Type` exactly (staging sends `application/json; charset=utf-8,application/json`, production `application/json; charset=utf-8`), constant-time compare. Return `200` fast; non-200 is retried with exponential backoff. Payload as section 4 with `txType` `Charge` / `Refund` and `payload.reason` codes `insufficient_balance`, `transaction_declined`, `invalid_payment_method`, `exceed_payment_limit`, `transaction_timeout`.
- Offline transaction reporting (opt-in): `POST /partner-app/v1/transactions/offline` with Bearer (client credentials, scope `partner_app.offline_transaction`); fields `transaction_id`, `group_transaction_id`, `partner_user_safe_id` (the user's `sub`), `currency`, `amount_in_minor_units` or `refunded_amount_in_minor_units` (exactly one > 0), `event_created_at` (within 24h), `payment_method_name`; returns `status` `created` or `already_exists` (dedupe on `transaction_id`).

---

## 7. GrabFood Partner API (POS) v1.1.3 and Grab POS API v3

### GrabFood Partner API (POS) v1.1.3
Source: https://developer.grab.com/docs/grabfood/api/v1-1-3/. Read 2026-10-01.
This is a merchant-side integration for POS vendors serving restaurants already listed on GrabFood. Grab pushes consumer orders into the POS (`Submit order webhook` to a partner URL), and the POS accepts/rejects (`POST /partner/v1/order/prepare`), lists and edits orders (`GET /partner/v1/orders`, `PUT /partner/v1|v2/orders/{orderID}`), marks ready, updates delivery state for store-delivered orders, cancels, syncs menus (`PUT /partner/v1/menu`, `PUT /partner/v1/batch/menu`, menu webhooks), manages store hours and pause, campaigns, scan-to-order dine-in (`POST /partner/v1/pos/order`, `POST /partner/v1/orders/refund`, STO QR codes) and loyalty. Access requires an interest form, Grab approval, staging project, pilot store and phased rollout, with a Grab merchant behind each integration. There is no endpoint for a third party to place a consumer delivery order on GrabFood on behalf of a user; orders originate in the Grab app. The GrabMart Partner API (POS) v1.1.3 (https://developer.grab.com/docs/grabmart/api/v1-1-3/) has the same merchant-side shape for grocery/retail stores.

### Grab POS API v3
Source: https://developer.grab.com/docs/pos-api-v3/. Read 2026-10-01.
Despite the name this is unrelated to GrabFood: it is GrabPay in-store payment acceptance for integrated POS merchants, unifying merchant-presented QR (MPQR) and consumer-presented QR (CPQR) and adding Buy Now Pay Later. Endpoints: `POST /grabpay/partner/v3/payment/init` (async), `GET /grabpay/partner/v3/payment/inquiry`, `PUT /grabpay/partner/v3/payment/refund`, `PUT /grabpay/partner/v3/payment/cancellation`, plus a webhook. It lets a merchant take a payment from a customer at a counter; it does not place consumer orders with Grab.

---

## Fit for Unyly

Unyly wants AI assistants (over MCP) to help users order Grab food, mart, rides and express deliveries. Mapping against what the public docs actually offer:

| Unyly service | Live ordering | Estimates | Sign-in | Payment |
|---|---|---|---|---|
| Express | YES: GrabExpress API (quote, create, track via webhook/GET, cancel, tip). Unyly would be the shipper of record under a business contract, per country/city | YES: `POST /v1/deliveries/quotes` (fee, ETA, distance) | Not required (Unyly is the customer); GrabID optional to link users | Billed to Unyly's GrabExpress business account (CASHLESS) or cash to driver; Unyly must collect from its own users (GrabPay OTC as merchant is possible) |
| Ride | NO booking API. Only hand-off via Farefeed `deepLink` / `directDeepLink` that opens the Grab app with pickup, drop-off and service preselected | YES: Farefeed `POST /farefeed/v1/estimate` (min/max fare, ETA, surge flag) if Grab grants `ride.estimate` | GrabID can identify the user but grants no ride booking scope | User pays inside the Grab app; nothing for Unyly |
| Food | NO. GrabFood POS API only lets listed merchants receive orders and sync menus; no consumer order placement, no public menu/catalog read | NO public estimate API | GrabID login possible, but no food scopes | n/a |
| Mart | NO. Same as food (GrabMart POS API is merchant-side) | NO | same | n/a |

What becomes possible:
- Sign-in: "Login with Grab" via GrabID OIDC (`openid profile.read`, plus `phone` where granted), PKCE S256 mandatory, backend token exchange, `sub` as user key. Requires manual onboarding with the GrabID team.
- Payment: GrabPay OTC (or v4 inside a Partner App) lets Unyly charge users for Unyly's own goods/services, for example a GrabExpress delivery Unyly books. It cannot pay for a user's GrabFood/GrabMart/ride order.
- Partner App route: running Unyly as a Grab mini app gives native login and checkout, but the mini app still cannot create Grab rides, food or mart orders; it can only sell Unyly's own services and must use Grab payments for them.
- GFB: read-only expense export of a company's Grab bookings; useful only for reporting, not ordering.

What remains impossible with public APIs (as of 2026-10-01):
- Placing GrabFood or GrabMart consumer orders, reading restaurant menus/prices, or tracking a user's food order.
- Booking, tracking or cancelling a GrabCar/GrabBike ride on a user's behalf (only estimate + deep link).
- Acting inside a user's Grab account (no scopes for bookings, order history, or wallet balance).
- Any production access without a Grab business agreement: every API above (Express per city, Farefeed scope, GrabID, GrabPay, Partner Apps) is gated by Grab onboarding.

Open questions for Grab (not answered in docs): Farefeed eligibility, display/caching terms, rate limits and country coverage; whether GrabExpress allows an aggregator to book on behalf of many end senders; GrabExpress webhook retry policy; whether any partner scope exists for ride booking or food ordering beyond what is public.
