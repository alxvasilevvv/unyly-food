# Архитектура Unyly for Grab

## Обзор

Один процесс Node.js (TypeScript) и одна база PostgreSQL. Микросервисы, очереди и Kubernetes не используются: при нагрузке беты они только добавили бы точки отказа.

```
 AI-клиент (ChatGPT / Claude / Gemini / API)  Браузер пользователя
        │  Streamable HTTP + Bearer (OAuth или PAT) │  HTML-формы + cookie-сессия
        ▼                                           ▼
 ┌──────────────── Fastify (src/app.ts) ───────────────────────────┐
 │ mcp/tools.ts      auth/oauth.ts (AS + RS)   web/routes.ts (SSR) │
 │      │                   │                       │              │
 │      └───────────► services/* (общая бизнес-логика) ◄───────────┘
 │                    catalog · carts · checkout · orders · handoff │
 │                            │                                     │
 │               providers/types.ts (интерфейс Provider)            │
 │         DemoProvider │ HandoffGrabProvider │ LiveGrabProvider    │
 │ jobs/worker.ts: сверка отправок, симулятор webhook, отмены, TTL  │
 └──────────────────────────────┬──────────────────────────────────┘
                                ▼
                          PostgreSQL 17
```

**Главный принцип:** MCP и веб-интерфейс вызывают одни и те же функции из `services/`. Слой MCP проверяет scopes и упаковывает ответ. Веб-слой проверяет сессию и CSRF и рендерит HTML. Бизнес-правил не содержит ни один из них.

## Ключевые решения

| Решение | Альтернатива | Почему так |
|---|---|---|
| Fastify 5 + серверный HTML (tagged templates) | Next.js | Один деплой и один процесс. Страница подтверждения работает без JS, CSP `script-src 'self'`, в UI нет сборки и гидрации. React стоит добавить, когда появится интерактив, которому нужен клиентский стейт |
| MCP SDK 1.31, Streamable HTTP, **stateless** (новый сервер и транспорт на каждый POST) | stateful-сессии и SSE | Горизонтальное масштабирование без sticky sessions, совместимость с MCP 2026-07-28. SSE объявлен deprecated |
| Собственный OAuth AS внутри Unyly | Внешний IdP (Auth0, Keycloak) | Меньше зависимостей в MVP; спецификация MCP требует аудиторию ресурса и PKCE. Внешний IdP можно подключить позже, так как RS проверяет токены через одну функцию `verifyAccessToken` |
| Непрозрачные токены (хэш SHA-256 в БД) | JWT | Мгновенный отзыв и проверка audience по записи grant, а утечка БД не раскрывает сами токены |
| Вход по passkey (WebAuthn) как основной способ, одноразовый код на email как запасной | Пароли, соцлогин | Нечего хранить и нечего утекать: хранится только публичный ключ. Коды на email включаются через SMTP, без почты поддержка выдаёт код командой `node dist/cli.js issue-login-code` |
| Фоновые задачи в том же процессе (`setInterval`, идемпотентные) | Отдельная очередь | Каждый шаг идёт под `pg_try_advisory_xact_lock`, поэтому при нескольких экземплярах его выполняет один; внутри шага строки захватываются условными `UPDATE ... WHERE status IN (...)`, события webhook через `FOR UPDATE SKIP LOCKED`, плюс уникальные ключи. Ошибка одного шага или одной строки не блокирует остальные |
| Деньги - `bigint` в минимальных единицах + ISO-код валюты | decimal/float | Нет ошибок округления. Exponent берётся из правил провайдера (THB = 2) |
| Время - `timestamptz` (UTC); показ в ICT (Asia/Bangkok) | - | Требование ТЗ |
| Один поток для всех сервисов (food, mart, ride, express): поездка и посылка - это корзина с одной «машиной» и маршрутом | Отдельные инструменты и таблицы на каждый сервис | Одна защита подтверждения, одна машина состояний, одни тесты. Сервис хранится в `carts.service` и `orders.service` |
| Десять языков интерфейса: `en, th, vi, id, ms, fil, km, my, zh, ru`. EN/RU/TH заданы в `web/messages.ts`, остальные семь - каталоги `src/i18n/locales/*.json` с ключом по английскому тексту, словари разбора демо-запросов в `src/i18n/packs/*.json`. `scripts/i18n-build.ts` компилирует их в `src/i18n/generated.ts`, который коммитится (JSON в рантайме не читается) | Библиотека i18n с загрузкой JSON | Нет рантайм-зависимостей; непереведённая строка показывается на английском |
| Демо-карта Бангкока (`providers/demo/places.ts`): ориентиры и районы на EN/RU/TH плюс местные названия из языковых пакетов, названия сохранённых адресов | Геокодер | Нет внешней зависимости и нет выдуманной точности. Live-адаптер использовал бы карты Grab |
| Рынки в `domain/regions.ts`: 8 стран Grab, ссылки на сервисы с флагом `verified` | Одна ссылка GrabFood TH | Handoff работает для всех сервисов и рынков; непроверенная ссылка честно помечена |

