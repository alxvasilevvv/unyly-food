# Ari × Grab: техническое задание для команды Ari

Версия 1.1, 16 ноября 2026. Сторона Unyly (движок интеграции) готова и работает в демо-режиме: https://unyly-food.unyly.org/ari. Этот документ описывает, что нужно сделать в бэкенде Ari и в iOS-приложении Ari, чтобы пользователи заказывали сервисы Grab прямо в Ari.

Описание API в формате OpenAPI 3.1: https://unyly-food.unyly.org/partner/v1/openapi.json
Обзор для разработчиков: https://unyly-food.unyly.org/developers

Что важно знать до начала работы:

- Сейчас доступен только демо-режим. Все данные в нём вымышлены: магазины, блюда, цены, маршруты, заказы, водители и курьеры. Ничего не доставляется и деньги не списываются.
- Реальные заказы (режим `live`) зависят от доступа к API Grab. Этот доступ выдаёт Grab, и на дату документа он не получен. Документ не утверждает, что Grab согласовал интеграцию.
- Всё, что описано ниже, проверяется в демо-режиме. Каждая задача заканчивается проверкой «Готово, когда».

---

## 1. Что получит пользователь

1. Говорит или пишет Ari: «такси от Siam Paragon до аэропорта Suvarnabhumi», «ужин на двоих до 600 бат без орехов», «отправь посылку 3 кг в ICONSIAM», «розы с открыткой», «парацетамол и пластыри».
2. Ari показывает варианты (карточка `options`), пользователь выбирает.
3. Ari показывает карточку `checkout` со всеми строками, сборами и итогом.
4. Пользователь нажимает «Подтвердить». Приложение проверяет Face ID (обязательно для крупных сумм, рекомендуется всегда).
5. Заказ оформлен. Статус показывается в Live Activity (Dynamic Island) и в карточке `order`, приходят пуши. Когда водитель выезжает к пользователю, Ari сама звонит: «Ваш водитель Somchai на серебристой Toyota, номер 3กข 1234, едет к вам» (в демо имя, машина и номер вымышлены).
6. Заказ можно отменить: Ari показывает карточку `cancellation` с платой за отмену, пользователь подтверждает.

Главное правило: заказ создаётся только нажатием пользователя на карточку в приложении. Ответ «да» в чате или решение LLM заказ не создаёт никогда.

## 2. Кто за что отвечает

| Компонент | Отвечает за |
|---|---|
| iOS-приложение Ari | Отрисовка карточек, кнопки, Face ID, Live Activity, пуши, звонок Ari, экран «Аккаунт Grab» |
| Бэкенд Ari | LLM и вызов инструментов, подпись запросов к Unyly, приём вебхуков, рассылка пушей и обновлений Live Activity, запуск звонка |
| Unyly (готово в демо-режиме) | Инструменты, цены и маршруты, карточки, проверка подтверждения, заказы, статусы, отмены, события, безопасность |
| Grab | API: GrabExpress, Farefeed, Login with Grab, GrabPay и другие. Доступ выдаёт Grab, от него зависит режим `live` |

Схема: `iPhone (Ari) → бэкенд Ari → Unyly Partner API → API Grab`. Приложение никогда не ходит в Unyly напрямую: секрет партнёра хранится только на бэкенде Ari.

## 3. Доступы и окружение

Unyly выдаёт команде Ari:

| Параметр | Значение |
|---|---|
| Базовый URL | `https://unyly-food.unyly.org` |
| `partner_id` | `ari` |
| `partner_secret` | 64 символа, передаётся отдельно защищённым каналом, хранить в KMS или secret manager |
| `webhook_secret` | для проверки вебхуков от Unyly, передаётся отдельно, отличается от `partner_secret` |
| Режим | `demo` (вымышленные магазины, цены и заказы в Бангкоке). Режим `live` включает Unyly на своей стороне после получения доступа к API Grab; пути и форматы API при этом не меняются |

Команда Ari сообщает Unyly адрес вебхука (HTTPS), например `https://api.ari.app/webhooks/unyly`.

Обозначения в путях (те же, что в OpenAPI):

| Параметр | Что это | Откуда взять |
|---|---|---|
| `{uid}` | id пользователя на стороне Ari | выбирает Ari (см. B2) |
| `{cid}` | id чекаута, UUID | `card.id` карточки `checkout`, он же `result.checkout.checkout_id` |
| `{oid}` | id заказа, UUID | `order.id` в ответе подтверждения, `card.id` карточки `order`, `data.order_id` в событиях |
| `{xid}` | id отмены, UUID | `cancellation.cancellation_id`, он же `card.id` карточки `cancellation` |
| `{pid}` | id сохранённого места, UUID | `place.place_id` |
| `{name}` | имя инструмента | `tools[].name` из `GET /partner/v1/tools` |

Все успешные ответы имеют вид `{"ok": true, ...}` и HTTP 200, кроме двух случаев с 201: первое создание пользователя и добавление места. Все ошибки имеют вид `{"ok": false, "error": {...}}` (см. B10).

## 4. Подпись запросов (обязательно для каждого запроса)

Заголовки:

```
X-Unyly-Partner: ari
X-Unyly-Timestamp: <unix-время в секундах>        допуск ±300 секунд
X-Unyly-Nonce: <16-64 символа [A-Za-z0-9_-]>      одноразовый, новый на каждый запрос
X-Unyly-Signature: v1=<hex HMAC-SHA256>
Content-Type: application/json                     если есть тело
```

Строка для подписи: шесть строк через `\n`, без `\n` в конце:

```
v1
<МЕТОД В ВЕРХНЕМ РЕГИСТРЕ>
<путь с query ровно как в запросе, например /partner/v1/users/u_1/events?after=12>
<X-Unyly-Timestamp>
<X-Unyly-Nonce>
<hex(sha256(сырое тело запроса)); для пустого тела sha256 от пустой строки>
```

Подпись: `v1=` + hex(HMAC_SHA256(partner_secret, строка)), hex в нижнем регистре. Секрет используется как строка (64 символа в UTF-8), его не нужно декодировать из hex.

