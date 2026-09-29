# Архитектура Unyly

## Обзор

Один процесс Node.js (TypeScript) и одна база PostgreSQL. Микросервисы, очереди и Kubernetes не используются: при нагрузке беты они только добавили бы точки отказа.

```
 AI-клиент (ChatGPT / Claude / API)          Браузер пользователя
        │  Streamable HTTP + Bearer                 │  HTML-формы + cookie-сессия
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
| Вход по одноразовому коду на email | Пароли, соцлогин | Нечего хранить и нечего утекать; SMTP подключается конфигом |
| Фоновые задачи в том же процессе (`setInterval`, идемпотентные) | Отдельная очередь | Задачи безопасно запускать в нескольких экземплярах: захват строк через `FOR UPDATE`/`SKIP LOCKED` и уникальные ключи |
| Деньги - `bigint` в минимальных единицах + ISO-код валюты | decimal/float | Нет ошибок округления. Exponent берётся из правил провайдера (THB = 2) |
| Время - `timestamptz` (UTC); показ в ICT (Asia/Bangkok) | - | Требование ТЗ |

## Сущности

| Таблица | Назначение |
|---|---|
| `users` | Аккаунт, язык, регион, режим (`demo` / `handoff` / `live`) |
| `login_codes`, `web_sessions` | Вход на сайт (коды хранятся хэшами), сессии с CSRF-токеном |
| `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_tokens` | Подключения ИИ-клиентов: grant = пользователь × клиент × scopes × resource |
| `provider_connections` | Подключение провайдера (demo - автоматически; live - `external_ref`, без секретов) |
| `addresses` | Адреса неизменяемы; удаление стирает текст. Отпечаток адреса привязывается к подтверждению |
| `preferences` | Питание (`dietary`) и аллергии (`allergies`) хранятся **раздельно** |
| `carts` + `cart_versions` | Корзина и неизменяемые версии состава/адреса. `carts.version` - текущая |
| `quotes` | Расчёт цены для конкретной версии корзины и адреса, с TTL |
| `checkouts` | **Подтверждение**: user × cart_version × quote × address_fingerprint × total × currency × expires_at, одноразовое |
| `submission_attempts` | Попытка отправки. `UNIQUE(checkout_id)` и `UNIQUE(idempotency_key)` |
| `orders` | Принятый провайдером заказ. `UNIQUE(checkout_id)` и `UNIQUE(provider, provider_order_ref)` |
| `cancellation_requests` | Подготовленная и подтверждённая отмена с суммой сбора |
| `handoffs` | Выданные списки и ссылки (это не заказы) |
| `provider_events` | Webhook и опросы: сохраняются до обработки, дедупликация по `UNIQUE(provider, event_id)` |
| `audit_log` | Действия и источники продуктовых метрик |
| `settings` | Выключатель новых заказов по режимам |
| `demo_sim_orders` | «Удалённая сторона» симулятора (в Live это состояние живёт у Grab) |

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
Перед одобрением и перед отправкой заново проверяются версия корзины, отпечаток адреса и срок действия. Цену проверяет провайдер: адаптер передаёт `expected_total_minor`, и при расхождении заказ отклоняется с `PRICE_CHANGED`.

**Submission attempt**
```
in_flight ──► accepted        (провайдер вернул заказ)
    │    └──► rejected        (провайдер отказал / PROVIDER_UNAVAILABLE до отправки)
    └──► unknown ──(сверка по idempotency_key)──► accepted
                   └──(3 раза «не найден» с backoff)──► rejected NOT_RECEIVED_BY_PROVIDER
```
Повторная отправка той же попытки **не выполняется никогда**. `in_flight`, зависший дольше `timeout + 5 с`, считается неизвестным и сверяется, например после перезапуска процесса.

**Fulfillment:** `submitted → accepted → preparing → picked_up → delivered`, плюс терминальные `cancelled` и `failed`. События применяются, только если `sequence` провайдера больше сохранённого `status_version`; из терминального состояния выхода нет. Поэтому поздние и повторные события безопасны. Событие, пришедшее раньше записи заказа, хранится и применяется позже; через 24 часа оно помечается `orphaned`.

**Payment** хранится отдельно (`payment_status`): `not_charged_demo` / `pending` / `authorized` / `captured` / `refunded` / `paid_in_grab` / `unknown`. Значение приходит от провайдера и не выводится из fulfillment.

## Защита от двойного заказа

1. На отправку берётся `SELECT … FOR UPDATE` строки checkout. Первая транзакция переводит её в `consumed` и создаёт `submission_attempt`; конкурирующие ждут блокировку и получают существующую попытку как идемпотентный повтор.
2. `UNIQUE(checkout_id)` на попытках и заказах работает даже при ошибке в коде.
3. Провайдеру передаётся `idempotency_key = unyly-<checkout_id>`. Demo-провайдер тоже идемпотентен по ключу, и так должен себя вести любой Live-адаптер.
4. При неизвестном результате идёт сверка через `lookupByIdempotencyKey`, повторной отправки нет.
5. Закрытие HTTP-запроса или вкладки не отменяет отправку: она доходит до конца на сервере, а отмена всегда отдельный подтверждённый шаг.

**Exactly-once не обещается.** Unyly гарантирует не более одной отправки на checkout со своей стороны. Отсутствие дублей у провайдера зависит от того, соблюдает ли он idempotency key.

## Webhook

- Схема Demo: HMAC-SHA256 от `"<t>.<raw body>"` в заголовке `x-unyly-demo-signature: t=…,v1=…`, допуск ±300 с. Тело читается как raw string до разбора JSON.
- Порядок обработки: проверка подписи → вставка в `provider_events` (дедупликация) → обработка в отдельной транзакции (`FOR UPDATE SKIP LOCKED`).
- Если webhook недоступен, работает опрос: `get_order_status` обновляет незавершённые заказы, а задачи ограничены лимитами и backoff.
- Для Live нужна схема подписи Grab. Для потребительских заказов она не документирована, поэтому не реализована.

## Структура кода

```
src/
  app.ts              Fastify: безопасность, OAuth, MCP, webhook, health
  main.ts             запуск, миграции, фоновые задачи, graceful shutdown
  config.ts           конфигурация из env и проверки для production
  context.ts          Ctx (db, clock, providers, mailer), Actor, audit()
  db/                 пул pg, транзакции с retry, SQL-миграции
  domain/             ошибки, деньги, криптография
  providers/          интерфейс; demo (каталог + симулятор); handoff/live
  services/           бизнес-логика, общая для MCP и веба
  auth/               веб-сессии, OAuth 2.1 AS/RS
  mcp/tools.ts        14 инструментов, схемы, аннотации, envelope
  web/                страницы, i18n (ru/en), CSS/JS
  jobs/worker.ts      сверка, симулятор, TTL, очистка
```
