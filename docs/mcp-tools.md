# MCP-инструменты Unyly

Точные JSON Schema и аннотации всех инструментов, список промптов и `serverInfo` лежат в [`mcp-tools.schema.json`](mcp-tools.schema.json). Файл генерируется командой `npx tsx scripts/dump-tools.ts`.

Это **внутренние инструменты Unyly**. Из их наличия не следует, что у Grab есть API с такими же операциями.

15 инструментов покрывают четыре сервиса одним сценарием: `food` и `mart` (магазины: `supermarket`, `convenience`, `flowers`, `pharmacy`, `cakes`) ищутся через `search_stores`, `ride` и `express` оцениваются через `estimate_trip`. Корзина принадлежит одному магазину или одной поездке. Инструкции сервера (`SERVER_INSTRUCTIONS` в `src/mcp/tools.ts`) описывают этот путь для модели и лежат в поле `instructions` файла схем.

## Общие правила

- Транспорт: Streamable HTTP, `POST /mcp`, без сессий (stateless). `GET` и `DELETE` возвращают 405.
- Авторизация: `Authorization: Bearer <token>`. Без токена сервер отвечает 401 с `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
- Входные схемы **строгие** (`additionalProperties: false`), поэтому лишний аргумент вроде `confirmed: true` или `user_id` отклоняется.
- Пользователь определяется только по токену. Объекты другого пользователя возвращают `NOT_FOUND`, неотличимый от несуществующего объекта.
- У каждого инструмента есть `title` и явные `readOnlyHint`, `destructiveHint`, `openWorldHint` (у изменяющих ещё `idempotentHint`). Аннотации - подсказки для клиента. Защита на них **не строится**: её обеспечивают scopes, проверка владельца и подтверждение на сайте.

- `null` в необязательном аргументе равен его отсутствию (сервер убирает ключи со значением `null` до проверки схемы, на любой глубине). Неизвестные ключи по-прежнему отклоняются.
- `outputSchema` у инструментов нет: все отвечают одним и тем же envelope в `structuredContent` (ниже). Общая схема на 13 КБ с union-типом ломала часть клиентов.

### Ответ (envelope, `structuredContent`)

```json
{
  "ok": true,
  "mode": "demo",
  "data_as_of": "2026-09-30T03:40:12.000Z",
  "result": { "...": "..." },
  "next_actions": [{ "tool": "get_checkout_status", "why": "Once the user says they confirmed on confirm_url" }],
  "notices": ["DEMO MODE: synthetic stores, fares and orders. Nothing is delivered, driven or charged. Always tell the user this is a demo."]
}
```
`mode` и `data_as_of` есть только в envelope, в `result` они не повторяются. Поля `tool` нет. `operation_id` пишется в серверный лог (`{"evt":"mcp_call","op":…}`) и попадает в ответ **только при ошибке**, чтобы пользователь мог назвать его поддержке.

При ошибке: `isError: true`, `ok: false`, `operation_id`, `error: { code, message, details?, user_action? }`, `next_actions`. `user_action` говорит ассистенту, что сделать или о чём спросить пользователя. У `INSUFFICIENT_SCOPE` результат дополнительно содержит `_meta["mcp/www_authenticate"]` с вызовом `Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="<выданные + нужный>"` (формат OpenAI Apps SDK), чтобы клиент мог запросить недостающее право. Для OAuth-токенов HTTP-слой отвечает 403 с тем же заголовком ещё до вызова инструмента; внутри инструмента эта ошибка остаётся для персональных токенов.

### Короткий путь

`create_cart` (и `update_cart`) по умолчанию (`checkout: true`) сразу считают корзину и, если ничто не блокирует заказ, создают одноразовое подтверждение. В одном результате приходят корзина, полный расчёт `quote` (строки, сборы, скидка, итог, ETA, `issues`) и `checkout` (`checkout_id`, `confirm_url`, `expires_at`, `total`). Если расчёт заблокирован, `checkout: null`, причины в `quote.issues`, а если расчёт вообще не получился (нет адреса, выключатель заказов), корзина всё равно сохранена и причина лежит в `checkout_blocked { code, message, user_action }`. `checkout: false` оставляет старое поведение (только черновик, дальше `quote_cart` и `prepare_checkout`). Значение по умолчанию `true` выбрано потому, что подтверждение само по себе ничего не заказывает, а лишний шаг ассистенты часто пропускали или путали.

- Такси: `estimate_trip → create_cart → get_checkout_status`.
- Цветы и еда: `search_stores → create_cart → get_checkout_status`.
- Handoff: `create_cart` сразу возвращает ссылку Grab и чек-лист в `result.handoff` (`handoff: true` по умолчанию в режиме Handoff; `handoff: true` в Demo даёт `CAPABILITY_UNAVAILABLE`).

Нажатие «Подтвердить» на странице Unyly **сразу оформляет заказ** (веб-обработчик вызывает `approveCheckout`, затем `submitOrder`). Поэтому после слов пользователя «подтвердил» ассистенту достаточно одного `get_checkout_status` (в ответе есть `summary` одной фразой). `submit_order` нужен, только если статус `approved` и `submission` пустой (например, заказы были на паузе в момент подтверждения).

### Подтверждение и цена

- Подтверждение живёт до 15 минут (`CHECKOUT_MAX_TTL_MS`) независимо от срока расчёта провайдера (в Demo 5 минут).
- Если в момент нажатия расчёт старше своего срока, `approveCheckout` заново считает у провайдера **ту же версию корзины** (товары, адрес или поездка). Итог тот же и нет блокирующих проблем: заказ идёт дальше (в аудите `checkout.approved {repriced:true}`). Итог другой или появилась проблема: подтверждение аннулируется с причиной `PRICE_CHANGED`, ничего не заказывается.
- **Step-up для крупных сумм.** `checkout.step_up_required` (в `create_cart`, `update_cart`, `prepare_checkout`) и `step_up_required` в `get_checkout_status` равны `true`, если итог не меньше порога валюты и у пользователя есть passkey. Тогда «Подтвердить» на странице попросит passkey; ассистенту стоит заранее сказать об этом пользователю. Без подписи страница отвечает 403 и ничего не заказывается; через MCP этот шаг не обходится.
- `refreshCheckout(ctx, userId, checkoutId)` в `src/services/checkout.ts` для кнопки «обновить цену» на странице: пересчитывает ту же версию корзины и создаёт новое подтверждение (старое становится `SUPERSEDED`), возвращает `{ checkout_id, confirm_url, total_minor, previous_total_minor, currency, price_changed, expires_at }`. Разрешено для `awaiting_user`, `expired`, `invalidated` с причиной `EXPIRED`/`PRICE_CHANGED` и для `consumed`, если провайдер явно отказал (не `NOT_RECEIVED_BY_PROVIDER`). Если корзина изменилась, уже оформлена или подтверждение использовано, возвращает ошибку; подтверждать всё равно должен человек.
- Заказ записывается по версии корзины из подтверждения (`checkouts.cart_version`), а не по текущей. `update_cart` запрещён, пока у корзины есть отправка в статусе `in_flight`/`unknown` (`SUBMISSION_UNKNOWN`) или принятый заказ (`CART_NOT_OPEN`).

### Подарок: `deliver_to`

`create_cart` для food/mart принимает `deliver_to { name, phone, address_line, district, city }`. Это разовый адрес получателя: он сохраняется как обычный адрес пользователя с меткой `Recipient: <name>`, `is_default = false`, телефон лежит в `instructions`; одинаковый получатель переиспользует ту же строку. Миграций нет. Проверка строгая: имя 1-60 символов, телефон 8-15 цифр, в адресе есть номер дома; в Demo город только Bangkok и район из списка демо-районов (`details.allowed`). Страница подтверждения показывает этот адрес. Нельзя вместе с `address_id`, для ride/express и в Handoff. Адрес виден в разделе «Адреса», пользователь может его удалить; всего не более 30 адресов с учётом получателей.

## Инструменты

| Инструмент | Scope | Побочные эффекты | Аннотации |
|---|---|---|---|
| `get_capabilities` | orders:read | нет. Вызывать первым не обязательно: режим есть в каждом ответе. Компактно: `capabilities { available[], unavailable{key: reason}, source }`, `submissions_enabled`, сервисы с подсказкой «как пользоваться», 8 рынков `{region, currency, demo_city?, links_verified}`, адрес по умолчанию | readOnly |
| `search_stores` | orders:read | нет (читает провайдера). `service`: `food` (по умолчанию) или `mart`; `category`, `query`, бюджет, аллергены, диета. `how_to_order` и `required_options[].options[].option_id`: эти id передаются в `create_cart` | readOnly, openWorld |
| `get_store` | orders:read | нет. Все товары магазина: цены, наличие, обязательные опции, `max_quantity`, аллергены | readOnly, openWorld |
| `estimate_trip` | orders:read | нет, ничего не бронирует. `service`: `ride` или `express`; `pickup`, `dropoff`, `passengers`, `parcel_weight_kg` (обязателен для `express`) | readOnly, openWorld |
| `create_cart` | orders:prepare | создаёт корзину и по умолчанию (`checkout: true`) расчёт и подтверждение с `confirm_url`; в Handoff сразу ссылку Grab. Food/mart: `store_id` + `items`, `deliver_to` для подарка. Ride/express: `service`, `pickup`, `dropoff` и один `item_id` машины. Handoff: `service` + `store_name` и названия товаров, или откуда и куда. `from_order_id` создаёт **новую** корзину для повтора заказа (поездка повторяется точно) | openWorld |
| `update_cart` | orders:prepare | операции `add_item`, `set_quantity`, `remove_item`, `set_address`, `set_trip` (новые `pickup`, `dropoff`, вес посылки). Версия +1, ожидающие подтверждения **аннулируются**; по умолчанию новый расчёт и новый `confirm_url`. Запрещено при отправке в процессе или после заказа | destructive, openWorld |
| `quote_cart` | orders:prepare | сохраняет расчёт с TTL. Не `readOnly`: пишет запись расчёта, к которой привязывается подтверждение; видимых пользователю эффектов нет | openWorld |
| `prepare_checkout` | orders:prepare | создаёт одноразовое подтверждение и `confirm_url` (до 15 минут) | - |
| `get_checkout_status` | orders:read | нет. `status`, `submission`, `order_id`, `step_up_required`, `summary` | readOnly |
| `submit_order` | orders:submit | **необратимо**: отправляет заказ, если человек уже подтвердил его на сайте и заказ ещё не ушёл (обычно его уже отправило нажатие на странице). Идемпотентно: повтор для того же checkout возвращает ту же отправку и никогда не создаёт второй заказ. При `SUBMISSION_UNKNOWN` подождать и смотреть `get_checkout_status`, новый заказ не создавать | destructive, idempotent, openWorld |
| `get_order_status` | orders:read | может обновить статус у провайдера; `status_label` по сервису («Driver assigned», «Parcel in transit») | readOnly, openWorld |
| `list_orders` | orders:read | нет. Заказы, поездки и посылки, плюс недавние Handoff-списки | readOnly |
| `prepare_cancellation` | orders:cancel | запрашивает условия отмены у провайдера и создаёт страницу подтверждения | openWorld |
| `cancel_order` | orders:cancel | **необратимо**: выполняет отмену, если человек подтвердил её на сайте | destructive, idempotent, openWorld |
| `create_handoff` | orders:prepare | сохраняет список (товары или откуда и куда) и ссылку Grab для сервиса и рынка (`link_verified`). Заказ **не создаётся**. `create_cart` в Handoff уже делает это | - |

## Промпты (slash-команды)

Сервер объявляет capability `prompts`. Claude Desktop, VS Code, Cursor и другие клиенты показывают промпты как slash-команды. Определения лежат в `src/mcp/prompts.ts`. Каждый промпт возвращает одно сообщение `user` на английском: просьбу пользователя с его аргументами, короткий безопасный путь по инструментам и общие правила (`CONFIRM_RULES`): пользоваться инструментами Unyly, показать полную цену (товары, все сборы, итог, валюта) и дать `confirm_url`, заказ оформляет только человек кнопкой на странице Unyly, согласие в чате подтверждением не считается, не говорить, что заказ оформлен, пока этого не покажет `get_checkout_status`, в Demo сказать, что это демо, в Handoff отдать ссылку Grab и чек-лист.

| Промпт | Аргументы | Путь |
|---|---|---|
| `order_food` | `request`, `budget?`, `people?`, `avoid?` | `search_stores` (food) → `create_cart`; аллергены передаются как есть, «безопасным» блюдо не называется |
| `buy_groceries` | `items` | `search_stores` (mart, supermarket/convenience) → `create_cart` |
| `send_flowers` | `what`, `recipient`, `card_text?` | `search_stores` (mart, flowers) → `create_cart` с `note` и `deliver_to`; недостающие данные получателя спросить |
| `pharmacy` | `need` | `search_stores` (mart, pharmacy) → `create_cart`; только бытовые средства, без рецептурных и без советов по дозировке сверх инструкции |
| `order_cake` | `occasion`, `inscription?` | `search_stores` (mart, cakes) → `create_cart`, надпись в `note` |
| `book_ride` | `from?`, `to`, `passengers?` | `estimate_trip` (ride) → `create_cart`; без `from` ассистент спрашивает место посадки |
| `send_parcel` | `from?`, `to`, `weight_kg` | `estimate_trip` (express, `parcel_weight_kg`) → `create_cart` |
| `track_orders` | - | `list_orders`, `get_order_status`, `get_checkout_status`; ничего не создаёт и не отменяет |

- Аргументы промптов в MCP всегда строки. Проверка через zod: обязательные не пустые, у всех есть лимит длины, `weight_kg` только число (до двух знаков после точки или запятой). Ошибка проверки или неизвестное имя возвращают JSON-RPC `-32602`.
- Пустая строка в необязательном аргументе равна его отсутствию (некоторые клиенты присылают `""` для незаполненных полей).
- Отдельного scope промпты не требуют: `prompts/list` и `prompts/get` работают с любым действующим токеном. Scope проверяется только при `tools/call`.

## Server info и Server Card

`initialize` возвращает `serverInfo { name: "unyly", title: "Unyly", version: "1.0.0", description, websiteUrl, icons }`. `websiteUrl` равен `WEB_ORIGIN`, `icons` содержит абсолютные ссылки на `/static/brand/icon-192.png` и `/static/brand/icon-512.png` (`image/png`, `sizes`). Собирается функцией `serverInfo(ctx)` в `src/mcp/tools.ts`.

Для обнаружения сервера без подключения есть карточка в духе черновика MCP Server Card (SEP-1649):

- `GET /.well-known/mcp/server-card.json`
- `GET /.well-known/mcp.json` (то же самое)

Публичная, без авторизации и без cookies, `Cache-Control: public, max-age=3600`, `Access-Control-Allow-Origin: *`. Код в `src/mcp/server-card.ts`. Поля: `version: "1.0"`, `protocolVersion` (`LATEST_PROTOCOL_VERSION` из SDK), `serverInfo`, `description`, `documentationUrl` (`WEB_ORIGIN/docs`), `transport { type: "streamable-http", endpoint }` (абсолютный `MCP_RESOURCE_URL`), `capabilities { tools, prompts }`, `authentication { required: true, schemes: ["oauth2"], oauth2 { protectedResourceMetadata, authorizationServer, scopes } }`, `tools[] { name, title, description }`, `prompts[] { name, title, description, arguments }`, `disclaimer`. Списки инструментов и промптов не копируются руками: при первом запросе сервер строит тот же `McpServer`, что и для `/mcp`, выполняет `tools/list` и `prompts/list` через in-memory транспорт и кэширует результат, поэтому карточка не может разойтись с тем, что реально отдаёт `/mcp`.

## Доменные ошибки

| Код | Когда | Что делать ассистенту |
|---|---|---|
| `AUTH_REQUIRED` | токен недействителен или аккаунт удалён | переподключить |
| `INSUFFICIENT_SCOPE` | пользователь не выдал нужное право; `_meta["mcp/www_authenticate"]` | попросить переподключить с этим правом |
| `NOT_FOUND` | объекта нет или он чужой | - |
| `VALIDATION_FAILED` | неверные аргументы; `details.field` (для `deliver_to` ещё `details.allowed`) | исправить; недостающее спросить у пользователя, не угадывать |
| `CAPABILITY_UNAVAILABLE` | функция недоступна в текущем режиме; `details.reason` и `details.source` | `get_capabilities` |
| `ADDRESS_REQUIRED` / `ADDRESS_AMBIGUOUS` | нет адреса / адрес неполный | дать пользователю ссылку из `user_action` (для подарка можно `deliver_to`) |
| `DELIVERY_UNAVAILABLE`, `RESTAURANT_CLOSED`, `OUT_OF_STOCK`, `MINIMUM_ORDER_NOT_MET`, `ITEM_NOT_FOUND` | проблемы каталога и корзины | изменить корзину или выбрать другой магазин (`next_actions`) |
| `MODIFIERS_INVALID` | не выбрана обязательная опция; `details.required_groups[] { group_id, name, min_select, max_select, options[] { option_id, name } }` | `user_action`: спросить пользователя, повторить с `modifiers` |
| `QUANTITY_LIMIT` | больше `max_quantity` на заказ (считается по всем строкам; у поездки ровно одна машина); `details.max_quantity` | спросить, заказать ли меньше |
| `PLACE_NOT_FOUND` / `PLACE_AMBIGUOUS` | место не найдено на демо-карте / неоднозначно («аэропорт»); `details.suggestions` | `user_action`: спросить пользователя, перечислив варианты; не выбирать за него |
| `TRIP_REQUIRED`, `OUTSIDE_SERVICE_AREA` | нет откуда/куда или веса посылки; место вне демо-карты | спросить пользователя, `update_cart` с `set_trip` |
| `WEIGHT_LIMIT` | посылка тяжелее лимита машины; сообщение называет самую маленькую подходящую машину (`item_id`) | с согласия пользователя `update_cart` с `remove_item` и `add_item` в одном вызове |
| `CART_VERSION_CONFLICT` | `expected_version` устарела; `details.current_version` | перечитать и повторить |
| `CART_EMPTY`, `CART_NOT_OPEN` | корзина пуста / уже оформлена | новая корзина |
| `QUOTE_EXPIRED`, `PRICE_CHANGED` | расчёт устарел или цена изменилась | `quote_cart`, затем новое подтверждение |
| `CONFIRMATION_REQUIRED` | человек ещё не подтвердил; `details.confirm_url` | отправить ссылку, потом `get_checkout_status` |
| `CONFIRMATION_EXPIRED`, `CONFIRMATION_INVALIDATED` | подтверждение истекло или стало недействительным (`details.reason`) | пересчитать |
| `SUBMISSIONS_PAUSED` | включён выключатель новых заказов | сообщить пользователю |
| `PROVIDER_UNAVAILABLE` | провайдер недоступен; демо-данные **не** подставляются | повторить позже |
| `PROVIDER_REJECTED` | провайдер отказал | - |
| `SUBMISSION_UNKNOWN` | исход отправки неизвестен, идёт сверка; также `update_cart` для такой корзины | **не** создавать новый заказ; позже проверить `get_checkout_status` |
| `CANCELLATION_NOT_ALLOWED`, `CANCELLATION_UNKNOWN` | - | - |
| `RATE_LIMITED`, `INTERNAL` | - | - |

## Примеры сценариев (Demo)

Еда:
```text
search_stores {party_size:2, budget_total_major:600, exclude_allergens:["peanut","tree_nut"], limit:3}
create_cart {store_id:"demo-r3", items:[{item_id:"r3-wonton",quantity:1},{item_id:"r3-crispypork",quantity:1}]}
   → items, quote (total THB 250.00, fees, issues:[]), checkout.confirm_url=https://unyly.org/confirm/<id>, expires_at (+15 мин)
   … пользователь открывает ссылку, проверяет и нажимает «Подтвердить и оформить»: заказ оформлен …