Правила, на которых чаще всего ошибаются:

- Подписываются ровно те байты, которые уходят в теле. Сначала сериализуйте JSON в строку, потом подпишите и отправьте эту же строку.
- Путь в подписи совпадает с отправленным байт в байт, включая query и процентное кодирование. Пути действий из карточек (`endpoint.path`) уже закодированы: используйте их как есть.
- У запросов GET и DELETE тела нет. Тело, если оно есть, должно быть JSON-объектом не больше 64 КБ с `Content-Type: application/json`.
- Повтор запроса (retry) подписывается заново: с новым nonce и новым временем.
- Завершающего слэша в путях нет.

Контрольный пример для самопроверки реализации (секрет учебный):

```
partner_secret: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
метод и путь:   PUT /partner/v1/users/u_1
timestamp:      1794700800
nonce:          abcdefghijklmnopqrstuvwx
тело:           {"locale":"ru","region":"TH"}
sha256(тело):   d06e8bef2f9d08de2be859f61046f1088c6b7893efaea4749116dd671c8be129
подпись:        v1=0f3cf05242bc55faa837f136fbc26ba00322b4508ca6a090cd9a2d5c568cdb55
```

Пример на TypeScript (Node 18+):

```ts
import { createHash, createHmac, randomBytes } from 'node:crypto';

const BASE = 'https://unyly-food.unyly.org';
const PARTNER = 'ari';
const SECRET = process.env.UNYLY_PARTNER_SECRET!;

export async function unyly(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const digest = createHash('sha256').update(raw).digest('hex');
  const canonical = ['v1', method.toUpperCase(), path, ts, nonce, digest].join('\n');
  const sig = 'v1=' + createHmac('sha256', SECRET).update(canonical).digest('hex');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'x-unyly-partner': PARTNER, 'x-unyly-timestamp': ts, 'x-unyly-nonce': nonce, 'x-unyly-signature': sig,
      ...(raw ? { 'content-type': 'application/json' } : {}),
    },
    body: raw || undefined,
  });
  return { status: res.status, json: await res.json() };
}
```

Пример на Python:

```python
import hashlib, hmac, json, os, secrets, time, requests

BASE, PARTNER, SECRET = "https://unyly-food.unyly.org", "ari", os.environ["UNYLY_PARTNER_SECRET"].encode()

def unyly(method, path, body=None):
    raw = "" if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    ts, nonce = str(int(time.time())), secrets.token_urlsafe(18)
    canonical = "\n".join(["v1", method.upper(), path, ts, nonce, hashlib.sha256(raw.encode()).hexdigest()])
    sig = "v1=" + hmac.new(SECRET, canonical.encode(), hashlib.sha256).hexdigest()
    headers = {"x-unyly-partner": PARTNER, "x-unyly-timestamp": ts, "x-unyly-nonce": nonce, "x-unyly-signature": sig}
    if raw:
        headers["content-type"] = "application/json"
    return requests.request(method, BASE + path, headers=headers, data=raw.encode() if raw else None, timeout=15)
```

Проверка: `GET /partner/v1/ping` отвечает `{"ok": true, "partner": "ari", "mode": "demo", "time": "<время сервера, ISO 8601>"}`. Любая ошибка подписи (нет заголовка, неверный секрет, часы ушли больше чем на 300 секунд, повторный nonce) даёт один и тот же ответ: 401 `PARTNER_AUTH_FAILED` без подробностей. Если подпись не проходит, сравните `time` из ответа `ping` с часами своего сервера.

---

## 5. Задачи для бэкенда Ari

### B1. Клиент Unyly
Модуль с функцией подписи из раздела 4. Таймаут 15 секунд. В лог писать метод, путь, HTTP-статус, `error.code` и, если есть, `operation_id` (приходит на верхнем уровне ответа при ошибке инструмента; его нужно назвать при обращении в Unyly). Секрет читать только из secret manager и не писать в лог.

Готово, когда:
- реализация выдаёт подпись из контрольного примера раздела 4;
- `GET /partner/v1/ping` из staging и из prod Ari отвечает 200 с `mode: "demo"`;
- запрос с испорченной подписью отвечает 401 `PARTNER_AUTH_FAILED`.

### B2. Пользователь
Когда пользователь впервые обращается к Ari с запросом про Grab, вызвать `PUT /partner/v1/users/{uid}` с телом `{"locale": "th", "region": "TH", "display_name": "Alex"}`. Все три поля необязательны: без них новый пользователь получает `locale: "en"` и `region: "TH"`.
- `uid`: стабильный внутренний id пользователя Ari (1-128 символов `[A-Za-z0-9._:@-]`), не телефон и не email. Если в id есть `:` или `@`, в пути их можно кодировать (`%3A`, `%40`); подписывается тот вариант, который отправлен.
- `locale`: `en, th, vi, id, ms, fil, km, my, zh, ru`. `region`: `TH, SG, MY, ID, VN, PH, KH, MM`. Другое значение даёт 400 `VALIDATION_FAILED`.
- Первый вызов отвечает 201, повторный 200. Повторный вызов обновляет только переданные поля.
- Ответ: `user` (`user_id`, `display_name`, `locale`, `region`, `mode`, `created`) и `grab` (`linked`, `linked_at`, `simulated`). Тот же ответ даёт `GET /partner/v1/users/{uid}`.
- Все остальные вызовы для пользователя, который не создан, отвечают 404 `NOT_FOUND`.
- Тексты карточек и уведомлений готовы на английском, русском и тайском. Для остальных языков из списка карточки и `notify` приходят целиком на английском (без смешения языков), а суммы оформляются в английском формате.

Готово, когда: первый `PUT` отвечает 201, второй 200; после `PUT` с `{"locale": "ru"}` новая карточка `checkout` приходит с `total.label: "Итого"`, после `{"locale": "en"}` с `"Total"`.