## Сущности

| Таблица | Назначение |
|---|---|
| `users` | Аккаунт, язык, регион (один из 8 рынков Grab), режим (`demo` / `handoff` / `live`) |
| `login_codes`, `web_sessions` | Вход на сайт по коду (коды хранятся хэшами), сессии с CSRF-токеном |
| `webauthn_credentials` | Passkeys пользователя: ID credential, публичный ключ, счётчик, транспорты, метка, даты создания и последнего входа |
| `webauthn_challenges` | Одноразовые challenge для регистрации, добавления и входа по passkey, с `expires_at`; удаляются через день после истечения |
| `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_tokens` | Подключения ИИ-клиентов: grant = пользователь × клиент × scopes × resource |
| `personal_tokens` | Персональные токены для клиентов без OAuth: префикс `unyly_pat_`, хранится только SHA-256, показывается один раз, срок 1–365 дней, до 10 активных, отзыв в кабинете. Принимаются только в заголовке `Authorization`, гостям недоступны. Отозванные и истёкшие удаляются через 30 дней |
| `provider_connections` | Подключение провайдера (demo - автоматически; live - `external_ref`, без секретов) |
| `addresses` | Адреса неизменяемы; удаление стирает название, улицу, район, город и инструкции. Отпечаток адреса привязывается к подтверждению, заказ хранит свою копию `address_label` |
| `preferences` | Питание (`dietary`) и аллергии (`allergies`) хранятся **раздельно** |
| `carts` + `cart_versions` | Корзина одного сервиса (`carts.service`) и неизменяемые версии состава, адреса и маршрута (`cart_versions.trip`: откуда, куда, посылка, оценка км и минут, отпечаток). `carts.version` - текущая |
| `quotes` | Расчёт цены для конкретной версии корзины и адреса, с TTL |
| `checkouts` | **Подтверждение**: user × cart_version × quote × отпечаток места × total × currency × expires_at, одноразовое. Отпечаток места (`address_fingerprint`) - это адрес доставки для food/mart или отпечаток маршрута для ride/express плюс содержимое сохранённых адресов, использованных как точки маршрута |
| `submission_attempts` | Попытка отправки. `UNIQUE(checkout_id)` и `UNIQUE(idempotency_key)` |
| `orders` | Принятый провайдером заказ, поездка или посылка (`orders.service`). `UNIQUE(checkout_id)` и `UNIQUE(provider, provider_order_ref)` |
| `cancellation_requests` | Подготовленная и подтверждённая отмена с суммой сбора |
| `handoffs` | Выданные списки и ссылки (это не заказы) |
| `provider_events` | Webhook и опросы: сохраняются до обработки, дедупликация по `UNIQUE(provider, event_id)` |
| `audit_log` | Действия и источники продуктовых метрик |
| `settings` | Выключатель новых заказов по режимам |
| `demo_sim_orders` | «Удалённая сторона» симулятора (в Live это состояние живёт у Grab) |
| `grab_deliveries` | Live GrabExpress: одна строка на попытку создания (`merchantOrderID` = id попытки), записывается до отправки; `deliveryID`, исходный статус Grab, состояние (`sending`, `created`, `unknown`, `rejected`, `not_sent`, `not_found`, `cancelled_unresolved`) |
| `grab_webhook_events` | Полученные webhook GrabExpress, только минимальные поля, уникально по `(deliveryID, status, timestamp)` |

## Машины состояний

Три независимых оси: подтверждение (checkout), исполнение (fulfillment) и оплата (payment).

**Checkout**
```
awaiting_user ──(человек нажал «Подтвердить» на сайте)──► approved ──(submit)──► consumed
      │                                                      │
      ├──► expired      (TTL: min(quote TTL, 10 мин))        ├──► expired
      ├──► invalidated  (CART_CHANGED / ADDRESS_CHANGED / SUPERSEDED)
      └──► declined     (человек отказался)
```
Перед одобрением и перед отправкой заново проверяются версия корзины, отпечаток места (адрес или маршрут) и срок действия. Изменение маршрута через `set_trip` или правка сохранённого адреса, который служит точкой маршрута, аннулирует ожидающее подтверждение. Цену проверяет провайдер: адаптер передаёт `expected_total_minor`, и при расхождении заказ отклоняется с `PRICE_CHANGED`.

**Submission attempt**
```
in_flight ──► accepted        (провайдер вернул заказ)
    │    └──► rejected        (провайдер отказал / PROVIDER_UNAVAILABLE до отправки)
    └──► unknown ──(сверка по idempotency_key)──► accepted
                   └──(3 раза «не найден» после окна 3×timeout)──► rejected NOT_RECEIVED_BY_PROVIDER
                                                                   └──(перепроверка 24 ч; нашёлся)──► accepted
```
Повторная отправка той же попытки **не выполняется никогда**. `in_flight`, зависший дольше `timeout + 5 с`, считается неизвестным и сверяется, например после перезапуска процесса.

