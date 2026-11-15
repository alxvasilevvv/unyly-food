# Grab Developer APIs, part 2

Date read: 2026-11-15. Source: public pages linked from https://developer.grab.com/docs/ (read in a browser; no login, no forms). Descriptions are paraphrased; field names, paths, enums and identifiers are copied exactly. Where the docs are silent, this file says "not documented" rather than guessing. Part 1 (GrabExpress, GrabFood/GrabMart POS, OTC, Login with Grab and others) is in `grab-api-research.md`.

Common facts (same as part 1 unless a section says otherwise):

- Gateway hosts: production `https://partner-api.grab.com`, staging `https://partner-api.stg-myteksi.com`.
- GrabID token endpoint: `POST {host}/grabid/v1/oauth2/token`; OpenID discovery at `GET {host}/grabid/v1/oauth2/.well-known/openid-configuration`.
- HTTPS only, TLS 1.2 or 1.3.
- Every product below is partner-gated: credentials come from Grab after a commercial agreement; none of them has a public self-serve production key.

---

## 1. Tokenisation API (Tokenised Payments v4, GrabPay)

Source: https://developer.grab.com/docs/tokenisation-v4 and its subpages (`/changelog`, `/started-prereqs`, `/started-api`, `/service-discovery`, `/enable-recurring`, `/bind-init`, `/auth-web-url`, `/bind-status`, `/auth-get-oauth`, `/check-payment-method`, `/get-promo`, `/charge-create`, `/charge-status`, `/charge-topup`, `/unbind`, `/refund-generate`, `/refund-status`, `/webhook-noti`, `/txn-status`, `/reason-codes`, `/http-response-codes`, `/test-setup`, `/troubleshoot`). Read 2026-11-15. Changelog entries run Sep to Nov 2022; the get-promo and payment-method samples are dated 2024 and 2025, so the page has been edited since.

### Purpose
Lets a merchant link ("bind") a customer's Grab account once, receive a long-lived token, and then charge that customer server to server without a per-payment redirect, plus refunds, unbind and webhooks. Charges can draw on the GrabPay wallet or on Grab PayLater (postpaid and 4/8/12 instalments). Intended for wallet linking and periodic charges.

### Who it is for
Merchants and platforms (the "partner") charging their own customers. The consumer only sees a Grab login/consent web page during bind and, optionally, a Grab top-up page.

### Access and onboarding
- Account setup is manual: create a GrabPay partner account via your Grab Account Manager and the GrabPay team.
- Credentials issued: `partner_id`, `partner_secret` (for HMAC), `client_id`, `client_secret` (for OAuth), `merchant_id` (one partner can have several merchants; each merchant account is single-currency). Scopes are handed out at onboarding.
- Testing: the "Test your setup" page says testing happens in the production environment with help from your GrabPay Integration Manager. The environments table lists only production `https://partner-api.grab.com`, although some samples use `https://partner-api.stg-myteksi.com`.
- Security rules Grab states: keep client IDs, secrets and user tokens in a KMS or encrypted DB, never in the end-user app; all calls server to server from the partner backend.

### Countries and currencies
SG, MY, PH; currencies SGD, MYR, PHP. Note: the Create Charge `currency` field says "Currently, supports only SGD and MYR", while other endpoints list SGD, MYR and PHP. Amounts are integers in the smallest currency unit (S$5.34 = `534`).

### Auth scheme
Three mechanisms, used per endpoint:
1. HMAC with partner secret: header `Authorization: {partner_id}:{hmac_signature}`, plus `Date` (GMT, must equal the date used in the signature) and `Content-Type: application/json`. String to sign: `METHOD\nContent-Type\nDate\nrequestPath\nbase64(sha256(body))\n`, HMAC-SHA256 with `partner_secret`, base64. Body hash is of the empty string for GET.
2. OAuth 2.0 user token: `Authorization: Bearer {access_token}` obtained by authorization code + PKCE (S256 only) after bind.
3. `X-GID-AUX-POP`: proof-of-possession header. HMAC-SHA256 over `{unix_timestamp}{access_token}` keyed with `client_secret`, base64url; then base64url of JSON `{"time_since_epoch": <unix>, "sig": "<sig>"}`. Regenerate per call.

Scopes: `openid` (base), `payment.recurring_charge` (tokenised charges). The top-up redirect URL in a sample also carries `scope=payment.redirected_topup`. Discovery response lists `scopes_supported: ["openid","profile.read"]`, grant types `authorization_code`, `refresh_token`, `client_credentials`, `acr_values_supported: ["service","consent_ctx"]`, token endpoint auth `client_secret_post`.

Token lifetime: the flow page says the token is valid 10 years; the sample `expires_in` is `31535999` (about 1 year). Treat the real value as "check `expires_in`".

### Base URLs
- Production: `https://partner-api.grab.com`
- Staging: `https://partner-api.stg-myteksi.com` (appears in samples only; not in the environments table)
- Paths: token under `/grabid/v1/oauth2/...`, payment under `/grabpay/partner/v4/...`

### Flow (bind once, then charge with no redirect)
1. Backend calls Initiate bind with its own `partnerTxID`; gets `request` (JWT).
2. Backend builds the Grab authorize URL (with `request`, PKCE, `state`, `nonce`, `acr_values=consent_ctx:countryCode=SG,currency=SGD`, `scope=openid payment.recurring_charge`) and sends the user there. User enters mobile number + OTP (or signs up) and taps "Link".
3. Grab redirects to `redirect_uri?code=...&state=...` (or `error=BIND_FAILED|PAYMENT_METHOD_NOT_AVAILABLE`).
4. Backend exchanges `code` for `access_token` and stores it.
5. Later, for every payment: Check payment methods (optional), Create Charge with `Bearer` + `X-GID-AUX-POP`. No user interaction unless wallet balance is short and `enableRedirect` is used.

### Endpoints

| Name | Method + path | Auth |
|---|---|---|
| Service discovery | `GET /grabid/v1/oauth2/.well-known/openid-configuration` | none |
| Initiate bind | `POST /grabpay/partner/v4/bind` | HMAC (partner secret) |
| Authorize (web URL, browser) | `GET /grabid/v1/oauth2/authorize?...` | user login in browser |
| Check bind status | `GET /grabpay/partner/v4/bind/{partnerTxID}/status` | HMAC |
| Get OAuth token | `POST /grabid/v1/oauth2/token` | client_id + client_secret in body |
| Check payment methods | `GET /grabpay/partner/v4/bind/paymentMethods?currency={currency}&amount={amount}` | Bearer + POP |
| Get promo | `GET /grabpay/partner/v4/promo` | Bearer + POP |
| Create charge | `POST /grabpay/partner/v4/charge` | Bearer + POP |
| Check charge status | `GET /grabpay/partner/v4/charge/{partnerTxID}/status?currency={currency}` | Bearer + POP |
| Continue charge (after top-up) | `POST /grabpay/partner/v4/charge/continue` | Bearer + POP |
| Unbind | `DELETE /grabpay/partner/v4/bind` | Bearer + POP |
| Refund | `POST /grabpay/partner/v4/direct/refund` (one sample shows `/grabpay/partner/v4/refund`) | HMAC |
| Refund status | `GET /grabpay/partner/v4/direct/refund/{partnerTxID}/status?currency={currency}` | HMAC |

Key fields:

- Initiate bind request: `partnerTxID` (max 32, alphanumeric, dashes, underscores; idempotency key), `countryCode` (`SG`, `MY`, `PH`), `merchantIDs` (array), `bindType` (`TOKENIZE` only). Response: `request` (JWT), `partnerTxID`. Errors: 400 Bad Input, 401, 409 `no_record_found`, 409 `currency_mismatch`, 500 `service_error`.
- Authorize URL params: `acr_values`, `client_id`, `code_challenge`, `code_challenge_method=S256`, `nonce`, `redirect_uri`, `request`, `response_type=code`, `scope`, `state`. Redirect errors: `BIND_FAILED`, `PAYMENT_METHOD_NOT_AVAILABLE`.
- Bind status response: `transactionID`, `txStatus` (`success`, `failed`, `processing`), `oAuthCode` (sample spells it `OAuthCode`). Useful if the redirect back to the merchant fails.
- Token request: `code`, `client_id`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier`, `client_secret`. Response: `access_token`, `token_type` (`Bearer`), `expires_in`, `id_token`. Errors: `unexpected_error` (400, 429), `invalid_grant` (404), `invalid_request`, `invalid_token`, `unauthorized_client`.
- Check payment methods response: `userDetail.phoneNumber` (masked), `paymentMethod[]` with `paymentType` (`INSTALMENT_4`, `INSTALMENT_8`, `INSTALMENT_12`, `POSTPAID`, `GPWALLET`), `balance`, `currency`, `subtitle`, `isAvailable`, `reason`, `totalAmount`, `amountPerPayment`, `totalProcessingFee`, `processingFeePerPayment`, `processingFeePercentage`, `repaymentDetail[]` (`dueDate` ms, `amountDue`). So a bound partner can read the user's wallet balance and PayLater limit. Errors include 409 `invalid_bind_metadata`, `currency_mismatch`, `no_record_found`.
- Get promo query: `merchantID`, `currency`, `amount`, `paymentType`, `msgID`, `promoCode`. Response `promoList[]`: `token`, `name`, `description` (may contain HTML), `icon`, `headerImage`, `currency`, `isAvailable`. Promos are "discoverable" (listed without a code) or "non-discoverable" (only with `promoCode`). Errors 409 `token_mismatch`, `promo_not_found`.
- Create charge request: `partnerGroupTxID` (order/receipt ID), `partnerTxID` (idempotency), `currency`, `amount`, `description` (max 255), `merchantID`, `paymentType` (enum above), optional `promoToken`, `metaInfo` (`brandName`, `location{ipAddress,latitude,longitude,accuracy}`, `device{deviceID,deviceModel,deviceBrand,iosUDID,imei}`, `subMerchant{name,category}`, `partnerUserInfo{id,phone,email}`), `items[]` (`itemName`, `quantity`, `price`, `category`, `supplierName`), `shippingDetails` (`firstName`, `lastName`, `address`, `city`, `postalCode`, `phone`, `email`, `countryCode`), `redirectDetail` (`enableRedirect`, `merchantRedirectURL`, `state`; "only available for registered partners").
- Create charge response: `txID`, `description`, `txStatus` (`success`, `failed`, `processing`, `transaction_already_exist`), `reason`, `paymentMethod`, `additionalInfo.amountBreakdown` (`grossAmount`, `paidAmount`, `merchantAcquisitionPromoAmount`, `merchantRetentionPromoAmount`, `grabPromoAmount`), `redirectionDetail` (`status`, `redirectURL`, `txStatus`) when `enableRedirect=true` (then `txStatus: processing`, `reason: redirect_pending`).
- Charge errors: 409 `token_mismatch`, `token_deactivated`, `wallet_not_bound`, `invalid_payment_method`, `external_service_failed`; 500 `service_error` / `transaction_unknown_status`; HTTP 200 with `txStatus: failed` and description `err_charge_failed`, `currency_mismatch`, `user_compliance_check_failed`, `merchant_fraud_check_failed`, or `insufficient_fund` (reason `insufficient_balance`).
- Continue charge request: `partnerTxID` (new), `txID` (from the charge). Response same shape as charge.
- Unbind request: `merchantIDs`. Response: `txStatus`, `partnerTxID`, `statusDetails{status: "UNBINDED", statusCode: "BUS-TXN-UNB", statusReason}`. Refunds still work after unbind within the refund window. Users can also unbind from the Grab app; Grab then sends an Unbind webhook.
- Refund request: `partnerGroupTxID`, `partnerTxID`, `currency`, `amount`, `description`, `merchantID`, `originTxID` (the charge `txID`). Full and partial refunds supported; partial refund is refused when a promo was applied. Response adds `amountBreakdown.refundedAmount`. Errors: 401 `refund_window_exceeded`, 409 `invalid_merchant`, `concurrent_refunds_not_supported`, `payment_not_found`; 200-failed `transaction_decline`, `partner_mismatch`, `currency_mismatch`, `user_mismatch`, `partial_refund_not_allowed`, `refund_exceeds_charge_amount`, `concurrent_transfers_not_supported`, `insufficient_fund` (reason `merchant_insufficient_balance`), `pending_approval`, `unknown`.

### Statuses and reason codes
- `txStatus`: `success`, `failed`, `processing`, `transaction_already_exist`; `unknown` may appear transiently. Only `success` and `failed` are final. Poll status no more than once every 2 minutes; prefer the webhook.
- Reason codes: `insufficient_balance`, `kyc_check_failed`, `kyb_check_failed`, `merchant_insufficient_balance`, `currency_mismatch`, `payment_not_found`, `exceed_payment_amount`, `partial_refund_not_allowed`, `wrong_transaction_state`, `authorising`, `capturing`, `cancelling`, `charging`, `refunding`, `pending_approval`, `redirect_pending`, `timeout`, `unknown`.
- HTTP: 200, 201 (redirect resource created), 400, 401, 403, 404, 409 (see `reason`), 500, 503.

### Webhooks
Sent for Bind, Charge, Refund, Unbind to the partner's registered URL (registration process not documented). Header `Authorization: partner_id:hmac_signature`, `Date`, `Content-Type: application/json` (compute HMAC with `application/json; charset=utf-8`). Body: `txType` and `txCategory` (`Bind`, `Charge`, `Refund`, `Unbind`), `partnerID`, `partnerTxID`, `txID`, `OrigTxID` (refunds), `txStatus`, `amount`, `currency`, `createdAt`, `completedAt` (Unix), `Payload` (unbind: unlinked `merchantIDs`). Respond HTTP 200; Grab retries 2 more times otherwise.

### Rate limits
Not documented, apart from "do not poll status more than once every 2 minutes" and a 429 on the token endpoint.

### Relevance to Ari
This is the only documented way to charge a GrabPay wallet with no redirect per payment. But Ari would have to be the GrabPay merchant of record (it charges the user into Ari's own merchant account). It cannot be used to pay a GrabFood/GrabMart/Transport order inside Grab on the user's behalf; those orders are paid inside Grab's own apps. Fit: Ari selling its own services (subscriptions, Ari-sold vouchers) to users in SG/MY/PH.

---

## 2. Integrations Launchpad: PayLater by Grab and GrabPay online (skim)

Source: https://developer.grab.com/docs/paylater-integrations-launchpad-v2 (subpages `/guidelines-lockup-usage`, `/brand-assets-paylater-lockup`, `/plugins-price-divider`, `/plugins-shopify`, `/plugins-magento`, `/plugins-woocommerce`, `/plugins-web`) and https://developer.grab.com/docs/grabpay-integrations-launchpad (subpages `/guidelines-grabpay-logo-usage`, `/brand-assets-grabpay-logo`). Read 2026-11-15 (skimmed).

- Purpose: marketing and UX kits for merchants that already accept GrabPay or PayLater on a web store: logo and lockup usage rules, brand assets, and "Price Divider" widgets (show "pay in 4" style messaging next to a price) for Shopify, Magento, WooCommerce and plain web.
- PayLater is described as two interest-free options: pay in 4 monthly instalments, or pay next month.
- Who: merchants with online stores. No API endpoints, no auth, no webhooks on these pages.
- Onboarding links per market: Singapore (grab.com merchant online payments page), Malaysia (a Google Form), Philippines (Grab merchant help article).
- Countries: SG, MY, PH.
- Relevance to Ari: none technically. Only useful if Ari shows GrabPay or PayLater branding at its own checkout after it becomes a GrabPay merchant (then the logo rules apply).

---

## 3. GrabMall API (v1.1.3)

Source: https://developer.grab.com/docs/grabmall/api/v1-1-3 (single Redoc page). Read 2026-11-15. Changelog shows active development (entries from 14 Aug to 28 Sep 2026).

### Purpose
The GrabMall POS API is the e-commerce (non-food retail) counterpart of the GrabFood/GrabMart POS API: it lets a retailer's POS or e-commerce system sync its GrabMall catalog (with Grab's e-commerce category tree and attributes), receive GrabMall orders, update order and delivery state, manage store hours and run campaigns.

### Who it is for
POS / commerce-platform partners acting for GrabMall merchants. Merchant side only; nothing for consumers or third-party consumer apps.

### Access and onboarding
- Submit the interest form at https://developer.grab.com/contact-us choosing category "GrabMall"; Grab does a background check.
- After approval, an invitation email gives access to a Staging project in the developer portal. Portal login uses a Grab app account (phone number).
- Staging project has a "GrabMall POS integration" tab: Menu Simulator, Store Information (test stores), Configurations, Testing Tools (sync test menu, place test order), Contact Support.
- Production: "Create Production Project" from the staging project, then pilot store, then phased rollout. Typical full integration 1 to 2 months.
- Support via a Slack channel (access for up to one year, renewable).
- Grab's production egress IPs to whitelist: `52.76.35.120`, `18.139.119.182`, `18.142.59.8`.
- Quality bar: error rate under 1%, 100% processing of order submissions and state updates, respond to Grab webhooks within 10 seconds.

### Countries and currencies
8 countries, over 200 cities: SG (SGD, exponent 2), MY (MYR, 2), ID (IDR, 2), VN (VND, 0), TH (THB, 2), PH (PHP, 2), KH (KHR, 2), MM (MMK, 2). `countryCode` enum: `SG`, `MY`, `ID`, `TH`, `MM`, `PH`, `VN`, `KH`.

### Auth and scopes
- Grab side: OAuth 2.0 client credentials. `POST https://partner-api.grab.com/grabid/v1/oauth2/token` with `client_id`, `client_secret`, `grant_type: "client_credentials"`, `scope: "mall.partner_api"`. Token lifetime 7 days by default; reuse until expiry or 401.
- Partner side: GrabMall calls the partner's `POST {{api-endpoint}}/<any-path>/oauth/token` with the partner's `client_id`, `client_secret`, `grant_type: "client_credentials"`, `scope: "mall.partner_api"`.
- Scope: `mall.partner_api`.