### B3. Инструменты для LLM
1. При старте (и раз в сутки) загрузить `GET /partner/v1/tools`: в ответе `instructions` (добавить в системный промпт Ari, когда пользователь говорит о Grab) и `tools[]` с `name`, `title`, `description`, `input_schema` (JSON Schema), `read_only`. Формат подходит для tool calling OpenAI и Anthropic без изменений.
2. Вызов инструмента моделью: `POST /partner/v1/users/{uid}/tools/{name}` с телом `{"arguments": {...}}`.
3. Ответ: `ok`, `mode`, `data_as_of`, `result` (данные для модели), `next_actions`, `notices`, `card` (для приложения). Модели отдавать `result`, `next_actions`, `notices`; приложению отдавать `card`. Если `card` равен `null`, показывать нечего.
4. Любая ошибка самого инструмента приходит с HTTP 422 и `ok: false`. Причина лежит в `error.code` (например, `PLACE_NOT_FOUND`, `PLACE_AMBIGUOUS`, `VALIDATION_FAILED` при неверных аргументах, `PRICE_CHANGED`), поэтому логику обработки стройте на `error.code`: HTTP-статус у всех таких ошибок одинаковый. Модели отдать `error.code`, `error.message`, `error.user_action`: там написано, что спросить у пользователя. HTTP 404 на этом пути означает, что пользователь не создан или инструмента с таким именем нет. HTTP 400 означает, что запрос составлен неверно или инструмент закрыт для партнёров (`submit_order`, `cancel_order`: вместо них работают эндпоинты подтверждения из B4 и B9).
5. Основные пути: еда и магазины `search_stores` → `create_cart {store_id, items}`; поездка и посылка `estimate_trip {service, pickup, dropoff}` → `create_cart {service, pickup, dropoff, items:[{item_id, quantity:1}]}` (для посылки ещё `parcel_weight_kg`). После `create_cart` приходит карточка `checkout`.
6. Какой инструмент какую карточку возвращает:

   | Инструмент | Карточка |
   |---|---|
   | `search_stores`, `estimate_trip` | `options` |
   | `create_cart`, `update_cart` | `checkout`; если заказ что-то блокирует, `message` с объяснением |
   | `prepare_cancellation` | `cancellation` |
   | `get_capabilities`, `get_store`, `quote_cart`, `prepare_checkout`, `get_checkout_status`, `get_order_status`, `list_orders` | карточки нет (`card: null`), данные только для модели |

   `create_cart` и `update_cart` сами считают цену и готовят чекаут, поэтому `quote_cart` и `prepare_checkout` обычно не нужны. Карточки по id бэкенд читает отдельными вызовами: чекаут после `prepare_checkout` через `GET /partner/v1/users/{uid}/checkouts/{cid}` с `result.checkout_id`, заказ после `get_order_status` через `GET /partner/v1/users/{uid}/orders/{oid}` с `result.order_id`. Правило для приложения простое: если в ответе инструмента `card` не `null`, показать её.
7. Если пользователь выбирает вариант нажатием на карточку `options`, приложение присылает `action.tool` (имя и готовые аргументы), бэкенд вызывает этот инструмент напрямую, без LLM.
8. Число пассажиров передаётся только в `estimate_trip` (`passengers`, от 1 до 10). Машины, в которых мест меньше, остаются в карточке без кнопки и с причиной в `disabled_reason` («Мест всего 4»). Значение больше 10 даёт 422 `VALIDATION_FAILED`. У `create_cart` аргумента `passengers` нет.
9. Для еды и магазинов нужен сохранённый адрес доставки (B6). Если в `notices` встретится ссылка на сайт Unyly для добавления адреса, пользователю её не показывать: адреса партнёрских пользователей добавляет бэкенд Ari.
10. В демо-режиме карта знает достопримечательности и районы Бангкока и сохранённые места пользователя. «Аэропорт» без уточнения даёт 422 `PLACE_AMBIGUOUS` с вариантами в `error.details.suggestions`: в Бангкоке два аэропорта.

Готово, когда:
- «такси от Siam Paragon до Suvarnabhumi» показывает карточку `options` с маршрутом и ценами, выбор варианта показывает карточку `checkout` с итогом;
- «такси до аэропорта» приводит к уточняющему вопросу Ari с двумя аэропортами (обработан `PLACE_AMBIGUOUS`);
- неизвестное место («Zzyzx») приводит к вопросу пользователю, без падения и без выдуманного адреса.

