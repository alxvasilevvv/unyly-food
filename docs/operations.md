# Размещение и эксплуатация

## Что обнаружено при проверке инфраструктуры (30.09.2026, только чтение)

- **`unyly.org` уже занят действующим продуктом**: там работает «Unyly: MCP Server Marketplace» (каталог MCP-серверов, тарифы Pro/Team). DNS обслуживает Cloudflare (IPv6 `2606:4700:…`).
- **`mcp.unyly.org` тоже резолвится в Cloudflare** и отвечает 404. Похоже на wildcard-запись или хостинг MCP этого маркетплейса.
- В подключённом аккаунте Vercel нет ни доменов, ни команд.
- Я **ничего не менял**: ни DNS, ни хостинг.

**Вывод.** Схема из ТЗ (`unyly.org` - сайт, `mcp.unyly.org/mcp` - MCP) заменила бы действующий сайт. Код от доменов не зависит: всё задаётся через `WEB_ORIGIN` и `MCP_RESOURCE_URL`. Решение за владельцем домена. Варианты:
1. `food.unyly.org` (сайт и OAuth) + `food.unyly.org/mcp` (MCP) - одна новая DNS-запись, конфликтов нет. **Рекомендую.**
2. `food.unyly.org` + `mcp-food.unyly.org/mcp`.
3. Схема из ТЗ, если маркетплейс переезжает.


## Основной вариант: Unyly Deploy (food.unyly.org)

Проверено 30.09.2026: `unyly.org` — собственная платформа владельца. Unyly Deploy (deploy.unyly.org) собирает GitHub-репозиторий по его `Dockerfile` и публикует на `slug.unyly.org`, пуш в ветку пересобирает проект. Поэтому отдельный VPS, Caddy и DNS-записи не нужны: TLS и домен даёт платформа.

1. Репозиторий `alxvasilevvv/unyly-food` (приватный), ветка `main`.
2. Проект в Unyly Deploy со slug `food`, runtime Docker (собственный Dockerfile, порт 3000).
3. База: схема `unyly` и роль `unyly_app` в Supabase (`deploy/supabase-setup.sql`); приложение подключается через transaction pooler.
4. Переменные окружения (секреты задаются в консоли Unyly Deploy):

| Переменная | Значение |
|---|---|
| `NODE_ENV` | `production` |
| `WEB_ORIGIN` | `https://food.unyly.org` |
| `MCP_RESOURCE_URL` | `https://food.unyly.org/mcp` |
| `DATABASE_URL` | `postgresql://unyly_app.<ref>:<password>@<pooler-host>:6543/postgres` |
| `DATABASE_POOLER` | `transaction` |
| `DATABASE_SSL` | `no-verify` (или `DATABASE_SSL_CA` с сертификатом Supabase для полной проверки) |
| `DATABASE_POOL_MAX` | `5` |
| `DEMO_WEBHOOK_SECRET` | случайные 32 байта |
| `MAIL_MODE` | `disabled` (вход по passkey), или `smtp` + `SMTP_URL` |
| `DEV_ECHO_LOGIN_CODE` | `false` |
| `TRUST_PROXY` | `true` |
| `SUPPORT_EMAIL` | адрес поддержки |

Операции внутри контейнера: `node dist/cli.js kill-switch demo off`, `node dist/cli.js issue-login-code user@example.com` (восстановление доступа без почты), `node dist/cli.js migrate`.

**Вход без почтового сервиса.** Основной вход — passkey (WebAuthn: Face ID, Touch ID, Windows Hello, ключи безопасности). Коды на email включаются через `MAIL_MODE=smtp`. Без SMTP поддержка выдаёт одноразовый код командой `issue-login-code`, пользователь вводит его на `/login/code` и добавляет новый passkey.

## Окружения

| | staging | production |
|---|---|---|
| Хосты (пример) | `staging-food.unyly.org` | `food.unyly.org` |
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
Миграции применяются при старте: они идемпотентны и защищены advisory lock, так что параллельный запуск нескольких экземпляров безопасен.

**HTTPS и reverse proxy.** Caddy выпускает сертификаты сам, как только DNS указывает на хост. Если прокси Cloudflare включён (оранжевое облако), поставьте режим SSL «Full (strict)». Streaming и таймауты: `flush_interval -1`, `response_header_timeout 35s`; таймаут провайдера в приложении 10 с, Fastify `requestTimeout` 30 с.

**Health:** `/healthz` (процесс жив), `/readyz` (БД доступна, миграции применены; 503 иначе). Используются в Docker `HEALTHCHECK`.

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
  - production: `docker compose exec db psql -U unyly -c "UPDATE settings SET value = jsonb_set(value,'{demo}','false') WHERE key='submissions'"`

## Бэкапы

`scripts/backup-verify.sh` делает `pg_dump` (custom format), восстанавливает его во временную БД и сверяет количество строк в ключевых таблицах. Ставится в cron раз в сутки, дампы нужно уносить за пределы хоста (S3/B2). Скрипт проверен локально 30.09.2026: дамп 60 КБ, восстановление прошло, количества строк совпали.

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

Готовые запросы для дашборда лежат в `docs/metrics.sql`. Для алертов подойдёт Grafana Cloud или Better Stack поверх логов, либо cron с `psql` и отправкой в Telegram.

## Секреты

`.env` лежит на хосте с правами 600 и в git не попадает. Для production лучше Docker secrets или менеджер секретов. Когда появится Live: креды Grab хранить в KMS (так требует GrabID), не класть в файл конфигурации и не кэшировать во внешних кешах.

## Хранение данных

Коды входа удаляются через 1 день, сессии через 14 дней, токены через сутки после истечения (очистка в `jobs/worker.ts`). Адреса хранятся до удаления, при удалении текст стирается. Заказы хранятся, пока существует аккаунт. Удаление аккаунта каскадно удаляет данные и обезличивает `audit_log`. Сроки для PDPA Таиланда нужно утвердить с юристом до запуска Live.

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

## Чего не хватает для публикации

1. Решение по хостам (см. выше) и доступ к DNS в Cloudflare для одной записи.
2. Сервер (VPS) или облачный аккаунт с Docker.
3. SMTP-креды для отправки кодов входа.
4. `DEMO_WEBHOOK_SECRET`, `POSTGRES_PASSWORD` (сгенерировать на хосте).
5. Адрес поддержки (`SUPPORT_EMAIL`).

**Сервис не опубликован.** Всё проверено локально (см. testing.md).
