# Подключение ИИ-клиентов

Адрес MCP в production: `https://<MCP host>/mcp` (см. `MCP_RESOURCE_URL`), локально - `http://localhost:3000/mcp`.
Транспорт: Streamable HTTP, JSON-ответы, без сессий. Авторизация: OAuth 2.1 + PKCE S256.
Клиенты находят сервер авторизации сами через `WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`.
Регистрация: Dynamic Client Registration (`/oauth/register`) или Client ID Metadata Document (`client_id` в виде https-URL).

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

## Пошаговые инструкции

### Claude Code
```bash
claude mcp add --transport http unyly https://<MCP host>/mcp
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
    "server_url": "https://<MCP host>/mcp",
    "authorization": "<access_token из OAuth-потока Unyly>",
    "require_approval": { "always": { "tool_names": ["submit_order", "cancel_order"] } }
  }]
}
```
Приложение должно само пройти OAuth-поток Unyly (DCR → authorize → token) и обновлять токен (access живёт 1 час).

### Локальная проверка любым клиентом
```bash
npm run dev                     # сервер на :3000 с DEV_ECHO_LOGIN_CODE=true
BASE_URL=http://localhost:3000 npm run e2e:mcp   # в конце печатает Bearer-токен
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/list
```

## REST/OpenAPI-мост

В MVP он **не нужен**: все целевые клиенты поддерживают удалённый MCP. Если появится клиент только с OpenAPI (например, GPT Actions), мост делается тонким адаптером: Fastify-маршруты `/api/v1/*` вызывают те же функции `services/*` с тем же Bearer-токеном и scopes.