### B4. Подтверждение заказа (критично для безопасности)
На бэкенде Ari нужен эндпоинт, который вызывает только приложение после нажатия кнопки. Он отправляет в Unyly:
```
POST /partner/v1/users/{uid}/checkouts/{cid}/confirm
{"confirm_hash": "<из action.endpoint.body карточки>", "user_verification": "biometric", "confirmed_at": "<время нажатия ISO 8601>", "device_id": "<id устройства>"}
```
Путь и `confirm_hash` готовыми лежат в действии `kind: "confirm"` карточки: `endpoint.method`, `endpoint.path`, `endpoint.body`.
- `confirm_hash` и `user_verification` обязательны (иначе 400 `VALIDATION_FAILED`). `confirmed_at` необязателен; если передан, он должен быть не старше 10 минут. `device_id` необязателен, до 80 символов.
- `user_verification`: `biometric` (Face ID / Touch ID), `passcode` или `tap`. Если в карточке `requires_user_verification: "biometric"`, то `tap` вернёт 403 `STEP_UP_REQUIRED`. Порог по умолчанию: итог от 2 000 бат.
- `confirm_hash` привязывает подтверждение к той цене и составу, которые видел пользователь. Если прислан хеш не от этой карточки, вернётся 409 `CONFIRM_HASH_MISMATCH`: запросите `GET /partner/v1/users/{uid}/checkouts/{cid}` и покажите карточку заново.
- Если корзина изменилась после показа карточки (`update_cart`), старое подтверждение закрывается: вызов вернёт 409 `CONFIRMATION_INVALIDATED` с `details.reason: "CART_CHANGED"`. Новая карточка с новым `id` и новой ценой приходит в ответе `update_cart` или `create_cart`, показать нужно её. `GET` по старому `id` вернёт прежнюю карточку с пустым `actions`.
- Карточка действует до `expires_at` (до 15 минут). После этого вызов вернёт 409 `CONFIRMATION_EXPIRED`: вызовите `create_cart` с теми же аргументами и покажите новую карточку.
- Успешный ответ: `checkout` (`checkout_id`, `status`, `total`, `submission`, `order_id`, `summary`) и `order: {id, card}` с карточкой заказа. `checkout.status` после отправки заказа равен `consumed`.
- Повторный вызов безопасен: вернёт тот же заказ, второй заказ не создаётся. Это верно и для нескольких параллельных вызовов.
- `order: null` при ответе 200 означает, что исход ещё не известен. Смотрите `checkout.submission.status`: `unknown` (провайдер ещё не ответил, Unyly сам уточняет исход) или `in_flight` (заказ прямо сейчас отправляет параллельный вызов). В обоих случаях второй заказ создавать нельзя: дождитесь события `order.created` или повторите этот же вызов позже.
- Если провайдер отказал в заказе, вызов вернёт 422 `PROVIDER_REJECTED` (или 409 `OUT_OF_STOCK`, `RESTAURANT_CLOSED`, `DELIVERY_UNAVAILABLE`): заказ не создан, деньги не списаны. Повтор вызова после отказа вернёт 200 с `order: null` и `submission.status: "rejected"`.
- Актуальную карточку заказа в любой момент возвращает `GET /partner/v1/users/{uid}/orders/{oid}` (статус при этом обновляется у провайдера). Список последних заказов: `GET /partner/v1/users/{uid}/orders?limit=10` (от 1 до 50, сначала новые) с полями `orders[]` (`order_id`, `service`, `title`, `total`, `fulfillment_status`, `status_label`, `is_final`, `placed_at`), `next_before`, `handoffs[]`.
- У модели (LLM) не должно быть доступа к этому вызову: его запускает только нажатие пользователя в приложении.
- «Не сейчас»: `POST /partner/v1/users/{uid}/checkouts/{cid}/decline` без тела. Ответ: `checkout` со `status: "declined"`. Подтвердить такой чекаут уже нельзя (409 `CONFIRMATION_INVALIDATED`, `details.reason: "DECLINED"`).
- Предоплата GrabPay в режиме `live` для партнёрских приложений включается вместе с мерчант-аккаунтом GrabPay; до этого подтверждение такого заказа вернёт 503 `NOT_CONFIGURED`, деньги не списываются. В демо-режиме этого случая нет.

Готово, когда:
- заказ создаётся только вызовом этого эндпоинта из приложения; сообщение «да, заказывай» в чате заказ не создаёт (автотест);
- два одинаковых вызова подряд возвращают один и тот же `order.id`;
- вызов с чужим `confirm_hash` возвращает 409 и приложение показывает карточку заново;
- для корзины от 2 000 бат вызов с `tap` возвращает 403, с `biometric` создаёт заказ.

### B5. Вебхуки от Unyly
Принимать `POST` на адрес вебхука. Заголовки: `X-Unyly-Event` (тип события), `X-Unyly-Delivery` (равен `event_id`), `X-Unyly-Partner`, `X-Unyly-Timestamp`, `X-Unyly-Nonce`, `X-Unyly-Signature`. Подпись проверяется по той же схеме (раздел 4) с `webhook_secret`, методом `POST`, путём и query вашего вебхука и сырым телом запроса (проверять нужно до разбора JSON).
1. Проверить подпись и время (±300 с), иначе ответить 401.
2. Дедупликация по `event_id`: одно событие может прийти повторно.
3. Ответить 2xx быстро (Unyly ждёт ответа не дольше 4 секунд), обработку вести асинхронно. При любом другом ответе или таймауте Unyly повторит доставку: до 12 попыток с растущей задержкой от 10 секунд до 1 часа. Перенаправления (3xx) не выполняются.
4. Тело события: `event_id`, `seq`, `type`, `partner_id`, `user_id` (ваш `uid`), `created_at`, `data` и, для событий заказа, `notify`.

   | `type` | Поля `data` |
   |---|---|
   | `order.created` | `order_id`, `checkout_id`, `service`, `status`, `total_minor`, `currency`, `title` |
   | `order.status_changed` | `order_id`, `service`, `status`, `status_label`, `is_final`, `eta_at` |
   | `checkout.confirmed` | `checkout_id`, `order_id` (или `null`, если заказ ещё не принят), `user_verification` |
   | `cancellation.confirmed` | `cancellation_id`, `order_id`, `status` |
   | `grab.linked` | `simulated` |
   | `grab.unlinked` | пусто |

   Первый статус заказа («Водитель назначен», «Ресторан принял заказ») приходит в `order.created`; `order.status_changed` отправляется при каждой следующей смене статуса.
5. Поле `notify` есть в `order.created` и `order.status_changed`. Оно уже на языке пользователя (английский, русский или тайский; для остальных языков английский). Пользователю показывайте `notify.title` и `notify.body`; `data.status_label` служебный и может быть на английском.
   - `level: "info"`: только обновить Live Activity и карточку.
   - `level: "important"`: обычный пуш `title` + `body`.
   - `level: "urgent"` и `suggest_call: true`: пуш и звонок Ari пользователю (существующая функция «Ari звонит»), текст звонка собрать из `notify.body` и карточки заказа (`courier.name`, `courier.vehicle`, `courier.plate`). Поле `suggest_call` есть только тогда, когда звонок нужен. Сейчас это один случай: поездка, статус `preparing` («Водитель едет к вам»).
   - `live_activity: {state, progress (0..1), eta_at}`: обновление Live Activity через APNs. `state` равен коду статуса заказа.
