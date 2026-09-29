# Unyly

Заказ еды через ИИ-ассистентов: удалённый MCP-сервер + веб-кабинет с обязательным подтверждением заказа человеком.

> **Статус (30.09.2026).** Demo - полностью работает. Handoff (список + официальная ссылка GrabFood TH) - работает. **Live-заказы Grab - недоступны**: публичного API для заказа от имени покупателя у Grab нет ([docs/feasibility.md](docs/feasibility.md)). Сервис **не опубликован**.

## Быстрый старт (локально)

Нужны Node.js ≥ 22 (рекомендуется 24 LTS) и PostgreSQL ≥ 15.

```bash
npm ci
createdb unyly && createdb unyly_test         # или: docker compose up -d db
cp .env.example .env
# для локальной разработки в .env достаточно:
#   NODE_ENV=development
#   DATABASE_URL=postgres://postgres@localhost:5432/unyly
#   WEB_ORIGIN=http://localhost:3000
#   MCP_RESOURCE_URL=http://localhost:3000/mcp
#   MAIL_MODE=console
#   DEV_ECHO_LOGIN_CODE=true
#   DEMO_TIME_SCALE=20   # демо-доставка в 20 раз быстрее
npm run dev
```

Откройте http://localhost:3000 → «Войти» (код входа показывается прямо на странице в dev-режиме) → «Регион и режим» → «Адреса» → «Подключение».

Вариант целиком в Docker: `docker compose up --build db app` (без TLS, порт 3000).

### Проверить весь путь одной командой
```bash
BASE_URL=http://localhost:3000 npm run e2e:mcp
```
Скрипт проходит OAuth-discovery, регистрацию клиента, PKCE и весь сценарий через MCP, подтверждает заказ как человек на странице и печатает Bearer-токен для MCP Inspector:
```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/list
```
`E2E_STOP_BEFORE_CONFIRM=1` останавливает скрипт перед подтверждением и печатает ссылку, чтобы подтвердить заказ руками в браузере.

### Подключить ассистента
- Claude Code: `claude mcp add --transport http unyly http://localhost:3000/mcp`, затем `/mcp`.
- Остальные клиенты: [docs/clients.md](docs/clients.md) (им нужен публичный https-адрес).

## Тесты
```bash
npm test          # 59 тестов: MCP через официальный SDK, OAuth, веб-подтверждение, сбои, гонки
npm run typecheck
```

## Проверки, выполненные при сдаче
- `npm test`: 6 файлов, 59 тестов, все прошли (включая регрессионные тесты по итогам независимого ревью).
- `npm run e2e:mcp` на запущенном сервере - пройден; MCP Inspector 2.8.0 CLI - `tools/list`, `tools/call` работают.
- Мобильный путь в Chromium 390×844 без горизонтальной прокрутки и ошибок консоли; клавиатурная навигация.
- Production-сборка стартует, `/readyz` = ready; `caddy validate` - ok; бэкап и восстановление - ok.
- Не выполнено: `docker build` (нет Docker daemon в среде; шаг есть в CI), ручное подключение Claude.ai, ChatGPT и Claude Code.

Подробности: [docs/testing.md](docs/testing.md).

## Документация
| Документ | О чём |
|---|---|
| [product.md](docs/product.md) | Продукт, сценарий, монетизация, метрики |
| [feasibility.md](docs/feasibility.md) | Что реально можно сделать с Grab (с источниками и датами) |
| [architecture.md](docs/architecture.md) | Компоненты, сущности, машины состояний, решения |
| [mcp-tools.md](docs/mcp-tools.md) + [schema](docs/mcp-tools.schema.json) | Инструменты, scopes, ошибки, примеры |
| [threat-model.md](docs/threat-model.md) | Угрозы и меры, со ссылками на тесты |
| [clients.md](docs/clients.md) | Подключение ChatGPT, Claude, Claude Code, API |
| [operations.md](docs/operations.md) | Размещение, откат, бэкапы, мониторинг, расходы, **конфликт домена** |
| [testing.md](docs/testing.md) | Что проверено и на чём (симулятор / sandbox / real) |
| [roadmap.md](docs/roadmap.md) | Блокеры запуска и план следующей версии |
| [grab-partner-request.md](docs/grab-partner-request.md) | Черновик обращения в Grab (не отправлен) |
| [metrics.sql](docs/metrics.sql) | SQL продуктовых и операционных метрик |

## Структура
```
src/            приложение (см. docs/architecture.md)
test/           интеграционные тесты (vitest + реальный Postgres)
scripts/        e2e, дамп схем инструментов, выключатель заказов, бэкап
deploy/         Caddyfile
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## Режимы
| | Demo | Handoff | Live |
|---|---|---|---|
| Поиск и меню | синтетические | ✗ (нет лицензированного источника) | ✗ |
| Корзина | по меню | свободный текст | ✗ |
| Расчёт | точный, со сборами | ✗ (цены только в Grab) | ✗ |
| Подтверждение и отправка | страница Unyly → симулятор | ✗ (заказ в Grab) | ✗ |
| Статус и отмена | да, с webhook | ✗ | ✗ |
| Ссылка в Grab | ✗ | https://food.grab.com/th/en/ | ✗ |