**Fulfillment:** `submitted → accepted → preparing → picked_up → delivered`, плюс терминальные `cancelled` и `failed`. Состояния общие для всех сервисов, а подписи свои (`domain/labels.ts`, EN/RU/TH): для поездки `accepted` - «Водитель назначен», `picked_up` - «В пути», `delivered` - «Поездка завершена»; для посылки «Курьер назначен» ... «Посылка доставлена». Демо-таймлайн и условия отмены тоже заданы по сервису (`providers/demo/provider.ts`): у поездки и посылки последний шаг зависит от длительности маршрута, отмена бесплатна сразу после назначения, затем 30 THB (поездка) или 20 THB (посылка), после посадки или забора невозможна. События применяются, только если `sequence` провайдера больше сохранённого `status_version`; из терминального состояния выхода нет. Поэтому поздние и повторные события безопасны. Событие, пришедшее раньше записи заказа, хранится и применяется позже; через 24 часа оно помечается `orphaned`.

**Payment** хранится отдельно (`payment_status`): `not_charged_demo` / `pending` / `authorized` / `captured` / `refunded` / `paid_in_grab` / `unknown`. Значение приходит от провайдера и не выводится из fulfillment.

## Защита от двойного заказа

0. Корзина блокируется первой. Пока по ней есть отправка в `in_flight`, `unknown` или `accepted`, новые подтверждения и отправки отклоняются (`SUBMISSION_UNKNOWN` / `CART_NOT_OPEN`). У разных checkout разные idempotency key, поэтому защиту на уровне корзины нельзя заменить ключом.
1. На отправку берётся `SELECT … FOR UPDATE` строки checkout. Первая транзакция переводит её в `consumed` и создаёт `submission_attempt`; конкурирующие ждут блокировку и получают существующую попытку как идемпотентный повтор.
2. `UNIQUE(checkout_id)` на попытках и заказах работает даже при ошибке в коде.
3. Провайдеру передаётся `idempotency_key = unyly-<checkout_id>`. Demo-провайдер тоже идемпотентен по ключу, и так должен себя вести любой Live-адаптер.
4. При неизвестном результате идёт сверка через `lookupByIdempotencyKey`, повторной отправки нет.
5. Закрытие HTTP-запроса или вкладки не отменяет отправку: она доходит до конца на сервере, а отмена всегда отдельный подтверждённый шаг.

**Exactly-once не обещается.** Unyly гарантирует не более одной отправки на checkout со своей стороны. Отсутствие дублей у провайдера зависит от того, соблюдает ли он idempotency key.

## Вход через Grab (GrabID)

Необязательный способ входа рядом с passkey и кодом на email, включается `GRABID=on` (по умолчанию выключен, маршруты тогда отвечают 404). Код: `src/auth/grabid.ts` (конфигурация, discovery, JWKS, PKCE, обмен кода, проверка ID token, правила привязки) и `src/web/grabid-routes.ts` (маршруты и кнопки). Спецификация Grab: `docs/grab-api-research.md`, раздел 3.

- Поток: authorization code + PKCE S256 + `state` + `nonce`, scopes `openid profile.read` (без `phone`). Пути берутся из discovery `/grabid/v1/oauth2/.well-known/openid-configuration` на хосте окружения (кэш 1 час, при сбое используется последняя удачная копия). Клиент конфиденциальный (`client_secret_post`), код обменивается только на бэкенде.
- `GET /auth/grab/start` создаёт строку `grab_auth_states` (хэш `state`, `nonce`, `code_verifier`, безопасный `next`, срок 10 минут) и ставит HttpOnly cookie `unyly_grab_state` с самим `state` (путь `/auth/grab`, SameSite=Lax). `GET /auth/grab/callback` требует совпадения `state` из запроса и cookie, расходует строку атомарно, меняет код на токены, проверяет ID token локально (RS256 по JWKS с кэшем и подгрузкой нового `kid` при ротации ключей; `iss`, `aud`/`azp`, `exp`, `iat`, `nbf`, `nonce`, возраст не больше 10 минут) и затем через `id_token_verification_endpoint` Grab, если он есть в discovery. Userinfo вызывается один раз за email и имя; токены Grab нигде не сохраняются.
- Аккаунт: таблица `grab_identities (issuer, sub) -> user_id` (миграция 013), один Grab на аккаунт и наоборот. Ключ только `sub`: email в Grab может меняться.
- Правила: известный `sub` входит в свой аккаунт. Подключить Grab к текущему аккаунту можно только кнопкой «Подключить аккаунт Grab» в разделе «Данные» (POST с CSRF), привязка завершится только в той же сессии. Без сессии новый аккаунт создаётся, только если Grab вернул подтверждённый email (`email_verified: true`), которого нет у других аккаунтов. Совпадение email с существующим аккаунтом автоматически не связывается (защита от предварительного захвата, как в миграции 009): пользователь входит своим способом и подключает Grab. Гостевой демо-сеанс заменяется, к гостю Grab не привязывается. Первое подтверждение email кодом (`verifyEmailOwnership`) удаляет и привязку Grab, сделанную до него.
- Аудит: `user.login {method:'grabid'}`, `user.grab_linked`, `user.grab_unlinked`, `user.grab_link_refused`, `user.grab_login_refused`.

