# Размещение и эксплуатация

## Инфраструктура

`unyly.org` принадлежит владельцу проекта (маркетплейс MCP + Unyly Deploy). Unyly размещён на поддомене платформы, DNS не менялся.

## Текущее размещение: Unyly Deploy (https://unyly-food.unyly.org)

Проверено 30.09.2026: `unyly.org` - собственная платформа владельца. Unyly Deploy (deploy.unyly.org) собирает GitHub-репозиторий по его `Dockerfile` и публикует на `slug.unyly.org`, пуш в ветку пересобирает проект. Поэтому отдельный VPS, Caddy и DNS-записи не нужны: TLS и домен даёт платформа.

1. Репозиторий `alxvasilevvv/unyly-food` (публичный: секретов в коде нет, все секреты в Unyly Deploy), ветка `main`, пуш пересобирает проект.
2. Проект `unyly-food` в Unyly Deploy (тип Site, собственный Dockerfile, порт 3000, лимиты 0.5 CPU / 384 MiB). Адрес: `unyly-food.unyly.org`. Опубликован 30.09.2026.
3. База: схема `unyly` и роль `unyly_app` в Supabase-проекте `agentum-ledger` (ap-southeast-1; лимит бесплатных проектов исчерпан, поэтому отдельная схема вместо отдельного проекта). Подключение через transaction pooler `aws-0-ap-southeast-1.pooler.supabase.com:6543`. Перенос в отдельный проект: `pg_dump -n unyly` и смена `DATABASE_URL`.
4. Переменные окружения (секреты задаются в консоли Unyly Deploy):

| Переменная | Значение |
|---|---|
| `NODE_ENV` | `production` |
| `WEB_ORIGIN` | `https://unyly-food.unyly.org` |
| `MCP_RESOURCE_URL` | `https://unyly-food.unyly.org/mcp` |
| `DATABASE_URL` | `postgresql://unyly_app.<ref>:<password>@<pooler-host>:6543/postgres` |
| `DATABASE_POOLER` | `transaction` |
| `DATABASE_SSL` | `no-verify` (или `DATABASE_SSL_CA` с сертификатом Supabase для полной проверки) |
| `DATABASE_POOL_MAX` | `5` (при `RUN_JOBS` нужно не меньше 2: задача держит одно соединение под advisory lock) |
| `DEMO_WEBHOOK_SECRET` | случайные 32 байта |
| `MAIL_MODE` | `disabled` (вход по passkey), или `smtp` + `SMTP_URL` |
| `DEV_ECHO_LOGIN_CODE` | `false` |
| `TRUST_PROXY` | число доверенных прокси перед приложением (hop count), например `1` за балансировщиком Unyly Deploy. `true` доверяет любому `X-Forwarded-For` и годится, только если приложение недоступно напрямую. От значения зависят IP в лимитах запросов и гостевых лимитах |
| `SUPPORT_EMAIL` | адрес поддержки |
| `DEMO_GUEST_SPEED` | во сколько раз быстрее идут гостевые заказы из `/try` (по умолчанию 12, доставка ~3 минуты) |
| `GUEST_PER_IP_HOURLY` / `GUEST_HOURLY_LIMIT` | лимиты создания гостевых аккаунтов: на IP в час (6) и всего в час (2000) |

`DATABASE_URL` может содержать несколько адресов через `|` (например, два хоста пулера): и сервер, и `dist/cli.js` берут первый доступный.

Операции внутри контейнера: `node dist/cli.js kill-switch demo off`, `node dist/cli.js issue-login-code user@example.com` (восстановление доступа без почты), `node dist/cli.js migrate`.

**Вход без почтового сервиса.** Основной вход - passkey (WebAuthn: Face ID, Touch ID, Windows Hello, ключи безопасности). Коды на email включаются через `MAIL_MODE=smtp`. Без SMTP поддержка выдаёт одноразовый код командой `issue-login-code`, пользователь вводит его на `/login/code` и добавляет новый passkey.

## Окружения

| | staging | production |
|---|---|---|
| Хосты | отдельный проект Unyly Deploy из ветки `staging` | `unyly-food.unyly.org` |
| БД | отдельная | отдельная, с ежедневным бэкапом и проверкой восстановления |
| `DEV_ECHO_LOGIN_CODE` | `true` допустимо (закрыть basic-auth в Caddy) | **`false`**; приложение не стартует, если в production стоит `true` |
| `MAIL_MODE` | console / smtp | smtp |
| Режимы | demo, handoff | demo, handoff (live выключен до договора с Grab) |