6. Резервный путь: `GET /partner/v1/users/{uid}/events?after=<seq>` возвращает `events[]` с теми же объектами (до 50 за запрос, по возрастанию `seq`). В теле вебхука тоже есть `seq`: сохраняйте последний обработанный номер по каждому пользователю и после простоя запрашивайте события после него, пока не придёт пустой список. Номера `seq` растут, но идут не подряд (нумерация общая для всех пользователей). События хранятся 30 дней.
7. Данные курьера (`courier` в карточке заказа) есть только тогда, когда их передаёт провайдер. В демо это вымышленный водитель или курьер (`fictional: true`), пока заказ в статусе `accepted`, `preparing` или `picked_up`. Если поля нет, текст звонка собирается только из `notify.body`.
8. В демо-режиме заказ проходит все статусы примерно за 2-3 минуты, поэтому всю цепочку событий можно проверить за один прогон.

Готово, когда:
- вебхук с неверной подписью получает 401, с верной 2xx;
- повторная доставка того же `event_id` не создаёт второй пуш;
- статусы демо-заказа приходят в приложение без опроса; при событии с `suggest_call: true` Ari звонит;
- после 10 минут простоя приёмника пропущенные события дочитываются через `/events?after=<seq>`.

### B6. Места пользователя
Адреса доставки и ярлыки «Дом», «Работа» из памяти Ari передавать в `POST /partner/v1/users/{uid}/places`:
- обязательные поля: `label` (до 40 символов), `line1` (улица с номером дома), `district`, `city`;
- необязательные: `country` (код региона из B2, по умолчанию регион пользователя), `instructions`, `is_default` (по умолчанию `true`: новое место становится адресом доставки по умолчанию), `latitude` и `longitude` числами, если известна точная точка.

Ответ 201: `place` с полями `place_id`, `label`, `area` (район и город), `is_default`. Улицу и номер дома API обратно не возвращает. Неполный адрес (нет обязательного поля, в `line1` нет номера дома) вернёт 400 `VALIDATION_FAILED` со списком полей в `error.details.fields`. Список: `GET /partner/v1/users/{uid}/places` (`places[]`), удаление: `DELETE /partner/v1/users/{uid}/places/{pid}`.

Сохранённое место можно называть в `pickup` и `dropoff` по его `label` («Дом»), а место по умолчанию служит адресом доставки еды и товаров.

Готово, когда: после сохранения места «Дом» запрос «такси домой» возвращает карточку `options` с `route.to: "Дом"`, а `search_stores` показывает рестораны с доставкой по этому адресу.

### B7. Аккаунт Grab
- Статус: `GET /partner/v1/users/{uid}/grab` → `grab: {linked, linked_at, simulated}`.
- Привязка: `POST /partner/v1/users/{uid}/grab/link` без тела. В демо аккаунт привязывается сразу, это симуляция: ответ `{"ok": true, "status": "linked", "linked": true, "linked_at": "...", "simulated": true}` и событие `grab.linked`.
- Отвязка: `DELETE /partner/v1/users/{uid}/grab` → `grab` с `linked: false` и событие `grab.unlinked`.
- В режиме `live` Login with Grab (OAuth 2.0 с PKCE) включится после выдачи учётных данных GrabID и регистрации redirect URI приложения Ari; до этого вызов привязки возвращает 503 `NOT_CONFIGURED`. Формат ответа с адресом авторизации для `ASWebAuthenticationSession` будет добавлен в OpenAPI перед включением; сейчас его реализовывать не нужно. Пароли и OTP Grab Ari не видит никогда.
- В демо-режиме привязка аккаунта Grab для заказа не требуется.

Готово, когда: в демо кнопка «Привязать» меняет статус на `linked: true`, кнопка «Отвязать» на `linked: false`; ответ 503 `NOT_CONFIGURED` показывает пользователю сообщение «пока недоступно» без ошибки приложения.

### B8. Удаление данных
При удалении аккаунта Ari вызвать `DELETE /partner/v1/users/{uid}`: вызов удаляет все данные пользователя в Unyly (PDPA, GDPR) и отвечает `{"ok": true, "deleted": true}`.

Готово, когда: после удаления `GET /partner/v1/users/{uid}` отвечает 404; повторный `PUT` с тем же `uid` создаёт пустого пользователя (201, без заказов и мест).

### B9. Отмена заказа
Отмену, как и заказ, подтверждает только пользователь нажатием в приложении.
1. Кнопка отмены в карточке заказа (`kind: "prepare_cancel"`) есть, пока заказ ещё можно отменить (статусы `submitted`, `accepted`, `preparing`). По нажатию вызвать `POST /partner/v1/users/{uid}/orders/{oid}/cancel` без тела (путь лежит в `endpoint.path` кнопки). В ответе `cancellation` (`cancellation_id`, `order_id`, `status`, `fee`, `terms`, `expires_at`, `message`) и карточка `cancellation` с платой за отмену. Этот вызов ничего не отменяет.
2. Если отменить уже нельзя, вернётся 409 `CANCELLATION_NOT_ALLOWED`, причина в `error.message`.
3. Пользователь нажимает «Подтвердить отмену»: `POST /partner/v1/users/{uid}/cancellations/{xid}/confirm` с телом `{"confirm_hash": "<из action.endpoint.body карточки>", "user_verification": "tap"}`. Оба поля обязательны. Кнопка «Оставить заказ» (`kind: "decline"` без `endpoint`) просто закрывает карточку, вызов в Unyly не нужен.
4. В ответе `cancellation.status`: `executed` (заказ отменён), `rejected` (провайдер отказал, заказ продолжается), `invalidated` (плата изменилась, пока пользователь думал: подготовьте отмену заново и покажите новую карточку), `unknown` (исход уточняется, смотрите статус заказа). Там же `order: {id, card}` с актуальной карточкой.
5. Карточку отмены можно перечитать: `GET /partner/v1/users/{uid}/cancellations/{xid}`. Подтверждение действует 5 минут (`expires_at`). Позже, а также если плата изменилась до подтверждения, вызов вернёт 409 (`CONFIRMATION_EXPIRED`, `PRICE_CHANGED` или `CONFIRMATION_INVALIDATED`): подготовьте отмену заново (шаг 1). Хеш не от этой карточки даёт 409 `CONFIRM_HASH_MISMATCH`.
6. После отмены приходят события `order.status_changed` со статусом `cancelled` и `cancellation.confirmed`.
7. Плата в демо условная и не списывается: сразу после назначения водителя или курьера 0 бат; когда водитель уже едет, 30 бат за поездку и 20 бат за посылку; для еды после начала приготовления 50% суммы.