## Оплата GrabPay (One-time Charge)

Нужна для GrabExpress в режиме cashless: Grab выставляет счёт партнёру (Unyly), поэтому пользователь сначала платит Unyly через GrabPay One-time Charge (OTC v2), и только после поступления денег создаётся доставка. Если доставку создать не удалось или её отменили до забора, деньги возвращаются. Выключено по умолчанию (`GRABPAY=off`, все маршруты отвечают 404). Спецификация Grab: `docs/grab-api-research.md`, раздел 4.

Код: `src/payments/grabpay-config.ts` (env и проверки), `grabpay-otc.ts` (низкоуровневый клиент: HMAC-подпись запросов, заголовок `Date`, `X-GID-AUX-POP`, PKCE, init, authorize URL, обмен кода, complete, статус, refund, проверка подписи webhook), `service.ts` (машина состояний и API для потока заказа), `routes.ts` (маршруты). Таблицы `payments`, `payment_refunds`, `payment_events` (миграция 014).

**Поток.** `GET /pay/grab/start/:checkoutId?total_minor=` (только владелец checkout в `awaiting_user` или `approved`; checkout режима Live только в `approved`, то есть после согласия на странице подтверждения; сумма должна совпасть с тем, что видел человек) → `POST /grabpay/partner/v2/charge/init` (HMAC) → редирект на `/grabid/v1/oauth2/authorize` с `request`, `scope=payment.one_time_charge`, PKCE S256, `state`, `nonce`, `acr_values=consent_ctx:countryCode=TH,currency=THB` → пользователь подтверждает в Grab → `GET /pay/grab/callback?code&state` → обмен кода на токен → `POST /charge/complete` (Bearer + `X-GID-AUX-POP`) → `captured` → хук `onPaymentCaptured(ctx, checkoutId, paymentId)`.

**Payment**
```
created ──init──► authorizing ──code, token──► authorized ──complete success──► captured ──refund──► refunding ──► refunded
   │                  │                            │                                                      └──► captured (частичный возврат)
   ▼                  ▼ отмена, отказ Grab          ▼ complete failed / checkout больше не действует
 failed ◄──────── failed ◄──────────────────── failed
unknown (таймаут или 5xx на init, token, complete) ──сверка по one-time-charge status──► любое из состояний выше
```

**Защита от двойного списания.**
1. На checkout не больше одного платежа не в статусе `failed` (частичный уникальный индекс `payments_one_active`), строка checkout блокируется на время выбора.
2. `partnerTxID` выводится из id платежа (32 hex), `partnerGroupTxID` из id checkout. Повторный старт возвращает тот же редирект (тот же `state`, PKCE и `request`, пока код запроса Grab действует 20 минут), новый init не делается.
3. Неизвестный исход всегда сначала сверяется через `GET /grabpay/partner/v2/one-time-charge/{partnerTxID}/status` (HMAC, не чаще раза в 2 минуты на платёж). Grab не знает транзакцию: init повторяется с тем же `partnerTxID`. Grab знает, но ответ init потерян: эта попытка закрывается как `failed` (её никто не может подтвердить, Grab отменит её сам), только тогда допускается новая.
4. Код из callback забирается атомарно (`code_claimed_at`), повторный callback возвращает текущий результат без обращения к Grab. Хук после оплаты запускается не больше одного раза (уникальная запись `hook:captured:<id>` в `payment_events`).
5. `complete` (именно он переводит деньги) вызывается только пока checkout в `awaiting_user` или `approved` (Live: только `approved`), не истёк, его сумма равна сумме платежа и хук `setBeforePaymentComplete` не возразил (для Live он заново котирует доставку). Иначе платёж закрывается без списания, а резерв Grab снимает сам (`auth_expired`).
6. Сумма всегда берётся из checkout в минорных единицах (THB x100). Расхождение с суммой на странице, в webhook или в checkout отклоняется.
7. Возвраты идемпотентны по ключу (по умолчанию сумма + причина): `partnerTxID` возврата детерминирован, незавершённый возврат переотправляется с тем же ID (Grab возвращает последний статус). Параллельные возвраты Grab не поддерживает, поэтому новый ждёт завершения предыдущего; сумма возвратов не превышает списанную.