## Развёртывание (один VPS, Docker Compose + Caddy)

```bash
git clone <repo> unyly && cd unyly
cp .env.example .env    # заполнить: WEB_ORIGIN, MCP_RESOURCE_URL, POSTGRES_PASSWORD, DEMO_WEBHOOK_SECRET, SMTP_URL
# отредактировать deploy/Caddyfile под выбранные хосты
docker compose --profile tls up -d --build
curl -fsS https://<web host>/readyz
```
Миграции применяются при старте: они идемпотентны и защищены advisory lock, который берётся до создания `schema_migrations`, так что параллельный запуск нескольких экземпляров безопасен. Список миграций после 005:

| Миграция | Что меняет |
|---|---|
| 006 | `carts.service`, `cart_versions.trip`, `orders.service` (мульти-сервис) |
| 007 | таблица `personal_tokens` |
| 008 | CHECK `users_locale_check` заменён: десять языков `en, th, vi, id, ms, fil, km, my, zh, ru` (старый CHECK на `ru/en/th` удаляется) |
| 009 | безопасность (ведёт другой разработчик): `users.email_verified_at`, `oauth_clients.updated_at` |
| 010 | индексы для фоновых задач, очистки и каскадов по FK (`CREATE INDEX IF NOT EXISTS`, без `CONCURRENTLY`, так как миграция идёт в транзакции; на большой таблице индекс с тем же именем можно заранее создать вручную `CONCURRENTLY`) |
| 012 | Live GrabExpress: в `addresses` координаты и контакт (`latitude`, `longitude`, `contact_name`, `contact_phone`), таблицы `grab_deliveries` и `grab_webhook_events` |

Все миграции аддитивные.

**HTTPS и reverse proxy.** Caddy выпускает сертификаты сам, как только DNS указывает на хост. Если прокси Cloudflare включён (оранжевое облако), поставьте режим SSL «Full (strict)». Streaming и таймауты: `flush_interval -1`, `response_header_timeout 35s`; таймаут провайдера в приложении 10 с, Fastify `requestTimeout` 30 с.

**Health:** `/healthz` (процесс жив), `/readyz` (БД доступна, миграции применены; 503 иначе). Docker `HEALTHCHECK` ходит на `/readyz` по порту `${PORT:-3000}`.

**Остановка.** По SIGTERM/SIGINT таймер задач останавливается, текущий проход задач и запросы в работе дожидаются завершения, затем закрывается пул. Если что-то зависло, через 10 с процесс завершается принудительно. Повторный сигнал не запускает остановку второй раз.

## Откат

1. Образы тегируются по git SHA: `docker compose build && docker tag unyly-app unyly-app:<sha>`.
2. Откат: `docker compose up -d app` на предыдущем теге.
3. Миграции только аддитивные (новые таблицы и колонки). Удаление колонок делается отдельным релизом после того, как старый код выведен, поэтому откат кода не требует отката БД.
4. Если откатывать нужно из-за заказов, сначала включите выключатель (ниже).

## Выключатель новых заказов

Новые заказы блокируются, а чтение статусов, сверка и webhook продолжают работать.
- Глобально: `SUBMISSIONS_ENABLED=false` и перезапуск.
- По режиму, без перезапуска:
  - dev: `npm run kill-switch -- demo off`
  - production (внутри контейнера приложения): `node dist/cli.js kill-switch demo off`, проверка: `node dist/cli.js kill-switch status`. Команда пишет запись в `audit_log`.

## Бэкапы

`scripts/backup-verify.sh [-n SCHEMA]` делает `pg_dump` (custom format) одной схемы (по умолчанию `public`; для Supabase-размещения `-n unyly`), восстанавливает его во временную БД и сверяет количество строк в ключевых таблицах, указывая таблицы с именем схемы. **Для Supabase скрипту нужно прямое подключение или session pooler (порт 5432), а не transaction pooler 6543**: `pg_dump` держит состояние сессии, которое transaction pooler не сохраняет. Скрипт предупреждает, если в `DATABASE_URL` порт 6543. Ставится в cron раз в сутки, дампы нужно уносить за пределы хоста (S3/B2). Скрипт проверен локально 30.09.2026: дамп 60 КБ, восстановление прошло, количества строк совпали.

