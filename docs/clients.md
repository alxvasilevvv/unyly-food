# Подключение ИИ-клиентов

Адрес MCP в production: `https://unyly-food.unyly.org/mcp` (см. `MCP_RESOURCE_URL`), локально - `http://localhost:3000/mcp`.
Транспорт: Streamable HTTP, JSON-ответы, без сессий. Авторизация: OAuth 2.1 + PKCE S256 или персональный токен.
Клиенты находят сервер авторизации сами через `WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`.
Регистрация: Dynamic Client Registration (`/oauth/register`) или Client ID Metadata Document (`client_id` в виде https-URL).

Совместимость с разными клиентами:
- **`offline_access`** объявлен в `scopes_supported` и принимается. Если клиент просит только `offline_access` (и/или `openid`) или не передаёт scope, на странице согласия предлагаются все scopes Unyly, и пользователь может снять лишние. Refresh-токен выдаётся в любом случае.
- **Loopback redirect** (`http://localhost`, `127.0.0.1`, `[::1]`) совпадает при любом порту (RFC 8252, 7.3); путь и query должны совпадать. Остальные redirect URI сравниваются точно.
- **Персональные токены** для клиентов, которые умеют только Bearer: создаются на `/app/connections` (раздел «Токены»), префикс `unyly_pat_`, выбранные scopes, срок 30, 90 или 365 дней, до 10 активных. Токен показывается один раз, в базе хранится только хэш, отзыв в том же разделе. Принимается только в заголовке `Authorization: Bearer`, в query-строке никогда. Гостевые аккаунты `/try` токены создавать не могут.

Поддержка протокола в API не означает, что подключение доступно в потребительском приложении. Ограничения зависят от клиента, тарифа, политики рабочего пространства и модели.

## Таблица совместимости (30.09.2026)

| Клиент | Способ подключения | Авторизация | Подтверждение действий | Статус |
|---|---|---|---|---|
| **Универсальный MCP-клиент** (официальный SDK) | Streamable HTTP, `POST /mcp` | OAuth discovery → DCR → PKCE | Обязательное подтверждение на странице Unyly | **Проверено**: автотесты (`test/*.test.ts`, SDK Client 1.31) и `scripts/mcp-e2e.ts` на запущенном сервере |
| **MCP Inspector** 2.8.0 (CLI) | `npx @modelcontextprotocol/inspector --cli <url> --transport http --header "Authorization: Bearer <token>" --method tools/list` | Bearer из `npm run e2e:mcp` | - | **Проверено**: `tools/list` и `tools/call get_capabilities` |
| **Claude Code** | `claude mcp add --transport http unyly <url>`, затем `/mcp` → вход в браузере | OAuth в браузере; токены хранит и обновляет Claude Code | Запросы разрешений Claude Code + страница Unyly | **Не проверено вручную** (нужен публичный https-адрес). Команда взята из code.claude.com/docs/en/mcp |
| **Claude (claude.ai, Desktop, mobile)** | Custom connector по URL. Тарифы Pro/Max/Team/Enterprise; на Team/Enterprise коннектор добавляет владелец | OAuth; есть поля OAuth Client ID/Secret (для Unyly не нужны, работает DCR/CIMD) | Разрешения на инструменты в Claude + страница Unyly | **Не проверено вручную**. Источник: support.claude.com, статья 11175166 |
| **Anthropic Messages API** (MCP connector) | beta-заголовок `mcp-client-2025-11-20`; `mcp_servers: [{type:"url", url, name, authorization_token}]` + `tools: [{type:"mcp_toolset", mcp_server_name}]` | OAuth выполняет разработчик и передаёт `authorization_token` | Механизма подтверждения в API нет, поэтому страница Unyly обязательна | **Не проверено вручную**. Источник: platform.claude.com/docs/en/agents-and-tools/mcp-connector |
| **OpenAI Responses API** | `tools: [{type:"mcp", server_label:"unyly", server_url, authorization, require_approval}]` | Токен Unyly передаётся в `authorization` при каждом запросе | `mcp_approval_request` / `mcp_approval_response`. Рекомендуется `require_approval: {always: {tool_names: ["submit_order","cancel_order"]}}`, плюс страница Unyly | **Не проверено вручную**. Источник: developers.openai.com/api/docs/guides/tools-connectors-mcp |
| **ChatGPT** (Developer mode / Apps) | Developer mode, затем приложение с URL сервера. Тарифы Plus/Pro/Business/Enterprise/Education (web); доступность зависит от политики аккаунта | OAuth: CIMD предпочтителен, DCR поддерживается, PKCE S256. Redirect на `chatgpt.com/connector/oauth/...` (https, принимается) | ChatGPT по умолчанию подтверждает write-действия + страница Unyly | **Не проверено вручную**. Источник: developers.openai.com/api/docs/guides/developer-mode, /apps-sdk |

