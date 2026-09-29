# Тесты и что они доказывают

Запуск: `npm test` (нужен PostgreSQL; адрес в `TEST_DATABASE_URL`, по умолчанию `postgres://postgres@localhost:5432/unyly_test`). Каждый файл пересоздаёт схему.

Тесты поднимают настоящий HTTP-сервер и ходят в него **официальным MCP SDK Client** через Streamable HTTP. Токен получают через реальный OAuth-поток: DCR → consent с веб-сессией → PKCE → token. Подтверждение выполняется POST-запросом со страницы с CSRF-токеном, как это делает человек.

## Какой провайдер используется

| Уровень | Что | Статус |
|---|---|---|
| Симулятор | `DemoProvider`: синтетический каталог, идемпотентность по ключу, подписанные webhook, прогрессия статусов по часам, инъекция сбоев | **Все автотесты** |
| Sandbox | Grab sandbox (GrabFood POS / GrabExpress) | **Не используется**: нет партнёрского доступа, а эти API не покрывают потребительские заказы |
| Реальный провайдер | Grab Live | **Не используется** |

**Зелёные тесты на симуляторе не означают, что реальные заказы Grab доступны.** Контрактных тестов Live-адаптера нет: документации для потребительских заказов не существует, и писать тесты по выдуманному контракту нельзя.

## Покрытие требований ТЗ (раздел 12)

| Требование | Тест |
|---|---|
| Успешный заказ в Demo | `demo-flow`: «order: cart → quote → checkout → user confirms…» (включая доставку через подписанные webhook) |
| Истечение цены | `safety`: «quote expiry blocks prepare_checkout», «approved confirmation expires before submit» |
| Изменение корзины/адреса/цены после подтверждения | `safety`: «cart change after approval…», «page shows invalidation…», «price change at the provider…», «deleting the cart address…» |
| Невозможность оформить без подтверждения | `safety`: «submit_order without human confirmation…», CSRF, сумма, которую видел человек |
| Повторное и параллельное выполнение | `safety`: «parallel submit_order calls + double web click» (6 вызовов MCP + 2 клика → 1 заказ) |
| Таймаут после принятия провайдером | `resilience`: «timeout after the provider accepted», «…SUBMISSION_UNKNOWN, then resolved by the background job» |
| Восстановление после перезапуска | `resilience`: «crash after provider accepted: a restarted instance reconciles», «crash before the provider received it» |
| Повторные и запоздалые webhook | `resilience`: «deduplicates repeats and ignores late events», подписи, раннее событие |
| Чтение и изменение чужого заказа | `access`: «Bob cannot read or change…», «…open or confirm Alice's pages», инъекция `user_id` |
| Отзыв доступа | `access`: «revoking access in the dashboard…», ротация refresh, повтор кода, удаление аккаунта |
| Отмена с возможным сбором | `orders-edge`: «free before preparation; fee after…», «cannot cancel once picked up» |
| Недоступность провайдера без подмены демоданными | `resilience`: «provider definitely unavailable…», «status read with provider down…» |
| Обход подтверждения текстом из меню | `safety`: «menu text that tries to instruct the assistant…» |
| Прочее | модификаторы, наличие, минимальная сумма, закрытый ресторан, зона доставки, неоднозначный адрес, сборы и скидки, Handoff, недоступность Live, scopes, audience, SSRF в CIMD, деньги |

Итог последнего прогона: **5 файлов, 52 теста, все прошли** (см. README → «Проверки»).

## Ручные и полуавтоматические проверки (30.09.2026)

- `scripts/mcp-e2e.ts` на запущенном сервере: discovery через `WWW-Authenticate` → PRM → AS metadata → DCR → PKCE → 14 инструментов → заказ → статус. **Пройдено.**
- **MCP Inspector 2.8.0 (CLI):** `tools/list` и `tools/call get_capabilities` с Bearer-токеном. **Пройдено.**
- **Мобильный экран (Playwright + Chromium, 390×844, touch):** главная, вход, кабинет, режим, адреса, предпочтения, подключение, подтверждение, заказ, английская версия, тёмная тема. Горизонтальной прокрутки нет, ошибок в консоли нет, первый Tab попадает на «К содержанию». **Пройдено.** Проверка нашла реальный баг: `Referrer-Policy: no-referrer` заставлял браузер слать `Origin: null`, и CSRF-проверка блокировала формы. Исправлено.
- Production-сборка (`npm run build`, `node dist/main.js` с `NODE_ENV=production`): `/readyz`, PRM, HSTS и CSP. Защита от запуска с dev-настройками срабатывает. **Пройдено.**
- `deploy/Caddyfile`: `caddy validate` (Caddy 2.10.2) - **Valid configuration.**
- Бэкап и восстановление: `scripts/backup-verify.sh` - **пройдено.**
- **Не выполнено:** `docker build` (в среде разработки не было Docker daemon; сборка стоит в CI), подключение из Claude.ai, ChatGPT и Claude Code (нужен публичный https-адрес).