## Ограничение запросов

Глобально 300 запросов в минуту на IP или токен. `/mcp` - 120 в минуту на токен. `/login` - 10 в минуту, `/login/verify` - 20 в минуту. `/oauth/token` - 60 в минуту, `/oauth/register` - 20 в час. Коды входа: 5 в час на email, 5 попыток на код. При нескольких экземплярах нужно перенести rate-limit в общее хранилище (Redis) или на Cloudflare.

## Мониторинг

Логи: JSON (pino) в stdout. Заголовки `authorization` и `cookie` вырезаются.

| Сигнал | Как смотреть | Порог тревоги |
|---|---|---|
| Ошибки 5xx | логи `res.statusCode >= 500` | > 1% за 5 мин |
| Задержка `/mcp` | `responseTime` в логах (p95) | > 3 с |
| **Неизвестные отправки** | `SELECT count(*) FROM submission_attempts WHERE status='unknown'` | **> 0 дольше 10 мин - дежурному** |
| Зависшие отправки | `status='in_flight' AND started_at < now() - interval '1 minute'` | > 0 |
| Отклонения провайдером | `audit_log action='submission.rejected'` по `details->>'code'` | всплеск |
| Повторы и сверки | `submission_attempts.reconcile_attempts > 0` | - |
| Необработанные webhook | `provider_events WHERE processed_at IS NULL AND received_at < now()-interval '5 min'` | > 0 |
| Неизвестные отмены | `cancellation_requests WHERE status='unknown'` | > 0 |
| Доставки GrabExpress без исхода | `grab_deliveries WHERE delivery_id IS NULL AND state IN ('sending','unknown') AND created_at < now() - interval '15 min'` | > 0 |

Готовые запросы для дашборда лежат в `docs/metrics.sql`. Для алертов подойдёт Grafana Cloud или Better Stack поверх логов, либо cron с `psql` и отправкой в Telegram.

## Вход через Grab (GrabID)

Выключен по умолчанию. Доступ выдаёт команда GrabID вручную (нужен партнёрский аккаунт Grab, см. `docs/grab-api-research.md`, раздел 3). При регистрации клиента указать redirect URI:

`https://unyly-food.unyly.org/auth/grab/callback`

| Переменная | Значение |
|---|---|
| `GRABID` | `on` или `off` (по умолчанию `off`; другое значение не даст приложению запуститься) |
| `GRABID_ENV` | `sandbox` (по умолчанию, `https://partner-api.stg-myteksi.com`) или `production` (`https://partner-api.grab.com`) |
| `GRABID_CLIENT_ID` | `client_id` от Grab, обязателен при `GRABID=on` |
| `GRABID_CLIENT_SECRET` | `client_secret` от Grab, обязателен при `GRABID=on` (GrabID поддерживает только `client_secret_post`). Передавать из менеджера секретов, не хранить в файле конфигурации (требование Grab) |
| `GRABID_REDIRECT_URI` | по умолчанию `{WEB_ORIGIN}/auth/grab/callback`; должен точно совпадать с зарегистрированным, в production только https |
| `GRABID_ISSUER` | переопределяет базовый адрес discovery (для тестов и стендов); в production только https |
| `GRABID_VERIFY_ENDPOINT` | `on` (по умолчанию) дополнительно проверяет ID token через `id_token_verification_endpoint` Grab, как требует Grab; `off` только если стенд его не поддерживает |

Проверить в sandbox до включения в production: формат тела token endpoint (форма или JSON), метод и путь `id_tokens/token_info`, значение `issuer` в discovery, и передаёт ли Grab `email_verified`. Без `email_verified: true` новые аккаунты через Grab не создаются: вход работает для уже подключённых аккаунтов, а новые пользователи сначала создают аккаунт с passkey или кодом и подключают Grab в разделе «Данные». Ограничение запросов: `/auth/grab/start`, `/auth/grab/callback`, `/auth/grab/link`, `/app/grab/unlink` по 20 в минуту на IP. Запросы входа (`grab_auth_states`) удаляются через 1 день после истечения.

## Оплата GrabPay (One-time Charge)