Готово, когда: отмена проходит только по нажатию; плата за отмену видна на карточке до подтверждения; после подтверждения карточка заказа показывает статус `cancelled` и кнопки отмены на ней больше нет.

### B10. Обработка ошибок
Все ошибки, включая 429, приходят в одном формате: `{"ok": false, "error": {"code", "message", "details", "user_action"}}`. `code` и `message` есть всегда, `details` и `user_action` необязательны. `message` написан по-английски для логов и для модели; пользователю его дословно показывать не нужно. У ошибок инструментов (422) рядом с `error` есть ещё `next_actions`, `notices`, `operation_id` и `card: null`.

| Код | HTTP | Что делать |
|---|---|---|
| `PARTNER_AUTH_FAILED` | 401 | Проверить часы сервера, секрет и путь в подписи |
| `NOT_FOUND` | 404 | Сначала `PUT /partner/v1/users/{uid}`; проверить имя инструмента и id. Тот же ответ приходит на неизвестный путь, неверный метод, путь с завершающим слэшем и id не в формате UUID |
| `VALIDATION_FAILED` | 400 | Исправить запрос (сообщение называет поле). Тело запроса должно быть JSON-объектом с `Content-Type: application/json` |
| `PAYLOAD_TOO_LARGE` | 413 | Тело запроса больше 64 КБ: уменьшить запрос |
| `CONFIRM_HASH_MISMATCH` | 409 | Прислан хеш не от этой карточки: перезапросить карточку и показать её |
| `CONFIRMATION_INVALIDATED` | 409 | Корзина изменилась или пользователь отказался: показать карточку из последнего ответа `update_cart` или `create_cart` |
| `CONFIRMATION_EXPIRED`, `PRICE_CHANGED` | 409 | Чекаут: вызвать `create_cart` с теми же аргументами и показать новую карточку. Отмена: подготовить отмену заново (B9) |
| `STEP_UP_REQUIRED` | 403 | Запросить Face ID и повторить с `biometric` |
| `CANCELLATION_NOT_ALLOWED` | 409 | Сообщить пользователю, что заказ уже нельзя отменить |
| `PROVIDER_REJECTED` | 422 | Провайдер отказал при подтверждении: заказ не создан. Сообщить пользователю, предложить собрать заказ заново |
| `OUT_OF_STOCK`, `RESTAURANT_CLOSED`, `DELIVERY_UNAVAILABLE` | 409 | То же при подтверждении: заказ не создан, предложить другой вариант |
| `SUBMISSIONS_PAUSED`, `PROVIDER_UNAVAILABLE`, `NOT_CONFIGURED` | 503 | Заказ не создан. Сообщить пользователю, повторить позже |
| `RATE_LIMITED` | 429 | Повторить с задержкой. Лимит считается на пользователя и на эндпоинт: 600 запросов в минуту, для вызовов инструментов 120 в минуту. Отдельно: после 300 запросов в минуту с неверной подписью с одного IP такие запросы получают 429; запросы с верной подписью продолжают проходить |
| `INTERNAL` | 500 | Сбой на стороне Unyly. Повторить позже; для подтверждений повтор безопасен |
| Любая ошибка инструмента (`PLACE_NOT_FOUND`, `PLACE_AMBIGUOUS`, `VALIDATION_FAILED` в аргументах и другие) | 422 | Смотреть `error.code` и `error.user_action`; для мест варианты лежат в `error.details.suggestions` |

Неизвестный исход отправки заказа не считается ошибкой: подтверждение вернёт 200 с `order: null` (см. B4).

Единственный ответ не в этом формате приходит от HTTP-слоя до маршрутизации: URL с испорченным процентным кодированием (например, `%ZZ`) получает 400 со своим телом.

Краткий справочник на английском лежит в репозитории: `docs/partner-api.md`. Проверка окружения одной командой: `BASE=https://unyly-food.unyly.org PARTNER_ID=ari PARTNER_SECRET=<секрет> node scripts/partner-smoke.mjs`. Скрипт проходит весь путь поездки в демо-режиме (пользователь, место, варианты, корзина, подтверждение, статус, события, отмена, формат ошибки), печатает PASS или FAIL по шагам и удаляет за собой тестового пользователя.

Готово, когда: для каждой строки таблицы есть обработчик или осознанное общее правило; ни одна ошибка Unyly не показывается пользователю как необработанное исключение; smoke-скрипт завершается строкой `RESULT: PASS`.

---

## 6. Задачи для iOS-приложения Ari

Приложение получает карточки и события от бэкенда Ari и никогда не обращается к Unyly напрямую.