### Base URLs
- Production: `https://partner-api.grab.com/ecom`
- Staging: `https://partner-api.grab.com/grabecom-sandbox`
- (The environments table lists `https://partner-api.grab.com` for both; the per-operation server list shows the two prefixes above.)

### Endpoints called by the partner (GrabMall side)

| Name | Method + path | Rate limit |
|---|---|---|
| Get Grab OAuth token | `POST /grabid/v1/oauth2/token` | not stated |
| List category tree | `GET /partner/v1/category-tree/all` (`countryCode`, `merchantID`) | 40 rps |
| Query category tree nodes by name | `GET /partner/v1/category-tree/nodes/query` (`countryCode`, `name`, `merchantID`) | 100 rps |
| Get node attribute clusters | `GET /partner/v1/category-tree/nodes/attribute-clusters` (`countryCode`, `categoryTreeNodeID`, `merchantID`) | 40 rps |
| Receive ecom menu notification (triggers full sync) | `POST /partner/v1/merchant/ecom/menu/notification` (`merchantID`, `menuID`) | 1 rps |
| Batch create product and item | `POST /partner/v1/batch/product/create` (`merchantID`, `menuID`, `products`) | 10 rps |
| Batch update product and item | `PUT /partner/v1/batch/product` (`merchantID`, `menuID`, `products`; items may carry `skipPricePropagation`, `skipStatusPropagation`, `photos`) | 10 rps |
| Batch update product item (stock, price, status) | `PUT /partner/v1/batch/item` (`merchantID`, `items`; per item `updateFields` such as `["currentStock","maxStock"]` or `["priceInMin","status"]`) | 40 rps |
| List Products | `GET /partner/v1/merchant/ecom/menu` (`merchantID`, `menuID`, `limit`, `seek`, `orderBy` `CreatedAt`/`UpdatedAt`, `asc`) | 50 rps |
| Manually accept/reject orders | `POST /partner/v1/order/prepare` (`orderID`, `toState` `Accepted`/`Rejected`) | 5 rps |
| List orders | `GET /partner/v1/orders` (`merchantID`, `date`, `page`, `orderIDs`) | 5 rps |
| Edit order | `PUT /partner/v1/orders/{orderID}` (`items`, `onlyRecalculate`) | 5 rps |
| Mark order as ready | `POST /partner/v1/orders/mark` (`orderID`, `markStatus`) | 10 rps |
| Update delivery state (store delivery) | `POST /partner/v1/order/delivery` (`orderID`, `fromState` `Accepted`/`FindDriver`/`Collected`, `toState` `FindDriver`/`Collected`/`Delivered`) | 5 rps |
| Update new order ready time | `PUT /partner/v1/order/readytime` (`orderID`, `newOrderReadyTime`) | 5 rps |
| Check order cancelable | `GET /partner/v1/order/cancelable` (`orderID`, `merchantID`) | 5 rps |
| Cancel an order | `PUT /partner/v1/order/cancel` (`orderID`, `merchantID`, `cancelCode`) | 5 rps |
| Pause store | `PUT /partner/v1/merchant/pause` (`merchantID`, `isPause`, `duration` `30m`/`1h`/`24h`) | 5 rps |
| Get Store Hours | `GET /partner/v2/merchants/{merchantID}/store/hours` | 5 rps |
| Get Store Status | `GET /partner/v1/merchants/{merchantID}/store/status` | 5 rps |
| Update Store Delivery Hours | `PUT /partner/v1/merchants/{merchantID}/store/opening-hours` (`openingHour`, `force`) | 5 rps |
| Update Store Special Hours | `PUT /partner/v2/merchants/{merchantID}/store/special-opening-hour` (`specialOpeningHours`, `startDate`, `endDate`, `metadata`, `openingHours`) | 5 rps |
| Create campaign | `POST /partner/v1/campaigns` (`merchantID`, `name`, `quotas`, `conditions`, `discount`, `customTag`) | 40 rps |
| Update campaign | `PUT /partner/v1/campaigns/{campaign_id}` | 40 rps |
| List campaigns | `GET /partner/v1/campaigns?merchantID={merchant_id}` | 40 rps |
| Delete (terminate) campaign | `DELETE /partner/v1/campaigns/{campaign_id}` | 40 rps |

Rate limits are per project; all outlets in a project share them.

### Webhooks (partner implements; Grab calls)

| Name | Method + path | Key fields |
|---|---|---|
| Get partner OAuth token | `POST {{api-endpoint}}/<any-path>/oauth/token` | `client_id`, `client_secret`, `grant_type`, `scope` |
| Get ecom menu | `GET {{api-endpoint}}/<any-path>/merchant/menu` | query `merchantID`, `partnerMerchantID`, `menuID`, `BusinessType` |
| Menu sync state | `POST {{api-endpoint}}/<any-path>` | `requestID`, `merchantID`, `partnerMerchantID`, `jobID`, `updatedAt`, `status` (`QUEUEING`, `PROCESSING`, `SUCCESS`, `FAILED`), `errors` |
| Submit order | `POST {{api-endpoint}}/<any-path>/orders` | `orderID`, `shortOrderNumber`, `merchantID`, `partnerMerchantID`, `paymentType` (`CASH`, `CASHLESS`), `orderTime`, `submitTime`, `completeTime`, `scheduledTime`, `orderState`, `currency`, `featureFlags`, `items`, `campaigns`, `promos`, `price`, `receiver`, `orderReadyEstimation`, `membershipID` |
| Push order state | `PUT {{api-endpoint}}/<any-path>/order/state` | `merchantID`, `partnerMerchantID`, `orderID`, `state` (`ACCEPTED`, `DRIVER_ALLOCATED`, `DRIVER_ARRIVED`, `COLLECTED`, `DELIVERED`, `FAILED`, `CANCELLED`), `driverETA`, `code`, `message` |