**Webhook** `POST /webhooks/grabpay`: подпись `Authorization: {partner_id}:{HMAC}` пересчитывается по нашему пути, полученным `Date` (окно ±5 минут) и `Content-Type` (как пришёл) и сырому телу, сравнение за постоянное время. События дедуплицируются (`payment_events.event_key`), неизвестные транзакции подтверждаются 200 и записываются. `Charge` с `success` переводит неизвестный платёж в `captured`, сумма и валюта сверяются; `Refund` закрывает возврат; `Auth` запускает сверку, которая по `oAuthCode` из статуса завершает оплату, если редирект пользователя потерялся.

**API для потока заказа** (`src/payments/service.ts`): `startPayment(ctx, userId, checkoutId, { expectedAmountMinor })`, `handleCallback(ctx, userId, query)`, `completePayment(ctx, paymentId)`, `refundPayment(ctx, paymentId, amountMinor | undefined, reason, { key })`, `reconcile(ctx, paymentId, { force })`, `reconcileOpenPayments(ctx)` (для фоновой задачи), `paymentForCheckout(ctx, checkoutId)`, `setOnPaymentCaptured(ctx, hook)`, `setBeforePaymentComplete(ctx, hook)` (последняя проверка перед `complete`, возвращает код причины или `null`), `syncOrderPayment(q, paymentId)` (переносит статус платежа на заказ). Оба хука регистрирует `registerLiveExpressPayment(ctx)` из `buildApp` один раз на ctx.

**Данные и PDPA.** Данные карт Unyly не видит и не хранит: оплата проходит на стороне Grab. Хранятся сумма, валюта, ID транзакций Grab, способ оплаты (например `GPWALLET`) и коды причин. Access token Grab (для возвратов, живёт до года) и PKCE verifier хранятся зашифрованными AES-256-GCM (`GRABPAY_TOKEN_KEY`), `state` только хэшем. Платежи - финансовые записи: при удалении аккаунта они отвязываются (`user_id`, `checkout_id` → NULL), а не удаляются. В реальных деньгах демо-заказ не оплачивается: при `GRABPAY_ENV=production` checkout режима demo отклоняется.

## Live: GrabExpress и Farefeed

Live-режим работает только через публичные партнёрские API Grab (`docs/grab-api-research.md`, разделы 1 и 2). Недокументированные и приватные API, скрейпинг и сбор логинов пользователей не используются. Код: `src/providers/grab/` (`config.ts`, `token.ts`, `http.ts`, `express.ts`, `farefeed.ts`, `places.ts`, `provider.ts`, `webhook.ts`), миграция 012. Каждая возможность включается своим флагом, при выключенных флагах Live ведёт себя как раньше (`LiveGrabProvider`, всё недоступно с причиной).

| Сервис | Флаг | Что делает Unyly | Чего нет |
|---|---|---|---|
| Посылка (`express`) | `GRAB_EXPRESS=on` | Котировки по каждому типу машины, создание доставки после нажатия «Подтвердить», статусы (webhook и `GET`), отмена до забора | Чаевые (не нужны) |
| Поездка (`ride`) | `GRAB_FAREFEED=on` | `estimate_trip`: диапазон цены, ETA подачи, флаг surge, название сервиса и `deep_link` в приложение Grab с заполненным маршрутом | Бронирования: API для третьих сторон у Grab нет. `create_cart` для поездки отвечает `CAPABILITY_UNAVAILABLE` с этой причиной |
| Еда, магазины | нет | Ничего: `CAPABILITY_UNAVAILABLE` с причиной «Grab has no public API to place Food or Mart orders for a customer; use Handoff mode» | Публичного API заказа от имени покупателя нет. Подмены демо-данными нет |

**Токены.** OAuth 2.0 client credentials через GrabID (`POST {gateway}/grabid/v1/oauth2/token`, JSON). Кэш на пару (клиент, scope): `grab_express.partner_deliveries` и `ride.estimate`. Обновление за 10% срока до истечения (не больше 5 минут) или после 401 (один повтор, 401 значит, что запрос Grab не обработал). Параллельные запросы ждут одно обновление. Токены и секреты не пишутся в логи.

**HTTP.** Таймаут на запрос `GRAB_HTTP_TIMEOUT_MS` (8 с), равномерный темп `GRAB_RPS` (sandbox 5 в секунду), отдельно для Express и Farefeed. В лог идут операция, путь, код ответа, время и `X-Grabkit-Grab-Requestid` / `X-Request-ID`; тела, адреса и телефоны не логируются. Ошибки соединения делятся на «не отправлено» (DNS, отказ в соединении: Grab запрос точно не получил) и «исход неизвестен» (таймаут, обрыв, 5xx).