### A1. Карточки `unyly.card.v1`
Нативный SwiftUI-рендер карточек. Общие поля: `schema` (всегда `unyly.card.v1`), `type`, `id`, `service` (`food`, `mart`, `ride`, `express`), `title`, `subtitle`, `badges[]`, `demo`, `footnote`, `actions[]`. Обязательные: `schema`, `type`, `id`, `title`, `demo`, `actions` (может быть пустым); остальные поля могут отсутствовать. Неизвестные поля нужно игнорировать, неизвестный `type` показывать как `title` + `subtitle`.
- При `demo: true` показывать плашку «Демо»: данные вымышлены, ничего не доставляется и не списывается.
- `options`: `route` для поездок и посылок, список `options[]` (`id`, `title`, `subtitle`, `price`, `eta`, `badges[]`). Если есть `disabled_reason`, вариант неактивен и показывает причину, поля `action` у него нет. Нажатие на активный вариант отправляет на бэкенд `action.tool` (`name`, `arguments`).
- `checkout`: `route` (`from`, `to`, `distance_km`, `minutes`; только для поездок и посылок), `lines[]` (`title`, `quantity`, `detail`, `value`), `breakdown[]` (`label`, `value`), `total` (`label`, `value`, `amount_minor`, `currency`), кнопки из `actions[]`: `kind: "confirm"` (главная) и `kind: "decline"` («Не сейчас»). Показывать `expires_at` (подтверждение действует до 15 минут). Пустой `actions` означает, что карточка закрыта (подтверждена, заменена или отклонена).
- `order`: `status` (`code`, `label`, `progress` от 0 до 1, `steps[]` из `{code, label, done}` для прогресс-бара, `eta_at`, `is_final`), `courier` (`name`, `vehicle`, `plate`, `rating`; в демо `fictional: true`; поле есть, только когда провайдер передал данные), `lines[]` (для еды и товаров), `total`, кнопка отмены `kind: "prepare_cancel"` (пока заказ можно отменить, порядок в B9).
- `cancellation`: `title`, `subtitle` с платой за отмену, `footnote` с условиями, кнопка `kind: "confirm"` (стиль `destructive`) и «Оставить заказ» (`kind: "decline"` без `endpoint`: просто закрыть карточку).
- `message`: `title` и `subtitle` с объяснением, что нужно исправить в заказе. Кнопок нет.
- `handoff`: кнопка `kind: "open_url"` открывает `url` в приложении Grab. В режимах `demo` и `live` эта карточка не приходит; достаточно общего рендера.
- Кнопки: `label` показывать как есть (он уже на языке пользователя), `style` (`primary`, `secondary`, `destructive`, `link`) задаёт вид.

Дизайн: тёмная и светлая темы, Dynamic Type, VoiceOver.

Готово, когда: примеры из раздела 9 и карточки сценариев 1-3 из раздела 7 отображаются без обрезанных полей в обеих темах; карточка с неизвестным полем не ломает экран.

### A2. Подтверждение
На кнопке `confirm`: `LAContext().evaluatePolicy(.deviceOwnerAuthentication, ...)`. Рекомендуем спрашивать Face ID всегда; обязательно, когда `requires_user_verification == "biometric"`. После успеха отправить на бэкенд `endpoint.path`, `endpoint.body.confirm_hash`, `user_verification` (`biometric` после Face ID или Touch ID, `passcode` после кода устройства, `tap` без проверки) и время нажатия. Кнопку блокировать до ответа (защита от двойного нажатия). После успеха заменить карточку `checkout` на карточку `order` из ответа. При 409 показать карточку заново (B4), при отмене Face ID оставить карточку как есть.

Готово, когда: без успешной проверки Face ID запрос подтверждения на бэкенд не уходит, если карточка требует `biometric`; двойное нажатие отправляет один запрос.

### A3. Live Activity
ActivityKit: `attributes` = `service`, `title`, `order_id`; `contentState` = `status_label`, `progress`, `eta_at`, `courier_name`, `plate`. Источники: `status_label` из `notify.title`, `progress` и `eta_at` из `notify.live_activity`, `courier_name` и `plate` из `courier` карточки заказа (если поля нет, строку не показывать). Запуск при `order.created`, обновления пушами Live Activity по событиям `order.status_changed`, завершение, когда `data.is_final` равен `true`. Компактный вид Dynamic Island: иконка сервиса и минуты до `eta_at`.

Готово, когда: демо-поездка проходит в Live Activity все шаги от «Водитель назначен» до «Поездка завершена» и активность завершается сама.

### A4. Пуши
Для событий с `level: "important"` и `"urgent"`: заголовок `notify.title`, текст `notify.body`. Нажатие открывает чат с карточкой заказа (`data.order_id`).

Готово, когда: событие `level: "info"` пуш не создаёт; нажатие на пуш открывает нужный заказ.

### A5. Звонок Ari
При `suggest_call: true` запускать существующий входящий звонок Ari и озвучивать текст, собранный бэкендом (B5). Если пользователь не ответил, отправить тот же текст сообщением в чат.

Готово, когда: в демо-поездке звонок приходит один раз, на статусе «Водитель едет к вам».

### A6. Экран «Аккаунт Grab»
В настройках: статус привязки, кнопки «Привязать» и «Отвязать» (B7), выбор страны (бэкенд отправляет `PUT /partner/v1/users/{uid}` с новым `region`), кнопка удаления данных Grab-интеграции (B8). В демо показывать пометку, что привязка симулирована (`simulated: true`).

Готово, когда: статус на экране совпадает с ответом `GET /partner/v1/users/{uid}/grab` после каждого действия.

### A7. Язык
Добавить тайский язык интерфейса (сейчас в App Store EN и RU). Тексты карточек и `notify` уже приходят на языке пользователя; собственные подписи приложения («Демо», «Подтверждено», ошибки) переводит Ari.

Готово, когда: при `locale: "th"` на экране заказа нет строк на другом языке, кроме названий из каталога.

### A8. Siri и App Intents
Intent «Ask Ari» уже есть. Добавить подсказки: «Ari, такси домой», «Ari, отправь посылку».

Готово, когда: обе фразы через Siri открывают Ari и приводят к карточке `options` (для «домой» нужно сохранённое место из B6).

---

## 7. Приёмка (демо-режим, Бангкок, все данные вымышлены)

1. «Такси от Siam Paragon до Suvarnabhumi» → карточка вариантов → выбор → карточка с итогом → Face ID → заказ → Live Activity → пуш «Водитель назначен» (из `order.created`) → звонок Ari «Водитель едет к вам» → «Поездка завершена». Вся цепочка занимает 2-3 минуты.
2. При сохранённом месте «Дом»: «ужин на двоих до 600 бат без орехов» → карточка с ресторанами, у подходящих бейдж «В бюджете» → выбор → итог со сборами → подтверждение → статусы.
3. «Отправь посылку 3 кг в ICONSIAM» (откуда: Siam Paragon) → варианты курьера → заказ → отмена с платой 0 бат (сразу) или 20 бат (когда курьер уже едет).
4. Сообщение «да, заказывай» без нажатия кнопки не создаёт заказ.
5. Изменение корзины после показа карточки → подтверждение старой карточки даёт 409 `CONFIRMATION_INVALIDATED` → приложение показывает новую карточку с новой ценой из ответа `update_cart`.
6. Корзина еды на сумму от 2 000 бат → карточка требует `biometric` → подтверждение только с Face ID.
7. Отключение приёмника вебхуков Ari на 10 минут → после включения события догружаются через `/events?after=<seq>`, дубликатов пушей нет.
8. Удаление аккаунта Ari → `DELETE /partner/v1/users/{uid}` → повторный `GET` даёт 404.
9. `scripts/partner-smoke.mjs` с секретом Ari завершается строкой `RESULT: PASS`.