### Order types and states
- `featureFlags.orderAcceptedType`: `AUTO` or `MANUAL` (new partners should use AUTO).
- `featureFlags.orderType`: `DeliveredByGrab` (submitted after driver allocation by default), `TakeAway` (only `DELIVERED` and `CANCELLED` pushed; auto-completed after 2 hours), `DeliveredByStore` (partner reports delivery; only `COLLECTED`, `DELIVERED`, `CANCELLED`). Scheduled orders carry `scheduledTime`. A "Split Order" section also exists.
- The `receiver` object carries a virtual contact (`phoneNumber` plus a `PIN`) so the store can call the customer.
- Logging: log `X-Request-ID` or `X-Grabkit-Grab-RequestId`.

### Relevance to Ari
None for ordering. It is the store's integration, not a buyer API: there is no consumer catalog search, cart, or order placement. Ari cannot place GrabMall orders through it.

---

## 4. GrabKios: Digital Products API and Biller Gateway API

### 4a. GrabKios Digital Products (Digital Goods) API v2

Source: https://developer.grab.com/docs/grab-kios-digital-products-api/introduction and subpages (`getting-started/authentication`, `getting-started/request`, `getting-started/responses`, `core-resources-overview`, `digital-goods/product-catalog/*`, `digital-goods/inquiry`, `digital-goods/payment`, `digital-goods/payment/callback`, `digital-goods/check-status/*`, `digital-goods/rc-mapping`, `changelog`). Read 2026-11-15. Latest changelog entry 20 Oct 2026 (multi-language `rc_message`); v2.0.0 on 8 Sep 2025.

#### Purpose
A B2B gateway (the platform behind it is called "Frontier" in status texts; product types are labelled "Kudo") that lets a partner sell Indonesian digital goods: airtime (pulsa) and data packages, game vouchers, bill payments (PLN electricity, PDAM water, Telkom, postpaid mobile, cable TV and similar) and e-wallet top-ups (OVO, Dana, GOPAY). The partner buys at `product_b2b_price` and sells at its own price; Grab is the wholesaler.

#### Who it is for
"B2C Applications" (businesses selling digital goods directly to end users) and "B2B Aggregators" (resellers). A consumer app is explicitly an intended user type. Partner types in responses: "Billing" (invoiced) and "Deposit" (prepaid balance, returned in `deposit{balance, currency_code}`).

#### Access and onboarding
Create a GrabKios Partner account through your Account Manager. You receive an API Key and a Secret Key. Callback URL must be supplied at integration setup. WAF whitelisting applies (code `9401` "Unauthorized By WAF"). Postman guide and code samples pages exist. No self-serve signup.

#### Countries and currencies
Indonesia only ("expanding to additional regions"); IDR; `country_calling_code` 62.

#### Auth scheme
- All requests: `Authorization: YOUR_API_KEY` (raw API key, no Bearer prefix).
- Requests with a body (POST): plus HMAC-SHA256 of the exact JSON body with the Secret Key, hex encoded. The header is named `Signature` on the auth page but `X-Signature` in the endpoint samples; confirm with Grab.
- Optional `Accept-Language` on POST `/inquiry` and `/payment` for `rc_message` language (`en`, `id`, `ms`, `my`, `zh`, `ja`, `km`, `ko`, `th`, `vi`; default Bahasa Indonesia; unsupported tag falls back to English).
- No OAuth and no scopes.

#### Base URLs
- Staging: `https://partner-api.stg-myteksi.com/kios/b2b-gateway/partner/v2/ex`
- Production: `https://partner-api.grab.com/kios/b2b-gateway/partner/v2/ex`

#### Endpoints

| Name | Method + path | Auth |
|---|---|---|
| Get all products | `GET /products` | API key |
| Get products by group | `GET /product/{product_group_id}` | API key |
| Get product detail | `GET /product-detail/{product_code}` | API key |
| Inquiry (billpay only) | `POST /inquiry` | API key + signature |
| Payment / top up | `POST /payment` | API key + signature |
| Check status by transaction ID | `GET /check-status/{transaction_id}` | API key |
| Check status by partner transaction ID | `GET /check-status/partner-transaction-id/{partner_transaction_id}` | API key |
| Bulk check status (max 50) | `POST /check-status` (body: array of `transaction_id`s) | API key + signature |
| Bulk check status by partner IDs (max 50) | `POST /check-status/partner-transaction-id` (body: array of IDs) | API key + signature |
| Transaction callback (to partner) | `POST https://{your-ip-or-domain}/...` | none documented (no signature described) |
| Product callback (to partner) | `POST` to partner URL; ignore payload, re-read catalog | none documented |

Key fields:
- Envelope on every response: `code` (number), `message`, `data`.
- Catalog hierarchy: `product_type`, `product_type_id`, `product_categories[]` (`product_category`, `product_category_id`, `product_groups[]`), group: `product_group`, `product_group_id`, `product_group_type` (`prepaid`/`postpaid`), `product_group_type_id`, `product_prefix[]` (phone prefixes such as `0811`), `product_image`, `product_list[]`. Product: `product_code`, `product_name`, `product_description`, `product_nominal`, `product_nominal_currency`, `product_b2b_price`, `product_b2b_price_currency`, `product_price`, `product_price_currency`, `product_currency_symbol`, `product_status` (samples show `available`/`maintenance` and `Active`/`Inactive`), `country_origin`.
- Inquiry request: `country_calling_code`, `customer_id`, `product_code`, optional `additional_parameters` (`amount` for open-amount e-wallet top-ups, `sender_id` for OVO). Response `data`: `inquiry_id`, `customer_number`, `additional_customer_data[]` (`title`, `value`), `transaction_amount`, `admin_fee`, `total_price`, `partner_price`, `product_code`, `transaction_reference_number`, `status` (biller status; `"00"` means OK even when `code` is 9000), `message`, `rc`, `rc_message`.
- Payment request: billpay `inquiry_id`, `country_calling_code`, `customer_id`, `product_code`, `partner_transaction_id`, `additional_parameters`; airtime/game voucher `country_calling_code`, `phone_number` (no leading 0), `product_code`, `partner_transaction_id`. Response `data`: `inquiry_id`, `country_calling_code`, `phone_number` or `customer_id`, `product_code`, `price`, `transaction_id`, `transaction_date` (`YYYY-MM-DD HH:ii:ss`), `transaction_status`, `transaction_message`, `rc`, `rc_message`, `deposit`.
- Status/callback `data`: adds `transaction_status_code`, `serial_number` (the voucher/token), `partner_transaction_id`, `payment_receipt{receipt_header[], receipt_data[], receipt_footer[]}` (`title`/`value`), `receipt_key_format` (keys such as `CustomerName`, `ElectricityToken`, `TotalKWH`, `BillPeriod`, `ReferenceNumber`, `TotalAmount`, `TopUpInstruction`), `redeem_data{code, expiry_date, redeem_instruction}` for game vouchers.

#### Statuses and codes
- API codes: `9000` success, `9101` invalid authentication, `9102` invalid signature, `9103` invalid validation, `9104` insufficient partner balance, `9105` invalid transaction id, `9106` params differ from existing transaction, `9201` data not found, `9301` processing, `9302` pending at biller, `9303` failed, `9304` transaction limit reached, `9401` unauthorized by WAF, `9501` system busy, `2000` unknown.
- `transaction_status`: `processing`, `pending`, `success`, `failed`.
- Standardized `rc` (new): format letter-dash-number, for example `G-00` success, `G-01` accepted and processing, `G-02` pending, `G-99` failed, `P-01` auth/signature, `P-02` insufficient balance, `P-08` to `P-11` validation and not-found, `U-07` limit reached, `B-01` system error. `rc`/`rc_message` appear only on terminal outcomes in callbacks and status.
- Handling rules: on 9301/9302 wait for callback or poll every 10 s; on timeout, 2000 or 4xx/5xx mark pending and check by `partner_transaction_id`; 9201 right after payment can mean "still processing", re-check after 30 s.