get_checkout_status {checkout_id} → status=consumed, submission.accepted, order_id, summary
get_order_status {order_id} → fulfillment=accepted, payment=not_charged_demo
```
Такси:
```text
estimate_trip {service:"ride", pickup:"Siam Paragon", dropoff:"ICONSIAM"} → options (item_id, seats, fits, estimated_total), подходящие и дешёвые первыми
create_cart {service:"ride", pickup:"Siam Paragon", dropoff:"ICONSIAM", items:[{item_id:"justgrab",quantity:1}]} → fare, confirm_url
   … подтверждение на сайте …
get_checkout_status → order_id → get_order_status → status_label="Driver assigned"
```
Посылка: то же с `service:"express"` и `parcel_weight_kg`; если машина мала, `quote.issues[WEIGHT_LIMIT]` называет подходящую, замена одним `update_cart` (`remove_item` + `add_item`) сразу возвращает новый `confirm_url`.

Цветы в подарок:
```text
search_stores {service:"mart", category:"flowers", query:"roses"} → matching_items[].required_options[].options[].option_id
create_cart {store_id:"demo-m3", items:[{item_id:"m3-roses", quantity:1, modifiers:[{group_id:"wrap", option_ids:["box"]}], note:"Happy anniversary!"}],
             deliver_to:{name:"Nok", phone:"+66 81 234 5678", address_line:"55/1 Soi Ari 4", district:"Phaya Thai", city:"Bangkok"}}
get_checkout_status (после подтверждения)
```

Если ассистент вызовет `submit_order` до подтверждения, он получит `CONFIRMATION_REQUIRED`. Вызов после подтверждения - безопасный повтор, возвращающий тот же результат.