## 8. Оценка

| Блок | Оценка |
|---|---|
| Бэкенд B1-B10 | 4-6 рабочих дней |
| iOS A1-A2 | 4-5 дней |
| iOS A3-A5 | 3-4 дня |
| iOS A6-A8 | 2-3 дня |
| Совместное тестирование | 2 дня |

Итого 2-3 недели для одного бэкенд- и одного iOS-разработчика. Оценка относится к демо-режиму. Контакт по API: alxvasilevv@gmail.com.

## 9. Приложение: примеры

Все примеры взяты из демо-режима: названия, цены, водитель и номер машины вымышлены.

Карточка `checkout`:
```json
{
  "schema": "unyly.card.v1", "type": "checkout", "id": "3da8821e-...", "service": "ride", "title": "JustGrab", "demo": true,
  "badges": ["Demo: nothing is delivered or charged"],
  "route": { "from": "Siam Paragon", "to": "Suvarnabhumi Airport (BKK)", "distance_km": 32.5, "minutes": 52 },
  "lines": [{ "title": "JustGrab", "quantity": 1, "value": "฿421.00" }],
  "breakdown": [{ "label": "Items", "value": "฿421.00" }],
  "total": { "label": "Total", "value": "฿421.00", "amount_minor": 42100, "currency": "THB" },
  "actions": [
    { "id": "confirm", "kind": "confirm", "style": "primary", "label": "Confirm ride · ฿421.00", "requires_user_verification": "tap",
      "endpoint": { "method": "POST", "path": "/partner/v1/users/u_1/checkouts/3da8821e-.../confirm", "body": { "confirm_hash": "3439d5c9..." } } },
    { "id": "decline", "kind": "decline", "style": "secondary", "label": "Not now",
      "endpoint": { "method": "POST", "path": "/partner/v1/users/u_1/checkouts/3da8821e-.../decline" } }
  ],
  "footnote": "Demo wallet (no real charge) · ...",
  "expires_at": "2026-11-16T09:15:00.000Z"
}
```

Ответ подтверждения (`POST .../checkouts/{cid}/confirm`), карточка `order` внутри:
```json
{
  "ok": true,
  "checkout": { "checkout_id": "3da8821e-...", "mode": "demo", "status": "consumed", "order_id": "ea755fce-...",
                "submission": { "status": "accepted", "message": "The provider accepted the order." }, "summary": "The provider accepted the order." },
  "order": {
    "id": "ea755fce-...",
    "card": {
      "schema": "unyly.card.v1", "type": "order", "id": "ea755fce-...", "service": "ride", "title": "JustGrab",
      "subtitle": "Siam Paragon → Suvarnabhumi Airport (BKK)", "demo": true, "badges": ["Demo: nothing is delivered or charged"],
      "total": { "label": "Total", "value": "฿421.00", "amount_minor": 42100, "currency": "THB" },
      "status": { "code": "accepted", "label": "Driver assigned", "progress": 0.3, "is_final": false, "eta_at": "2026-11-16T09:04:00.000Z",
                  "steps": [{ "code": "accepted", "label": "Driver assigned", "done": true }, { "code": "preparing", "label": "Driver arriving", "done": false },
                            { "code": "picked_up", "label": "On trip", "done": false }, { "code": "delivered", "label": "Arrived", "done": false }] },
      "courier": { "name": "Somchai P.", "vehicle": "Toyota Corolla Altis, silver", "plate": "3กข 1234", "rating": 4.9, "fictional": true },
      "actions": [{ "id": "cancel", "kind": "prepare_cancel", "style": "destructive", "label": "Cancel order",
                    "endpoint": { "method": "POST", "path": "/partner/v1/users/u_1/orders/ea755fce-.../cancel" } }],
      "footnote": "Driver and plate are fictional in the demo."
    }
  }
}
```

Событие вебхука (тот же объект возвращает `GET .../events`), пользователь с `locale: "ru"`:
```json
{
  "event_id": "4f2c...", "seq": 1042, "type": "order.status_changed", "partner_id": "ari", "user_id": "u_1", "created_at": "2026-11-16T09:01:10.000Z",
  "data": { "order_id": "ea755fce-...", "service": "ride", "status": "preparing", "is_final": false, "eta_at": "2026-11-16T09:04:00.000Z", "status_label": "Driver arriving" },
  "notify": { "title": "Водитель едет к вам", "body": "Водитель уже едет к точке посадки.", "level": "urgent", "suggest_call": true,
              "live_activity": { "state": "preparing", "progress": 0.5, "eta_at": "2026-11-16T09:04:00.000Z" } }
}
```

Ошибка инструмента (HTTP 422):
```json
{
  "ok": false, "mode": "demo", "operation_id": "70ce16fa-...",
  "error": { "code": "PLACE_AMBIGUOUS", "message": "dropoff: Bangkok has two airports. Ask the user which one.",
             "details": { "field": "dropoff", "suggestions": ["Suvarnabhumi Airport (BKK)", "Don Mueang Airport (DMK)"] },
             "user_action": "Ask the user which place they mean (...). Do not pick one for them." },
  "next_actions": [{ "tool": "estimate_trip", "why": "Retry with the place the user chooses" }],
  "notices": ["DEMO MODE: ..."], "card": null
}
```

Статусы заказа (`status.code`, `data.status`, `live_activity.state`): `submitted`, `accepted`, `preparing`, `picked_up`, `delivered`, `cancelled`, `failed`. Финальные: `delivered`, `cancelled`, `failed`. Подписи на языке пользователя приходят в `status.label` и `notify.title`.