**Места.** Курьеру и тарифам Grab нужны точные координаты (не меньше 6 знаков) и улица. Демо-справочник ориентиров в Live не используется. Точки маршрута в Live - только сохранённые адреса пользователя по названию. В адресе появились необязательные поля: координаты («широта, долгота» из приложения карт, не меньше 5 знаков, хранятся с 6), имя и телефон контакта в международном формате. Отпечаток адреса включает эти поля, только если они заданы (старые отпечатки не меняются), поэтому их изменение аннулирует подтверждение. Адрес без координат даёт `ADDRESS_REQUIRED` с `user_action`: попросить пользователя добавить адрес заново с координатами на `/app/addresses`. Отправитель GrabExpress - контакт адреса забора, получатель - контакт адреса доставки (`deliver_to` из `create_cart` не подходит: в нём нет координат). Ассистент по-прежнему видит только название и район адреса.

**Посылка: путь заказа.**
1. `estimate_trip { service: "express" }` запрашивает котировку для каждого типа машины из `GRAB_EXPRESS_VEHICLES` (по умолчанию `BIKE,CAR,VAN`, предметы `express-bike` и т.д.). Размер посылки неизвестен, поэтому берутся осторожные габариты по весу в пределах 50 x 50 x 50 см. Бизнес-ошибки Grab (вес, размер, расстояние, город) превращаются в `quote.issues`.
2. `create_cart` хранит маршрут и машину, котировка Grab действует 5 минут (Grab срок не документирует), подтверждение живёт до 15 минут; при одобрении устаревшая котировка пересчитывается для той же версии корзины, как и в Demo.
3. «Подтвердить» на странице Unyly вызывает `submitOrder`: ещё одна свежая котировка, при другой сумме `PRICE_CHANGED` и доставка не создаётся. Затем запись `grab_deliveries` в состоянии `sending` (до отправки), затем `POST /v1/deliveries` с `merchantOrderID` = id попытки отправки (`submission_attempts.id`), `paymentMethod` CASH или CASHLESS по `GRAB_EXPRESS_PAYMENT`, `payer: SENDER`. Ответ сразу сохраняет `deliveryID`.
4. Статусы: webhook `POST /webhooks/grab-express` и опрос `GET /v1/deliveries/{deliveryID}` при `get_order_status`. Соответствие: `QUEUEING`, `ALLOCATING` → `submitted`; `PENDING_PICKUP` → `accepted`; `PICKING_UP` → `preparing`; `PENDING_DROP_OFF`, `IN_DELIVERY`, `IN_RETURN` → `picked_up`; `COMPLETED` → `delivered`; `CANCELED`/`CANCELLED` → `cancelled`; `FAILED`, `RETURNED` → `failed`. Номер события - ранг статуса Grab, поэтому поздний webhook не откатывает заказ. Исходный статус Grab хранится в `grab_deliveries.last_status`.
5. Отмена: условия берутся из `GET` (бесплатно в `QUEUEING`, `ALLOCATING`, `PENDING_PICKUP`, `PICKING_UP`; с `PENDING_DROP_OFF` нельзя), выполнение `DELETE /v1/deliveries/{deliveryID}` после подтверждения на странице. 409 от Grab показывается как отказ, заказ продолжается.

**Неизвестный исход создания (выбор и обоснование).** У GrabExpress нет ключа идемпотентности и нет поиска по `merchantOrderID`, а один `merchantOrderID` может давать несколько доставок. Поэтому повторный `POST` после таймаута мог бы создать вторую доставку, и он запрещён:
- запись `grab_deliveries` создаётся до отправки; пока по ней нет `deliveryID`, новый `POST` для этой попытки не делается никогда (`ProviderOutcomeUnknownError`);
- таймаут, обрыв или 5xx переводят попытку в `unknown`; сверка (`lookupByIdempotencyKey`) ждёт webhook: Grab присылает его с `deliveryID` и нашим `merchantOrderID`, обработчик связывает их и сразу завершает сверку, заказ появляется со статусом из webhook;
- если за `GRAB_EXPRESS_UNKNOWN_CANCEL_AFTER_SEC` (10 минут) webhook не пришёл, Unyly вызывает `DELETE /v1/merchant/deliveries/{merchantOrderID}`: 204 значит, что доставка была и теперь отменена (заказ показывается пользователю как отменённый, `provider_order_ref = merchant:<id>`, запись в логе `grab_express_unknown_cancelled`); 404 значит, что ничего не создано (после трёх таких ответов попытка закрывается как `NOT_RECEIVED_BY_PROVIDER`, как в общем механизме); 409 значит, что доставка есть и уже не отменяется: ждём её webhook, попытка остаётся `unknown` и видна в мониторинге.
Отмена вместо ожидания выбрана потому, что пользователь не видел подтверждения от Grab, а курьер без связи с Unyly хуже, чем повторный заказ, который пользователь сделает сам. Пока исход неизвестен, ассистент получает `SUBMISSION_UNKNOWN` и не создаёт заказ заново.

