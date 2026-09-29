# MCP-инструменты Unyly

Точные JSON Schema и аннотации всех инструментов лежат в [`mcp-tools.schema.json`](mcp-tools.schema.json). Файл генерируется командой `npx tsx scripts/dump-tools.ts`.

Это **внутренние инструменты Unyly**. Из их наличия не следует, что у Grab есть API с такими же операциями.

## Общие правила

- Транспорт: Streamable HTTP, `POST /mcp`, без сессий (stateless). `GET` и `DELETE` возвращают 405.
- Авторизация: `Authorization: Bearer <token>`. Без токена сервер отвечает 401 с `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
- Входные схемы **строгие** (`additionalProperties: false`), поэтому лишний аргумент вроде `confirmed: true` или `user_id` отклоняется.
- Пользователь определяется только по токену. Объекты другого пользователя возвращают `NOT_FOUND`, неотличимый от несуществующего объекта.
- Аннотации (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) - подсказки для клиента. Защита на них **не строится**: её обеспечивают scopes, проверка владельца и подтверждение на сайте.

### Ответ (envelope, `structuredContent`)

```json
{
  "ok": true,
  "tool": "quote_cart",
  "operation_id": "b3b0…",
  "mode": "demo",
  "data_as_of": "2026-09-30T03:40:12.000Z",
  "result": { "...": "..." },
  "next_actions": [{ "tool": "prepare_checkout", "why": "Create the confirmation page for the user" }],
  "notices": ["DEMO MODE: synthetic restaurants and orders. Nothing is delivered or charged. Always tell the user this is a demo."]
}
```
При ошибке: `isError: true`, `ok: false`, `error: { code, message, details?, user_action? }`.

## Инструменты

| Инструмент | Scope | Побочные эффекты | Аннотации |
|---|---|---|---|
| `get_capabilities` | orders:read | нет | readOnly |
| `search_restaurants` | orders:read | нет (читает провайдера) | readOnly, openWorld |
| `get_menu` | orders:read | нет | readOnly, openWorld |
| `create_cart` | orders:prepare | создаёт черновик корзины; `from_order_id` создаёт **новую** корзину для повтора заказа | - |
| `update_cart` | orders:prepare | меняет корзину (версия +1) и **аннулирует** ожидающие подтверждения | destructive |
| `quote_cart` | orders:prepare | сохраняет расчёт с TTL | openWorld |
| `prepare_checkout` | orders:prepare | создаёт одноразовое подтверждение и `confirm_url` | - |
| `get_checkout_status` | orders:read | нет | readOnly |
| `submit_order` | orders:submit | **необратимо**: отправляет заказ, если человек уже подтвердил его на сайте. Отправка выполняется не более одного раза на checkout | destructive, idempotent, openWorld |
| `get_order_status` | orders:read | может обновить статус у провайдера | readOnly, openWorld |
| `list_orders` | orders:read | нет | readOnly |
| `prepare_cancellation` | orders:cancel | запрашивает условия отмены у провайдера и создаёт страницу подтверждения | openWorld |
| `cancel_order` | orders:cancel | **необратимо**: выполняет отмену, если человек подтвердил её на сайте | destructive, idempotent, openWorld |
| `create_handoff` | orders:prepare | сохраняет список и ссылку. Заказ **не создаётся** | - |

## Доменные ошибки

| Код | Когда | Что делать ассистенту |
|---|---|---|
| `AUTH_REQUIRED` | токен недействителен или аккаунт удалён | переподключить |
| `INSUFFICIENT_SCOPE` | пользователь не выдал нужное право | попросить переподключить с этим правом |
| `NOT_FOUND` | объекта нет или он чужой | - |
| `VALIDATION_FAILED` | неверные аргументы | исправить |
| `CAPABILITY_UNAVAILABLE` | функция недоступна в текущем режиме; `details.reason` и `details.source` | `get_capabilities` |
| `ADDRESS_REQUIRED` / `ADDRESS_AMBIGUOUS` | нет адреса / адрес неполный | дать пользователю ссылку из `user_action` |
| `DELIVERY_UNAVAILABLE`, `RESTAURANT_CLOSED`, `OUT_OF_STOCK`, `MODIFIERS_INVALID`, `MINIMUM_ORDER_NOT_MET`, `ITEM_NOT_FOUND` | проблемы меню и корзины (у `MODIFIERS_INVALID` в `details.required_groups` перечислены обязательные группы) | изменить корзину |
| `CART_VERSION_CONFLICT` | `expected_version` устарела; `details.current_version` | перечитать и повторить |
| `CART_EMPTY`, `CART_NOT_OPEN` | - | - |
| `QUOTE_EXPIRED`, `PRICE_CHANGED` | расчёт устарел или цена изменилась | `quote_cart`, затем новое подтверждение |
| `CONFIRMATION_REQUIRED` | человек ещё не подтвердил; `details.confirm_url` | отправить ссылку, потом `get_checkout_status` |
| `CONFIRMATION_EXPIRED`, `CONFIRMATION_INVALIDATED` | подтверждение истекло или стало недействительным (`details.reason`) | пересчитать |
| `SUBMISSIONS_PAUSED` | включён выключатель новых заказов | сообщить пользователю |
| `PROVIDER_UNAVAILABLE` | провайдер недоступен; демо-данные **не** подставляются | повторить позже |
| `PROVIDER_REJECTED` | провайдер отказал | - |
| `SUBMISSION_UNKNOWN` | исход отправки неизвестен, идёт сверка | **не** отправлять заказ повторно; проверять `get_checkout_status` |
| `CANCELLATION_NOT_ALLOWED`, `CANCELLATION_UNKNOWN` | - | - |
| `RATE_LIMITED`, `INTERNAL` | - | - |

## Пример сценария (Demo)

```text
get_capabilities → mode=demo
search_restaurants {party_size:2, budget_total_major:600, exclude_allergens:["peanut","tree_nut"], limit:3}
create_cart {restaurant_id:"demo-r3", items:[{item_id:"r3-wonton",quantity:1},{item_id:"r3-crispypork",quantity:1}]}
quote_cart {cart_id} → total THB 250.00, expires_at
prepare_checkout {cart_id, quote_id} → confirm_url=https://unyly.org/confirm/<id>
   … пользователь открывает ссылку, проверяет и нажимает «Подтвердить и оформить» …
get_checkout_status {checkout_id} → status=consumed, submission.accepted, order_id
get_order_status {order_id} → fulfillment=accepted, payment=not_charged_demo
```
Если ассистент вызовет `submit_order` до подтверждения, он получит `CONFIRMATION_REQUIRED`. Вызов после подтверждения - безопасный повтор, возвращающий тот же результат.