Выключена по умолчанию. Нужна для GrabExpress в режиме cashless (см. `docs/architecture.md`, раздел «Оплата GrabPay»). Доступ выдаёт Integration Manager Grab: он собирает Redirect URL и Webhook URL, выдаёт тестовые креды для production и тестовый аккаунт покупателя (тестирование идёт на production с тестовыми кредами), затем боевые. Зарегистрировать у Grab:

- Redirect URL: `https://unyly-food.unyly.org/pay/grab/callback`
- Webhook URL: `https://unyly-food.unyly.org/webhooks/grabpay`

| Переменная | Значение |
|---|---|
| `GRABPAY` | `on` или `off` (по умолчанию `off`; при `off` все маршруты `/pay/grab/*` и `/webhooks/grabpay` отвечают 404; другое значение не даст приложению запуститься) |
| `GRABPAY_ENV` | `sandbox` (по умолчанию, `https://partner-api.stg-myteksi.com`) или `production` (`https://partner-api.grab.com`). В `production` checkout режима demo не оплачивается |
| `GRABPAY_PARTNER_ID` | `partner_id` от Grab (подпись HMAC запросов и webhook), обязателен при `GRABPAY=on` |
| `GRABPAY_PARTNER_SECRET` | `partner_secret`, обязателен; только из менеджера секретов |
| `GRABPAY_MERCHANT_ID` | `merchantID`, обязателен; один merchant на одну валюту |
| `GRABPAY_CLIENT_ID` | OAuth `client_id` для GrabID, обязателен |
| `GRABPAY_CLIENT_SECRET` | OAuth `client_secret` (обмен кода и подпись `X-GID-AUX-POP`), обязателен; только из менеджера секретов |
| `GRABPAY_REDIRECT_URI` | по умолчанию `{WEB_ORIGIN}/pay/grab/callback`; должен точно совпадать с зарегистрированным, в production только https |
| `GRABPAY_CURRENCY` | валюта merchant-аккаунта: `THB` (по умолчанию), `SGD`, `MYR`, `PHP`, `IDR`. Checkout в другой валюте не оплачивается |
| `GRABPAY_TOKEN_KEY` | ключ шифрования сохранённых токенов Grab и PKCE verifier (AES-256-GCM), не меньше 32 символов (`openssl rand -hex 32`). Если не задан, выводится из `GRABPAY_CLIENT_SECRET`: тогда смена client secret делает старые токены нечитаемыми и возвраты по старым платежам придётся делать в портале Grab |
| `GRABPAY_API_BASE` | переопределяет хост Grab (только тесты и стенды); в production только https |

Секреты в логи не попадают: в `last_error` и аудит пишутся только коды статусов и причин Grab. Ограничения Grab: не больше 50 запросов в секунду на `partner_id`, статус транзакции не чаще раза в 2 минуты (приложение это соблюдает), время сервера с точностью до 5 минут (иначе 401 на подпись). Деньги merchant-кошелька выводятся ежедневно, поэтому возврат может не пройти с `merchant_insufficient_balance`: такой возврат остаётся `failed` в `payment_refunds`, его надо повторить после пополнения или сделать в Grab Merchant Portal. Окно возврата 180 дней (TH) и 365 дней (SG, MY, PH).

Наблюдение: `SELECT status, count(*) FROM payments GROUP BY 1`; зависшие `unknown`, `authorized` и `refunding` сверяет фоновый шаг `reconcile_payments` (`reconcileOpenPayments`), возвраты в `pending` переотправляет шаг `retry_refunds`. Запись аудита `payment.captured_after_failure` означает, что Grab сообщил о списании по платежу, который мы уже закрыли: нужен ручной возврат.

## GrabExpress и поездки Grab (Live)

Выключено по умолчанию. При `GRAB_EXPRESS=off` и `GRAB_FAREFEED=off` режим Live недоступен, как раньше. Ключи выдаёт Grab: sandbox GrabExpress открыт любому проекту в Developer Portal (страна выбирается во вкладке конфигурации проекта), production выдаётся по странам и городам через Business PIC; scope `ride.estimate` для Farefeed выдаёт Grab по партнёрскому соглашению (см. `docs/grab-api-research.md`, разделы 1 и 2).