**Webhook GrabExpress.** Подписи у Grab нет: Grab отправляет заданный нами секрет в `Authorization` (и, если настроен, `Authorization-Id`). Сравнение за постоянное время по SHA-256 обеих строк, иначе 401. Тело проверяется zod, неверное даёт 400. Хранятся только `deliveryID`, `merchantOrderID`, статус, время и причина отказа (`grab_webhook_events`, уникально по `(deliveryID, status, timestamp)`, чистка через 30 дней); имена, телефоны водителя и ссылки на фото не сохраняются. Обновление заказа идёт через `provider_events` (`event_id = <deliveryID>:<status>:<timestamp>`) и общую машину статусов, ответ 204. Повтор и дубль безопасны. Маршрут вне CSRF и cookie, лимит 3000 в минуту на IP (Grab шлёт до 33 в секунду). При `GRAB_EXPRESS=off` маршрут отвечает 404.

**Оплата.** `GRAB_EXPRESS_PAYMENT=cash` (по умолчанию): `paymentMethod: CASH`, `payer: SENDER`, отправитель платит курьеру наличными при заборе; `payment_status` заказа `pending`, шага оплаты нет. `cashless`: Grab выставляет счёт Unyly, поэтому пользователь сначала платит через GrabPay, и только потом создаётся доставка (раздел ниже).

## Cashless GrabExpress: оплата GrabPay до создания доставки

Код: `src/services/live-payment.ts` (хуки, решение о деньгах, фоновые шаги), правки в `services/checkout.ts`, `web/routes.ts`, `payments/routes.ts`, миграция 015 (`orders.payment_id`, `orders.picked_up_at`, `live_payment_settlements`).

**Запуск.** `GRAB_EXPRESS=on` и `GRAB_EXPRESS_PAYMENT=cashless` требуют `GRABPAY=on` и `GRABPAY_CURRENCY`, равную валюте рынка `GRAB_EXPRESS_REGION` (по умолчанию `TH`, то есть `THB`). Иначе сервер не стартует (`validateExpressPayment` в `loadConfig`): тихого перехода на наличные нет. Котировка Grab в другой валюте даёт `DELIVERY_UNAVAILABLE`.

**Сквозная последовательность.**
1. `estimate_trip` и `create_cart` как раньше. Способ оплаты в котировке и checkout: «GrabPay: paid in advance in Grab before the courier is booked». Ассистент получает в `checkout.note`, что кнопка ведёт в GrabPay.
2. Страница `/confirm/:id`: кнопка «Pay {total} with GrabPay and place the order», строка «Payment: GrabPay (you will be redirected to Grab to approve)».
3. `POST /confirm/:id`: все прежние проверки (CSRF и origin, сумма со страницы, passkey для крупной суммы, пересчёт устаревшей котировки) и запись согласия `approveCheckout` (`checkouts.status = approved`). Если новые заказы на паузе, оплата не начинается. Вместо `submitOrder` ответ `303` на `/pay/grab/start/:id?total_minor=<одобренная сумма>`.
4. `startPayment`: для Live принимается только `approved` checkout, сумма сверяется ещё раз; `init`, затем `302` на страницу согласия Grab. CSP `form-action` разрешает origin GrabPay, потому что Chrome проверяет его и на редиректах после отправки формы.
5. `GET /pay/grab/callback`: обмен кода на токен, затем хук `beforeComplete`: checkout всё ещё `approved` и не истёк, та же версия корзины и тот же способ оплаты, заказы не на паузе, свежая котировка Grab равна одобренной сумме. Любое расхождение: `complete` не вызывается, платёж `failed` с причиной (например `price_changed`), денег не списано, checkout помечается `invalidated` с `PRICE_CHANGED`, и пользователь обновляет цену.
6. `POST /charge/complete` → `captured` → хук `onCaptured` (не больше одного раза на платёж) → `submitOrder(checkoutId)` от имени `system`. `submitOrder` для такого checkout создаёт доставку только при платеже в статусе `captured` (иначе `CONFIRMATION_REQUIRED` с `payment_required: grabpay`), поэтому `submit_order` ассистента до оплаты ничего не создаёт. `merchantOrderID` = id попытки отправки, `paymentMethod: CASHLESS`, `payer: SENDER`.
7. Заказ получает `payment_id` и `payment_status` из платежа (`captured`). События Grab больше не перезаписывают `payment_status` такого заказа; первый `picked_up` или `delivered` записывает `orders.picked_up_at`.
8. Callback отвечает `303` на `/app/orders/:id?placed=1`, если заказ создан, иначе на `/confirm/:id`: там видно «Payment received, placing the order», отказ Grab с возвратом или неизвестный исход. Повторный callback ничего не повторяет и ведёт туда же.
9. Webhook GrabExpress и опрос двигают статусы до `delivered`; решение о деньгах (`kept`) записывается в `live_payment_settlements`.

**Правила возврата** (`settlePayment`, решение только по сохранённому состоянию, можно вызывать сколько угодно раз):