#### Webhooks
Transaction callback only for terminal Success (9000) and Failed (9303), HTTP POST JSON to the partner URL; payload as status response plus `message_type: "queue_action"`, `callback_type: "http"`, `partner_id`. Respond HTTP 200; up to 3 retries. Delivery can also be via Kafka (mentioned once). Product callback fires when products are added, removed, opened or closed.

#### Rate limits
Not documented (HTTP 429 exists).

#### Relevance to Ari
This is the most directly usable product for a consumer assistant: Ari (as a GrabKios B2C partner with a deposit or billing account) could let Indonesian users buy pulsa/data, game vouchers, pay PLN and other bills, and top up e-wallets by voice, returning the `serial_number` / token / receipt. It is not tied to the user's Grab account at all: Ari collects payment from the user by its own means and settles with Grab wholesale. Indonesia only.

### 4b. GrabKios Biller Gateway API

Source: https://developer.grab.com/docs/grab-kios-biller-gateway-api and subpages (`/changelog`, `/pre-requisites`, `/token-api`, `/bill-details-overview`, `/response-code-description`). Read 2026-11-15. Changelog runs 16 Jan 2024 to 30 Jul 2026.

- Purpose: the reverse direction. A biller (utility, telco, PDAM, PLN, e-wallet provider) exposes APIs that GrabKios calls to inquire and pay bills, so the biller's products appear in GrabKios.
- Who: billers only. Not for consumer apps.
- Biller implements: `POST https://{biller-endpoint}/token`, `/inquiry`, `/payment`, `/check-status`, `/balance`. Biller calls GrabKios: `POST https://{grabkios-endpoint}/callback`.
- Flow: GrabKios requests a token every 30 minutes by default; inquiry and payment are triggered by GrabKios; the biller sends a callback with the final status; GrabKios also calls check-status about 15 s after payment at least once.
- Token API: headers `Content-Type`, `Signature`, `Biller-Id` (details on an "api-auth" page not in the sidebar); body `client_id`, `client_secret`; response `code`, `message`, `timestamp`, `data{token, expired_at}`.
- Formats: dates ISO 8601 `YYYY-MM` / `YYYY-MM-DD`, datetimes `YYYY-MM-DDThh:mm:ss.sTZD`, amounts as `"IDR67000"`. Bill details use `order_info`, `order_summary`, `order_details[]`.
- Product types mentioned: `pulsa`, `data`, `pln-prepaid`, `pln-postpaid`, `ewalet` (sic), PDAM, mobile postpaid, Internet and TV cable.
- Statuses: `pending` (not final), `success`, `failed`. Response codes: `00` success, `01` pending, `02` failed, `10` bill not available, `11` customer ID not found, `12` product not available, `13` account blocked, `14` account inactive, `15` kWh monthly limit, `16` daily cut-off, `17` max transaction limit, `40` invalid credentials, `41` token expired, `42` invalid parameters, `43` insufficient balance, `44` bill already paid, `45` transaction not found, `46` duplicate, `47` rejected, `50` internal error, `51` timeout.
- Base URLs, rate limits, countries: not documented (content is Indonesian billers, IDR).
- Relevance to Ari: none.

---

## 5. GrabGifts API (Grab For Business)

Source: https://developer.grab.com/docs/grab-gifts and subpages (`/gs-changelog`, `/auth-add_oauth_2_0_clients`, `/use_auth-generated-oauth-token-for-grabgifts-api-calls`, `/grabgifts-api`, `/ig-issue-grabgifts`, `/gl-get-gift-links`, `/cg-cancel-gift`, `/nw-notification-webhook`, `/ab-account-balance`, `/testing`, `/support`). Read 2026-11-15. Version 1.0.1 (15 Aug 2023, added gift status to Get Gift Links); 1.0.0 on 12 Apr 2023.

### Purpose
Lets a business issue Grab gift cards (GrabGifts) programmatically from a prepaid business balance: create gifts on demand, get a redemption link per gift, cancel unredeemed gifts, check balance. Gifts are spendable on chosen Grab services. Aimed at customer rewards, employee incentives and campaigns.

### Who it is for
Businesses and organisations (the buyer of the gifts). Recipients are ordinary Grab users who open the link.

### Access and onboarding
Register with the GrabGifts API team (Contact Us form before integration), then add an OAuth 2.0 client in the developer dashboard (staging dashboard `https://developer-beta.stg-myteksi.com`, production `http://developer.grab.com`). Slack group during integration. Production requires running all cases in the "GrabGifts API Test Validation document" and submitting evidence. The account needs a funded balance (see Account Balance).

### Countries and currencies
ID, MY, PH, SG, TH, VN (IDR, MYR, PHP, SGD, THB, VND). Gift values are fixed per country (for example `10`, `20`).

### Auth and scopes
OAuth 2.0 client credentials with `scope` `gifts.partner.api`, `grant_type` `client_credentials` (token endpoint is the standard GrabID one, not restated on these pages). Calls use `Authorization: Bearer <token>`; reuse until `expires_in` or a 401.

### Base URLs
- Staging host in samples: `https://partner-gateway.stg-myteksi.com`
- Production host: not documented (pages write `https://[HOST]`).

### Endpoints

| Name | Method + path |
|---|---|
| Issue GrabGifts (async) | `POST /gifts/partner/orders` |
| Get gift links | `GET /gifts/partner/orders/{GrabGiftOrderID}/gifts` |
| Cancel gift (async) | `POST /gifts/partner/gifts/cancel` |
| Account balance | `GET /gifts/partner/account/balance` |
| Notification webhook (to partner) | `POST https://{{PARTNER-HOST}}/<GRAB-PATH>` |

Key fields:
- Issue request: `type` (sender entity), `reference`, `idempotencyKey`, `order.senderAlias`, `order.gift.value` (integer), `order.gift.quantity` (max 1000 per order), `order.gift.countryCode` (`ID`, `MY`, `PH`, `SG`, `TH`, `VN`), `order.gift.inventories` (array of `grab_food`, `grab_mart`, `grab_transport`, `grab_express`), `order.gift.startDate` (UTC, future; default today), `order.gift.endDate` (default 180 days), `order.gift.designKey` (for example `thank_you`, `birthday`), `order.gift.messageTitle`, `order.gift.messageBody`. Response: `orderID`, `reference`. Wait for the webhook before reading links.
- Get gift links response: `gifts[]` with `UUID`, `url` (redemption link to send to the recipient), `start_date`, `end_date`, `currency`, `value`, `status` (`Issued`, `Redeemed`, `Cancelled`).
- Cancel request: `type`, `reference` (optional), `idempotencyKey`, `gifts` (array of gift UUIDs). Only `Issued`, unredeemed gifts. Response: `txID`, `reference`.
- Balance response: `value`, `symbol`, `lastUpdatedAt` (cached).
- API-issued gifts skip the card design and land the recipient directly on the redemption view in normal cases.

### Webhooks
Body: `txType` (`CREATE`, `CANCEL`), `partnerReference`, `txID`, `txStatus` (`success`, `fail`), `meta.create.giftsCreated`, `meta.cancel.cancelled[]`, `meta.cancel.failed[]`, `meta.error`, `createdAt`, `completedAt`. Header only `Content-Type: application/json` (no signature documented). Separate URLs for staging and production. No retries on failure. Reply 200 or 204.

### Rate limits
Not documented.

### Relevance to Ari
Usable for "send a Grab gift to a friend" or for Ari rewarding its own users: Ari (as the business account holder) buys gifts from its prepaid balance and hands the user or recipient the `url`. The gift value and service (`grab_food`, `grab_transport` and so on) are chosen at issue time. It does not touch the user's own Grab wallet and is not a way to pay for the user's orders, but a recipient can redeem the gift and then spend it in Grab. Commercial terms (discounts, top-up of balance) are not documented.