| Переменная | Значение |
|---|---|
| `GRAB_ENV` | `sandbox` (по умолчанию) или `production`. Express: `https://partner-api.grab.com/grab-express-sandbox` или `.../grab-express`, токен всегда `https://partner-api.grab.com/grabid/v1/oauth2/token`. Farefeed: `https://partner-api.stg-myteksi.com` в sandbox, `https://partner-api.grab.com` в production |
| `GRAB_CLIENT_ID`, `GRAB_CLIENT_SECRET` | OAuth 2.0 client (client credentials) из Developer Portal. Обязательны, если включена хотя бы одна возможность, иначе приложение не стартует. Секрет только из менеджера секретов, в логи не попадает |
| `GRAB_FAREFEED_CLIENT_ID`, `GRAB_FAREFEED_CLIENT_SECRET` | необязательно: отдельный клиент для Farefeed, если Grab выдаст его на staging-портале (по умолчанию берутся `GRAB_CLIENT_*`) |
| `GRAB_EXPRESS` | `on` или `off` (по умолчанию `off`; другое значение не даст приложению запуститься) |
| `GRAB_EXPRESS_SERVICE_TYPE` | `INSTANT` (по умолчанию), `SAME_DAY` или `BULK`, как в договоре |
| `GRAB_EXPRESS_VEHICLES` | типы машин через запятую, как в договоре (по умолчанию `BIKE,CAR,VAN`) |
| `GRAB_EXPRESS_PAYMENT` | `cash` (по умолчанию: `paymentMethod CASH`, `payer SENDER`, отправитель платит курьеру) или `cashless` (счёт выставляется Unyly, пользователь сначала платит через GrabPay). `cashless` при `GRAB_EXPRESS=on` требует `GRABPAY=on` и `GRABPAY_CURRENCY` той же валюты, что рынок `GRAB_EXPRESS_REGION`, иначе приложение не стартует |
| `GRAB_EXPRESS_REGION` | рынок аккаунта GrabExpress: `TH` (по умолчанию), `SG`, `MY`, `ID`, `VN`, `PH`, `KH`, `MM`. Задаёт ожидаемую валюту котировок (TH: THB); котировка в другой валюте не принимается |
| `GRAB_EXPRESS_WEBHOOK_AUTH` | длинный случайный секрет (не меньше 32 символов, `openssl rand -hex 32`), который Grab будет присылать в заголовке `Authorization`. Обязателен при `GRAB_EXPRESS=on` |
| `GRAB_EXPRESS_WEBHOOK_AUTH_ID` | необязательно: значение заголовка `Authorization-Id` |
| `GRAB_EXPRESS_UNKNOWN_CANCEL_AFTER_SEC` | сколько ждать webhook для создания с неизвестным исходом, прежде чем отменить по `merchantOrderID` (по умолчанию 600) |
| `GRAB_FAREFEED` | `on` или `off` (по умолчанию `off`): оценки поездок и deep link в приложение Grab |
| `GRAB_HTTP_TIMEOUT_MS` | таймаут одного запроса к Grab (по умолчанию 8000). `PROVIDER_TIMEOUT_MS` должен быть больше: свежая котировка и создание доставки делят его |
| `GRAB_RPS` | темп запросов на семейство API (по умолчанию 5 в sandbox, 30 в production) |
| `GRAB_API_BASE` | переопределяет хост Grab (тесты и стенды); только https, кроме http на localhost |

Webhook URL для Grab (передаётся GrabExpress Tech Support вместе с секретом для `Authorization`):

`https://unyly-food.unyly.org/webhooks/grab-express`

**Включение sandbox.**
1. В Developer Portal: проект, OAuth 2.0 client со scope `grab_express.partner_deliveries`, страна TH во вкладке конфигурации.
2. Задать `GRAB_ENV=sandbox`, `GRAB_CLIENT_ID`, `GRAB_CLIENT_SECRET`, `GRAB_EXPRESS_WEBHOOK_AUTH`, `GRAB_EXPRESS=on`, перезапустить. Ошибка конфигурации останавливает запуск с понятным сообщением.
3. Отправить Grab webhook URL и секрет для sandbox.
4. Включить новые заказы для Live: `node dist/cli.js kill-switch live on` (по умолчанию для Live выключено).
5. Тестовый пользователь выбирает режим Live в кабинете и добавляет два адреса с координатами («широта, долгота» из приложения карт), именем и телефоном контакта.
6. Прогнать сценарии: оценка, корзина, подтверждение, статусы до `COMPLETED`, отмена до забора, отказ отмены после забора, неверный секрет webhook (401), превышение веса, таймаут создания и сверка по webhook.