| Ситуация | Решение |
|---|---|
| Grab отклонил создание, `PRICE_CHANGED` или проблема котировки при отправке, `PROVIDER_UNAVAILABLE` (не отправлено) | полный возврат, причина `order_rejected` |
| Отправка закончилась `NOT_RECEIVED_BY_PROVIDER` | полный возврат, `order_not_received` |
| Оплачено, но отправка не началась (checkout истёк или аннулирован, пауза, корзина уже заказана) | полный возврат, `order_not_placed` |
| Исход создания неизвестен | ничего, пока стратегия неизвестного исхода Express не решит: «не получено» или «отменено по merchantOrderID» дают возврат |
| Отмена пользователем или Grab (`CANCELED`, водитель не найден) до забора | полный возврат, `delivery_cancelled` (или `delivery_failed` для `FAILED` до забора) |
| Отмена или сбой после забора (`picked_up_at` есть) | без автоматического возврата: запись `support` (`cancelled_after_pickup`, `failed_after_pickup`) и аудит `order.payment_needs_support` |
| Доставлено | `kept` |
| Grab отказал в возврате | `support`, `refund_failed` |
| Доставка нашлась после возврата «не получено» | `support`, `order_found_after_refund` |

Возврат идемпотентен: ключ `order:<checkout_id>:<причина>` (один checkout - один заказ), и на один платёж делается не больше одного автоматического полного возврата при любой причине. Каждое решение пишется в `live_payment_settlements` и в аудит (`order.payment_refund`, `order.payment_needs_support`). Статус возврата переносится на заказ (`refunded` после успеха).

**Где вызывается решение.** Сразу: в хуке после `submitOrder`, после отмены пользователем (`cancelOrder`, `reconcileCancellations`), в webhook GrabExpress для `cancelled`, `failed`, `delivered`. Страховка: фоновые шаги `reconcile_payments` (`reconcileOpenPayments`), `settle_live_payments` (оплаченный, но не отправленный через 30 секунд checkout отправляется снова; исход определяется заново) и `retry_refunds` (возвраты `pending` переотправляются с тем же `partnerTxID`, `processing` и `unknown` проверяются раз в 2 минуты).

**MCP.** `get_checkout_status` отвечает `status: awaiting_payment`, пока согласие есть, а платёж не прошёл, с `user_action` (открыть `confirm_url` и оплатить в GrabPay) и `payment: { method: grabpay, status }`. До появления заказа сводка никогда не говорит, что заказ оформлен. `get_order_status` показывает `payment_status` платежа и `payment_method: grabpay`.

## Webhook

- Схема Demo: HMAC-SHA256 от `"<t>.<raw body>"` в заголовке `x-unyly-demo-signature: t=…,v1=…`, допуск ±300 с. Тело читается как raw string до разбора JSON.
- Порядок обработки: проверка подписи → вставка в `provider_events` (дедупликация) → обработка в отдельной транзакции (`FOR UPDATE SKIP LOCKED`).
- Если webhook недоступен, работает опрос: `get_order_status` обновляет незавершённые заказы, а задачи ограничены лимитами и backoff.
- Live GrabExpress: `POST /webhooks/grab-express`, общий секрет в `Authorization` (подписи у Grab нет), см. раздел «Live: GrabExpress и Farefeed». Для потребительских заказов Food и Mart схемы событий у Grab нет.

## Структура кода

```
src/
  app.ts              Fastify: безопасность, OAuth, MCP, webhook, health
  main.ts             запуск, миграции, фоновые задачи, graceful shutdown (ждёт текущий проход задач, принудительный выход через 10 с)
  cli.ts              операции: migrate, issue-login-code, kill-switch (`node dist/cli.js ...`)
  config.ts           конфигурация из env и проверки для production
  context.ts          Ctx (db, clock, providers, mailer), Actor, audit()
  db/                 пул pg, транзакции с retry, SQL-миграции
  domain/             ошибки, деньги, криптография, рынки и ссылки (regions.ts), подписи статусов (labels.ts)
  providers/          интерфейс; demo (catalog.ts, places.ts, provider.ts: тарифы, таймлайны, отмена); handoff/live без флагов (unavailable.ts); grab/ (Live: GrabExpress, Farefeed, webhook)
  services/           бизнес-логика, общая для MCP и веба
  auth/               веб-сессии, OAuth 2.1 AS/RS
  mcp/tools.ts        15 инструментов, схемы, title и аннотации, envelope, SERVER_INSTRUCTIONS
  i18n/               каталоги 7 языков (locales/*.json), словари демо-разбора (packs/*.json), generated.ts
  web/                страницы, тексты ru/en/th (messages.ts), /try (intent.ts: определение сервиса; try-services.ts), CSS/JS
  payments/          GrabPay One-time Charge: клиент OTC, машина состояний платежей, маршруты /pay/grab и /webhooks/grabpay
  jobs/worker.ts      сверка, симулятор, TTL, очистка; каждый шаг под advisory lock
```