## Десять популярных ассистентов (страница `/connect`, 30.09.2026)

Статусы взяты из документации платформ, **вручную не проверены** ни для одного клиента. Список и формулировки в коде: `ASSISTANTS` в `src/web/routes.ts`.

| Ассистент | Где | Способ | Замечание |
|---|---|---|---|
| ChatGPT | веб, Developer mode | OAuth | действия записи доступны не на всех тарифах |
| Claude | claude.ai, Desktop, mobile | OAuth | на бесплатном тарифе один свой коннектор; на Team/Enterprise добавляет владелец |
| Gemini | Gemini Enterprise, Gemini CLI | OAuth | потребительское приложение подключает MCP не во всех странах |
| Microsoft Copilot | Copilot Studio | OAuth или токен | потребительское приложение Copilot свои MCP-серверы не подключает |
| Perplexity | Connectors | OAuth или токен | - |
| Grok | Connectors | OAuth | если тариф позволяет свои коннекторы |
| Mistral Le Chat | Connectors, все тарифы | OAuth или токен | - |
| DeepSeek | через MCP-клиент | токен | приложение DeepSeek MCP не подключает; модель DeepSeek в MCP-клиенте |
| Qwen | Qwen-Agent и MCP-клиенты | токен | Bearer с персональным токеном |
| Meta AI | приложение Meta AI | пока без MCP | модели Llama можно использовать через MCP-клиент с токеном |

## Пошаговые инструкции

### Claude Code
```bash
claude mcp add --transport http unyly https://unyly-food.unyly.org/mcp
# в сессии Claude Code:
/mcp   # выберите unyly → Authenticate → войдите в Unyly → Разрешить
```

### OpenAI Responses API (пример)
```json
{
  "model": "<ваша модель>",
  "input": "Найди ужин на двоих до 600 бат, без орехов",
  "tools": [{
    "type": "mcp",
    "server_label": "unyly",
    "server_url": "https://unyly-food.unyly.org/mcp",
    "authorization": "<access_token из OAuth-потока Unyly или персональный токен unyly_pat_…>",
    "require_approval": { "always": { "tool_names": ["submit_order", "cancel_order"] } }
  }]
}
```
Приложение либо само проходит OAuth-поток Unyly (DCR → authorize → token) и обновляет токен (access живёт 1 час), либо использует персональный токен.

### Любой MCP-клиент с Bearer
```json
{"mcpServers":{"unyly":{"url":"https://unyly-food.unyly.org/mcp","headers":{"Authorization":"Bearer unyly_pat_…"}}}}
```

### Локальная проверка любым клиентом
```bash
npm run dev                     # сервер на :3000 с DEV_ECHO_LOGIN_CODE=true
BASE_URL=http://localhost:3000 npm run e2e:mcp   # в конце печатает Bearer-токен
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/list
```
Вместо токена из e2e можно взять персональный токен из `/app/connections`.

## REST/OpenAPI-мост

В MVP он **не нужен**: целевые клиенты поддерживают удалённый MCP напрямую или через MCP-клиент с персональным токеном. Если появится клиент только с OpenAPI (например, GPT Actions), мост делается тонким адаптером: Fastify-маршруты `/api/v1/*` вызывают те же функции `services/*` с тем же Bearer-токеном и scopes.