**Включение cashless (оплата GrabPay до создания доставки).** Порядок переключателей важен: деньги не должны начать списываться раньше, чем всё остальное готово.
1. Новые заказы Live на паузе: `node dist/cli.js kill-switch live off`.
2. GrabPay настроен и проверен отдельно (раздел «Оплата GrabPay»): `GRABPAY=on`, все `GRABPAY_*`, Redirect URL и Webhook URL зарегистрированы у Grab, `GRABPAY_CURRENCY` равна валюте `GRAB_EXPRESS_REGION` (THB для TH).
3. В договоре GrabExpress разрешён `CASHLESS` с `payer SENDER` (счёт выставляется Unyly).
4. `GRAB_EXPRESS=on`, `GRAB_EXPRESS_PAYMENT=cashless`, перезапуск. Неполная комбинация останавливает запуск с сообщением, какой переменной не хватает; перехода на наличные молча не бывает.
5. Применена миграция 015 (выполняется при старте).
6. На одном тестовом пользователе: подтверждение, оплата в Grab, доставка; отмена до забора с возвратом; отказ Grab при создании с возвратом.
7. `node dist/cli.js kill-switch live on`.

**Аварийное выключение cashless.** `kill-switch live off`: страница подтверждения не начинает оплату, а платежи, которые уже на странице Grab, не списываются (проверка перед `complete`). Если оплата уже прошла, а отправка не успела начаться, деньги возвращаются автоматически (`order_not_placed`). Доставки в пути, сверка, webhook, отмены и возвраты продолжают работать. Переключение `GRAB_EXPRESS_PAYMENT=cash` с перезапуском аннулирует неподтверждённые checkout с GrabPay (`PAYMENT_METHOD_CHANGED`), оплаченные, но не отправленные возвращаются. `GRABPAY=off` при `cashless` не допускается: сначала `cash` или `GRAB_EXPRESS=off`, а возвраты по старым платежам требуют действующих `GRABPAY_*`.

**Наблюдение за cashless.** `SELECT outcome, reason, count(*) FROM live_payment_settlements GROUP BY 1, 2`. Записи `support` (`cancelled_after_pickup`, `failed_after_pickup`, `refund_failed`, `order_found_after_refund`) и аудит `order.payment_needs_support` разбирает человек: автоматического возврата по ним нет. Захваченные платежи Live без записи в `live_payment_settlements` и без активной доставки старше 10 минут - алерт.

**Чек-лист перехода в production.**
- [ ] Все happy и unhappy пути пройдены в консоли разработчика Grab (требование Grab перед выдачей production-ключей)
- [ ] Production-ключи и доступ по нужным городам получены у Business PIC, тарифы согласованы
- [ ] Production webhook URL и новый секрет переданы GrabExpress Tech Support; секрет только в менеджере секретов
- [ ] `GRAB_ENV=production`, `GRAB_RPS` по лимитам договора, `GRAB_EXPRESS_VEHICLES` и `GRAB_EXPRESS_SERVICE_TYPE` как в договоре
- [ ] Выбран способ оплаты: `cash` или `cashless` вместе с GrabPay
- [ ] Алерты: `submission_attempts.status='unknown'` дольше 10 минут и `grab_deliveries` в `unknown` или `sending` дольше 15 минут
- [ ] Юридическое: оферта и PDPA для доставок (B6 в roadmap), отображение цен по правилам Grab
- [ ] `kill-switch live on` только после проверки на одном пользователе

**Наблюдение.** `SELECT state, count(*) FROM grab_deliveries GROUP BY 1`. Запись в `unknown` или `sending` без `delivery_id` старше 15 минут - дежурному: проверить в консоли Grab по `merchant_order_id`. Логи `grab_call` (операция, код ответа, `grab_request_id`) и `grab_express_unknown*`.

## Секреты

`.env` лежит на хосте с правами 600 и в git не попадает. Для production лучше Docker secrets или менеджер секретов. Когда появится Live: креды Grab хранить в KMS (так требует GrabID), не класть в файл конфигурации и не кэшировать во внешних кешах.

## Хранение данных

Очистка идёт в `jobs/worker.ts` (шаг `retention`), каждое правило отдельным запросом:

| Данные | Когда удаляются |
|---|---|
| `login_codes` | через 1 день после создания |
| `web_sessions` | после истечения (срок сессии 14 дней) |
| `oauth_codes` | через 1 час после истечения |
| `oauth_tokens` | через 1 день после истечения |
| `webauthn_challenges` | через 1 день после истечения (колонки `created_at` у таблицы нет) |
| `grab_auth_states` | через 1 день после истечения (запрос входа через Grab живёт 10 минут) |
| `provider_events` | обработанные, через 30 дней после обработки. Повторная доставка старого события безопасна: применяются только `sequence` больше `status_version` |
| `grab_webhook_events` | через 30 дней после получения (только `deliveryID`, `merchantOrderID`, статус, время, причина отказа) |
| `demo_sim_orders` | терминальные (`delivered`, `cancelled`) старше 30 дней, чьё последнее событие уже отправлено, если заказ с этим `provider_order_ref` (текстовая копия, не FK) тоже терминален и по нему нет открытой отмены |
| `oauth_clients` | зарегистрированные через DCR старше 30 дней, у которых нет ни одного grant |
| `personal_tokens` | отозванные или истёкшие больше 30 дней назад (до этого видны в кабинете и в экспорте, без значения токена) |
| гостевые аккаунты `/try` | через 24 часа, по 25 за проход |

Адреса хранятся до удаления; при удалении стираются название, улица, район, город, инструкции, координаты и контакт (остаётся только код страны). История не ломается: `cart_versions.address_id` ссылается с `ON DELETE SET NULL`, подтверждения хранят только отпечаток адреса, а заказы - свою копию `address_label`. Заказы хранятся, пока существует аккаунт. Удаление аккаунта каскадно удаляет данные и обезличивает `audit_log`.

Экспорт данных (`/app/data/export`, JSON) включает профиль, настройки, адреса, passkeys (префикс ID, даты создания и использования, без публичных ключей), подключения провайдеров, корзины с версиями (состав, маршрут), расчёты и подтверждения (суммы, статусы, даты), попытки отправки, заказы (сервис, метка адреса или маршрута), отмены, handoff, подключения ИИ, метаданные персональных токенов и журнал действий пользователя (действие, сущность, время). Сроки для PDPA Таиланда нужно утвердить с юристом до запуска Live.

## Фоновые задачи

Проход задач раз в 5 секунд из шагов: сверка отправок, тик демо-симулятора, отложенные webhook, сверка отмен, сверка платежей GrabPay (`reconcile_payments`), решение по оплаченным заказам Live (`settle_live_payments`: отправка оплаченного checkout, если запрос пользователя её не довёл, возвраты и записи для поддержки), повтор возвратов (`retry_refunds`), истечение подтверждений, очистка, удаление гостей. Шаги GrabPay пропускаются, если креды GrabPay не заданы. Каждый шаг выполняется под своим `pg_try_advisory_xact_lock(727275, <номер шага>)`: при нескольких экземплярах шаг в данный момент выполняет только один, остальные его пропускают. Блокировка на уровне транзакции работает и через transaction pooler. У каждого шага свой try/catch, а в циклах сверки, очистки и удаления гостей ошибка одной строки логируется и не останавливает остальные; отправка, сверка которой упала, откладывается (от 30 с до 30 мин по возрасту). `RUN_JOBS=false` отключает задачи на экземпляре.

## Оценка расходов

Все цифры - **предположения** для планирования, а не проверенные тарифы. Перед покупкой сверьте цены у провайдеров.

Допущения для беты: 100–300 пользователей, до 2 000 MCP-вызовов в день, база меньше 1 ГБ.

| Статья | Бета (оценка, $/мес) | Рост: ~10 тыс. пользователей (оценка) |
|---|---|---|
| VPS 2 vCPU / 4 ГБ (приложение + Postgres + Caddy) | ~10–25 | 2–3 экземпляра приложения + управляемый Postgres: ~100–250 |
| Хранилище для бэкапов | ~1–5 | ~5–20 |
| SMTP (транзакционные письма) | 0–15 (бесплатные лимиты) | ~20–50 |
| Мониторинг и логи | 0 (бесплатные тарифы) | ~30–100 |
| Домен и Cloudflare | уже есть | уже есть |
| **Итого** | **~15–45** | **~150–400** |

Основная переменная стоимость на росте - управляемый Postgres и логи. Сама модель ИИ Unyly ничего не стоит: её оплачивает клиент пользователя.