---

## 6. Risk Evaluation (GrabDefence)

Source: https://developer.grab.com/docs/grab-defence (single page "GrabDefence API Reference"). Read 2026-11-15.

### Purpose
Returns a fraud/risk score for an entity (a passenger, driver or phone number) at moments such as sign-up, sign-in, transaction, profile update or deletion, using Grab's ML risk engine, so the caller can add step-up checks.

### Who it is for
Partners (merchants/platforms) that want Grab's risk signal on their own users. Server to server only, no SDK.

### Access and onboarding
Grab partner account; credentials `partner_id`, `partner_secret`, `client_id`, `client_secret`, `merchant_id`; scope granted at onboarding. Contact your GrabDefence account manager.

### Auth and scopes
- OAuth 2.0 bearer token. The page says to obtain it "by following the steps in the Login with Grab API guide" with scope `grabdefence.riskevaluation` (the scopes list spells it `Grabdefence.riskevaluation`). Whether this is a client-credentials token or a user token is not stated.
- Headers: `Content-Type: application/json`, `Date`, `Authorization: Bearer {access_token}`. HMAC is mentioned in requirements but no HMAC header is shown for this endpoint.

### Base URLs
- Staging: `https://partner-api.stg-myteksi.com`
- Production: `https://partner-api.grab.com`

### Endpoint
`POST /grab_defence/entity_risk_evaluation/v1` (sample). The prose writes `POST grab-defence/entity-risk-evaluation/v1`; use the sample form and confirm with Grab.

Request:
- `entity_type` (required): `partner_safe_id`, `passenger_id`, `phone_number`, `hashed_phone_number` (SHA-256).
- `entity_id` (required).
- `scenario` (optional): `create`, `signin`, `transaction`, `update`, `delete`.
- `supplement.originating_ip` (customer IPv4, not your server), `supplement.email_address` (case-sensitive, not normalised).
- `location_info.latitude`, `location_info.longitude`, `location_info.city_code` (IATA), `location_info.country_code`.
- `app_info.name`, `app_info.version`, `app_info.user_agent`.

Response: `request_id` (32 chars), `risk_level` (documented `high`, `medium`, `low`; sample returns `high_risk`), `score` (0 to 100, 100 riskiest, "for client reference"), `error_code` (`""` normally), `message`.

HTTP codes documented: 200, 400.

### Countries, webhooks, rate limits
Countries not documented (sample uses `ID` / `CGK`). No webhooks. Rate limits not documented.

### Relevance to Ari
Indirect. Ari could score its own sign-ups or high-value actions (for example before issuing a gift or a digital product) by hashed phone number. It gives Ari no ordering or payment capability.

---

## 7. Loyalty: Points Earning API (Rewards Events) and GrabRewards Tier

Sources: https://developer.grab.com/assets/docs/grab-rewards/Rewards_Events_API.pdf (6 pages, "Rewards Events API Reference") and https://developer.grab.com/assets/docs/grab-rewards/Rewards_Tier_API.pdf (2 pages). Both are PDFs linked from the docs index; text was extracted in the browser. Read 2026-11-15. Neither PDF carries a date or version. Also skimmed for context: https://developer.grab.com/docs/partner-apps/pages/integrations/rewards/ (GrabCoins for Partner Apps).

### 7a. Points Earning API (`POST /rewards/v3/events`)

#### Purpose
Lets a partner business award GrabRewards points to Grab users for spending at the partner, using point formulas that Grab configures per source and country. The partner reports an event (a booking, payment or order); GrabRewards calculates points and credits them asynchronously, and shows the partner's `description` in the user's point history.

#### Who it is for
Partner businesses (loyalty partners) rewarding their own customers who are Grab users.

#### Access and onboarding
- Each "source" (event type, for example a booking or a GrabFood order) and every parameter key must be configured in the GrabRewards backend first; unknown sources give 403, missing required parameters give 400.
- Point formulas are configured by the GrabRewards Operation team on request (base parameter times multiplier, optionally conditional, for example `points = transactionAmount * 0.002` if `paymentMethod` is `"credit_card"`, else `* 0.001`). One formula applies per event.
- Before calling: "search for a Grab user using a phone number or an email, and enroll the user to your membership program", then store the returned `partnerUserID`. The search and enrolment endpoints are not documented in the PDF.

#### Auth
HMAC, not OAuth: headers `Content-Type: application/json`, `Date` (RFC 7231 GMT, the request time), `Authorization: <client_id>:<base64_encoded_hmac_signature>`. The PDF refers to an "Authorization section" for building the HMAC string, but that section is not in the PDF (not documented). No scopes mentioned.

#### Base URLs
- Staging: `https://api.stg-myteksi.com/rewards/v3/events`
- Production: `https://api.grab.com/rewards/v3/events`
- Note the different hosts (`api.` not `partner-api.`).

#### Request
- `idempotencyKey` (32-char v4 UUID without dashes), `source`, `sourceID` (unique within the source), `countryCode` (ISO 3166-1 alpha-2), `partnerUserID`, `description` (localised, shown in point history), `payload` (array of `{name, value}`; values are strings converted to the configured type, for example `transactionAmount` `"208000.0"`, `transactionCurrency` `"IDR"`, `paymentMethod` `"credit_card"`, `timeStamp` `"2018-10-24T00:57:46.798Z"`).

#### Response
- 200: `{ "points": 113 }` (int64). Grab guarantees that a success response means the same points will eventually be credited.
- 400 body: `reason` (for example `invalid_argument`), `target` (for example `payload`), `message`.
- Codes: 200, 400, 401 (missing/invalid Authorization), 403 (source invalid for partner), 500.

#### Countries, webhooks, rate limits
Countries: not listed (sample `ID`). Webhooks: none. Rate limits: not documented. Reversal/clawback of points: not documented.

### 7b. GrabRewards Tier (`GET /loyalty/rewards/v1/tier`)

#### Purpose
Returns the current user's GrabRewards tier.

#### Auth
`Authorization: Bearer {{OAuth token}}`, `Content-Type: application/json`. The token is a user token ("the current user's" tier), so it presumably comes from Login with Grab; the required scope is not documented.

#### Base URLs
- Staging: `https://partner-api.stg-myteksi.com/loyalty/rewards/v1/tier`
- Production: `https://partner-api.grab.com/loyalty/rewards/v1/tier`

#### Request / response
- No request parameters.
- Response: `{ "result": { "tier": "gold" } }`; `result.tier` values: `opt-out`, `member`, `silver`, `gold`, `platinum`.
- Codes: 200, 401 (token missing, invalid or expired), 500.

Points balance, point history and redemption: not documented in either PDF.

### 7c. Related: GrabCoins in Partner Apps (context only)
For Partner Apps (mini apps inside the Grab app), Grab configures a percentage GrabCoins rate; users see estimated GrabCoins on the payment sheet, coins are credited automatically at a completion date set when the payment is created (`completionTime` on items, see part 1), and adjusted for partial refunds before that date. No API call beyond the payment is needed. This only applies inside the Grab super app.

### Relevance to Ari
- Points Earning: Ari could award GrabRewards points for its own paid transactions (for example digital products or subscriptions) if Grab signs Ari as a rewards partner and configures a source. It does not let Ari make the user earn points on Grab orders (those are awarded by Grab already).
- Tier: with the user's Grab login, Ari can show "you are Gold" and tailor tips. Read-only; no balance.

---

## 8. Communications: GrabChat Partner API and GrabChat Web UI

Sources: https://developer.grab.com/docs/message-center and subpages (`/gs-prerequisites`, `/gs-api-environment`, `/gs-api-endpoints`, `/gs-constants`, `/authentication`, `/http-chatroom-lifecycle`, `/http-get-chatroom`, `/http-list-chatrooms`, `/http-send-message`, `/http-receipts`, `/http-rich-media`, `/http-get-messages`, `/http-templates`, `/wh-overview`, `/wh-envelope`, `/wh-security`, `/testing`, `/support`) and https://developer.grab.com/docs/message-center-webui. Read 2026-11-15. No changelog or dates shown.

### Purpose
Lets a partner platform exchange real-time chat with Grab users who take part in a Grab booking (for example the driver and the passenger of a ride). Grab opens a chatroom when a relevant booking starts and closes it when the booking ends; the partner sends and reads messages, receipts and images. Two options: API-based (own UI, HTTP API plus webhooks) or Web UI-based (embed Grab's chat screen with a user token).

### Who it is for
Partners whose users are participants in Grab bookings. The webhook payload carries `partnerBookingCode` ("your order ID, if supplied at chatroom creation") and `recipient.partnerUserId`, which implies the booking was created through a partner integration where the partner knows its own user. Which booking types qualify (rides, GrabExpress, food) is not documented. Sender types include Passenger, Driver, System and Merchant.

### Access and onboarding
Onboard as a Grab partner with GrabChat enabled. Grab issues `client_id`/`client_secret`, grants scope `comms.chat.partner`, records your webhook URL, optional traffic estimate (for rate limits) and Web UI preferences, and assigns a `partnerType` (Web UI). Staging test needs a staging booking to open a chatroom. Production enabled separately.

### Auth and scopes
- Partner API: OAuth 2.0 client credentials. `POST {host}/grabid/v1/oauth2/token` with `client_id`, `client_secret`, `grant_type: "client_credentials"`, `scope: "comms.chat.partner"`; sample `expires_in: 3600`. Then `Authorization: Bearer <ACCESS_TOKEN>`; Grab derives partner identity from the token.
- Web UI: a user access token injected via `window.grabParams.authToken` or `postMessage({type:"SET_AUTH_TOKEN", token})` (ack `{type:"AUTH_TOKEN_RECEIVED", success:true}`); token is "obtained through your Grab onboarding" (Login with Grab OAuth cookbook). The token is never put in the URL.

### Base URLs
- API staging: `https://partner-api.stg-myteksi.com/messagecenter`
- API production: `https://partner-api.grab.com/messagecenter`
- Web UI staging: `https://message-center-webview.stg-myteksi.com/chatroom`
- Web UI production: `https://message-center-webview.grab.com/chatroom`

### Endpoints (all under `/partner/v1`)

| Operation | Method + path | Key fields |
|---|---|---|
| Get chatroom by booking code | `GET /partner/v1/chatroom/{bookingCode}` | resp `roomID`, `category`, `categoryID` (booking code), `status`, `participants[]{id, name, user_type, locale}` |
| Get messages | `GET /partner/v1/chatroom/{roomID}/messages` | resp `messages[]{msgID, clientMsgID, content, contentType, senderID, senderKind, status, createdAtMS}`; no pagination |
| List chatrooms | `GET /partner/v1/chatrooms` | resp `chatrooms[]{roomID, category, categoryID, status, unreadCount}` |
| Send a message | `POST /partner/v1/chatroom/{roomID}/messages` | req `clientMsgId` (max 128, idempotent), `content`, `metadata`; resp `msgId`, `createdAt`, `createdAtMS` |
| Send receipts | `POST /partner/v1/chatroom/{roomID}/receipts` | req `receipts[]{msgId, status}` (1 delivered, 2 read); 200 empty |
| Presign rich media | `POST /partner/v1/chatroom/{roomID}/presign_rich_media` | req `clientMsgID`, `mimeType`, `checksum` (base64 MD5), `contentLength`, `fileName`, `text`, `metadata`; resp `messageID`, `clientMsgID`, `url` (S3 ap-southeast-1, single use, 30 min), `amzHeaders`, `createdAt`. Then `PUT` raw bytes to `url` echoing `amzHeaders`; images up to 5 MB |
| Create template | `POST /partner/v1/templates` | `template` (1 to 500 chars); resp `id`, `template`, `createdAt`, `updatedAt` |
| List templates | `GET /partner/v1/templates` | resp `templates[]`, `total`, `max` (20) |
| Update template | `PUT /partner/v1/templates/{id}` | `template` |
| Delete template | `DELETE /partner/v1/templates/{id}` | 200 empty |

No open or close chatroom endpoints for partners.

### Constants
- Chatroom status: `1` Active, `5` Pending closed, `4` Closed.
- Message content type: `1` Text, `2` Image/rich media, `3` System.
- Sender type: `1` Passenger, `2` Driver, `3` System, `8` Merchant.
- Message/receipt status: `1` Delivered, `2` Read, `4` Uploaded (rich media).

### Webhooks
- API integration: POST JSON envelope `eventType` (`NEW_CHATROOM`, `NEW_MESSAGE`, `MESSAGE_RECEIPT`, `CLOSE_CHATROOM`), `eventId` (dedupe), `roomId`, `bookingCode`, `createdAtMS`, `payload`. Payloads: NEW_CHATROOM `status`, `title`, `subtitle`, `createdAt`, `participants`; NEW_MESSAGE `msgId`, `clientMsgId`, `content`, `translatedContent`, `contentType`, `senderID`, `senderType` (for example `DRIVER`); MESSAGE_RECEIPT `receipts[]{msgId, clientMsgId, status}`; CLOSE_CHATROOM `closedAt`, `closedBy` (`SYS`). Reply 2xx within 10 s; best-effort with a few retries; reconcile with Get messages.
- Verification: `X-Signature: sha256=<hex HMAC-SHA256(raw body, shared secret)>`, `X-Timestamp` (ms), `X-Request-Id`; or alternatively `X-API-Key`.
- Web UI "undelivered-message" webhook (for native push when the user is not connected): POST to your endpoint with headers `x-request-id`, `x-timestamp`, `x-signature`; body `bookingCode`, `partnerBookingCode`, `roomId`, `recipient{partnerUserId, userType}`, `message{msgId, senderType, messageType (TEXT|IMAGE), content, translations, createdAtMS}`, `metadata`. At-least-once; retries on 5xx/timeout. Grab egress IPs: staging `13.250.221.182`, `52.77.204.168`, `52.77.203.26`; production `52.74.198.105`, `52.220.1.87`, `52.220.17.28`.

### Web UI details
URL params `bookingCode` (required), `partnerType` (required), `cameraEnabled` (optional, also needs Grab flag `send_media_enabled`). Native close via `window.bridge.closePage()` (iOS `WKScriptMessageHandler`). Features: text, status, resend, auto translation, profanity moderation, safety system messages, room open about 24 h after the order, quick-reply templates (`window.grabParams.quickReplyTemplates[{id, template, language}]`), per-`partnerType` theming (primary colour, fonts, SVG background). iOS needs `NSCameraUsageDescription` for images; JPEG/PNG up to 5 MB.

### Countries and rate limits
Countries not documented. Rate limits are per user, set at onboarding from expected traffic; 429 on excess.

### Relevance to Ari
Technically a good fit for an iPhone app (WKWebView embed with `bridge.closePage`, undelivered-message webhook for APNs push). But a chatroom exists only for a booking that Grab ties to your partner account, and the user token must come from Grab onboarding. Ari cannot attach to a ride or food order the user booked in the Grab app. It becomes usable only if Ari itself creates bookings through a partner booking integration (for example GrabExpress deliveries from part 1, if Grab enables chat for them; not documented).

---

## 9. GrabFood API, GrabMart API and Farefeed: anything new?

Sources: https://developer.grab.com/docs/grabfood/api/v1-1-3, https://developer.grab.com/docs/grabmart/api/v1-1-3 (Redoc pages; section lists, scopes, changelogs and the operations named below), https://developer.grab.com/docs/partner-farefeed. Also requested `/docs/grabfood`, `/docs/grabfood/api`, `/docs/grabmart`, `/docs/grabmart/api`: they return an empty shell with no links (no version index, no other docs). Read 2026-11-15.

### Verdict
Nothing new for a consumer app. Both are still the merchant-side POS API v1.1.3. A keyword search of the full GrabFood and GrabMart pages for "deep link", "deeplink", "deepLink", "consumer app", "universal link", "applink", "Ordering API", "order on behalf" and "catalog" found zero matches. There is no consumer ordering, no public menu/catalog read across merchants, and no deep-link documentation.

### What changed since part 1 (2026-10-01)
- Latest changelog entry for both is 2 Sep 2026, so there is nothing after part 1 was read. Recent 2026 entries: Singapore BCRS (Beverage Container Return Scheme) fields `BCRSUnit` (menu), `bcrsUnitCount` and `bcrsDepositFeeInMin` (orders; `eaterPayment` formula now includes `bcrsDepositFeeInMin`), discount type `fixPrice` (5 Mar 2026), WebP images (12 Feb 2026), loyalty webview best practices and the `food.partner.loyalty` scope (5 Feb 2026).
- Scopes: GrabFood `food.partner_api`, `food.partner.loyalty`; GrabMart `mart.partner_api`, `mart.partner.loyalty`.
- Sections worth knowing that part 1 only touched:
  - GrabFood SDKs in Go, Java, Node.js, Python, PHP (for the POS API).
  - Self-serve store activation: `POST /partner/v1/self-serve/activation` (`partner`, `merchantID`), webhooks `POST {{api-endpoint}}/<any-path>/pushGrabMenu` (`merchantID`, `partnerMerchantID`, `currency`, `sellingTimes`, `categories`) and `POST {{api-endpoint}}/<any-path>/pushIntegrationStatus` (`integrationStatus` `INACTIVE`, `ACTIVE`, `SYNCING`, `FAILED`). Mandatory for third-party POS/middleware since end of August 2025.
  - Trace menu sync: `GET /partner/v1/merchant/menu/trace?merchantID=`.
  - Partner Loyalty (Native): Grab calls the merchant's `POST .../v1/membership/bind` (`grabID`, `phoneNumber`), `POST .../v1/membership/register` (`grabID`, `phoneNumber`, `name`, `email`), `POST .../v1/membership/unbind` (`memberID`), `GET .../v1/membership` (`memberID`), `POST .../v1/reward` (`memberID`, `merchantID`, `items`, `orderValue`). The user's `membershipID` then appears in Submit Order payloads.
  - Partner Loyalty (Webview): partner calls Grab `POST /partner/v1/membership/notify` (`memberID`, `grabID`, `merchantID`, `action` `LINK`/`REGISTER`/`UNLINK`); Grab calls `POST .../v1/membership/unlink` and `GET .../v1/membership`.
  - These loyalty APIs are for a restaurant or retail chain's own loyalty programme shown inside the Grab app, not for a third-party assistant.

### Farefeed
Unchanged: a single estimate endpoint (scope `ride.estimate`, two-legged OAuth) returning `services[]` with `serviceID`, `serviceName`, `eta`, `fare{currency, maxFare, minFare}`, `deepLink` (onelink, works without the app installed), `directDeepLink` (`grab://open?...&screenType=BOOKING&taxiTypeId=...`, app must be installed), `iconLink`, `surgeNotice` (`NONE`, `HIGH_SURGE`). The word "book" appears only inside those deep-link URLs. No ride booking API, no changelog, no rate limits documented. Details are in part 1, section 2.

---

## Fit for a consumer assistant (Ari)

Ari is an iPhone personal assistant that wants users to order Grab services, pay with GrabPay, earn GrabRewards points, buy digital products or vouchers, and chat with drivers. Summary of what the public docs allow:

| Product | What Ari can do with it | Auth | Needs from Grab |
|---|---|---|---|
| Tokenisation API (GrabPay) | Link a user's GrabPay wallet once (web consent page), then charge it server to server with no redirect for Ari's own goods or services (wallet, PayLater, instalments), show balance and PayLater limit, apply promos, refund, unbind. Cannot pay for orders placed inside Grab. SG, MY, PH only. | HMAC with `partner_secret` for bind/refund; user OAuth (auth code + PKCE, scope `payment.recurring_charge`) plus `X-GID-AUX-POP` for charges | GrabPay merchant account, `partner_id`/`partner_secret`, `client_id`/`client_secret`, `merchant_id` per currency, scope grant, webhook URL registration, approval for `redirectDetail` (top-up flow) |
| Integrations Launchpad (PayLater, GrabPay) | Only brand rules and price-divider widgets for Ari's own checkout if it accepts GrabPay | none | Merchant status first |
| GrabMall API | Nothing (store-side catalog and order handling) | Client credentials, `mall.partner_api` | Not applicable |
| GrabKios Digital Products API | Sell Indonesian pulsa/data, game vouchers, PLN and other bill payments, e-wallet top-ups by voice; return token, serial number or receipt. Independent of the user's Grab account; Ari collects payment itself. | Raw API key in `Authorization` plus HMAC-SHA256 body signature | GrabKios partner account (billing or deposit), API key and secret, callback URL, WAF whitelisting, commercial pricing (`product_b2b_price`) |
| GrabKios Biller Gateway | Nothing (for billers) | Biller-issued token | Not applicable |
| GrabGifts API | Buy and send Grab gift links (food, mart, transport, express) to a friend or as Ari rewards; cancel unredeemed; check balance. Paid from Ari's prepaid business balance. ID, MY, PH, SG, TH, VN. | Client credentials, `gifts.partner.api` | Business account with GrabGifts team, funded balance, production host, test validation sign-off, webhook URL |
| Risk Evaluation (GrabDefence) | Score Ari's own sign-ups or high-value actions by hashed phone number | Bearer, scope `grabdefence.riskevaluation` | Partner account, scope grant |
| Points Earning API | Award GrabRewards points for Ari's own paid transactions (not for Grab orders) | HMAC `client_id:signature` (details not in PDF) | Rewards partnership, configured source and formula, the undocumented user search/enrol step to get `partnerUserID` |
| GrabRewards Tier | Show the signed-in user's tier (`member`, `silver`, `gold`, `platinum`, `opt-out`) | User Bearer token (scope not documented) | Login with Grab client and the tier scope |
| GrabChat Partner API / Web UI | Embed chat with the driver (WKWebView, push via undelivered-message webhook), but only for bookings Grab links to Ari's partner account; not for rides or orders the user made in the Grab app | Client credentials `comms.chat.partner` (API); user token (Web UI) | GrabChat enablement, `partnerType`, webhook secret, and above all a booking integration whose bookings get chatrooms (not documented) |
| GrabFood / GrabMart API | Nothing for ordering (merchant POS only); no consumer catalog or deep links documented | Client credentials, `food.partner_api` / `mart.partner_api` | Not applicable |
| Farefeed | Fare and ETA estimates plus deep links that open the Grab app on the booking screen; the user books there | Client credentials, `ride.estimate` | Farefeed access and scope |

Bottom line: from the public docs, Ari still cannot place a GrabFood, GrabMart or ride order, or pay for one, on a user's behalf. What Ari can build: Farefeed estimates plus deep-link handoff for rides (part 1), GrabKios digital goods in Indonesia, GrabGifts gift links, GrabPay tokenised charges for Ari's own products in SG/MY/PH, and showing the user's GrabRewards tier. Earning GrabRewards on Ari purchases and driver chat both need a bespoke partnership.

Open questions for Grab (not answered in the docs): which booking types (Express, transport) open GrabChat rooms for a partner, and whether a consumer-assistant partner can get them; the scope and token type for the Tier API; the user search and enrol endpoints and HMAC spec for Points Earning; whether a Points Earning source can be an Ari purchase paid via Tokenisation; GrabGifts production host and pricing; GrabKios rate limits and whether Ari may be a B2C partner without an Indonesian entity; Tokenisation staging availability and the real token lifetime (10 years vs `expires_in` about 1 year); whether `X-Signature` or `Signature` is the GrabKios header.
