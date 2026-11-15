# ARI × Grab: техническое задание для команды Ari

Версия 1.0, 16 ноября 2026. Сторона Unyly (движок интеграции с Grab) готова и работает в демо-режиме: https://unyly-food.unyly.org/ari. Этот документ описывает, что нужно сделать в бэкенде Ari и в iOS-приложении Ari, чтобы пользователи заказывали сервисы Grab прямо в Ari.

Описание API в формате OpenAPI 3.1: https://unyly-food.unyly.org/partner/v1/openapi.json
Обзор для разработчиков: https://unyly-food.unyly.org/developers

---

## 1. Что получит пользователь

1. Говорит или пишет Ari: «такси от Siam Paragon до аэропорта», «ужин на двоих до 600 бат без орехов», «отправь посылку 3 кг в ICONSIAM», «розы с открыткой», «парацетамол и пластыри».
2. Ari показывает варианты (карточка `options`), пользователь выбирает.
3. Ari показывает карточку `checkout` со всеми строками, сборами и итогом.
4. Пользователь нажимает «Подтвердить». Приложение проверяет Face ID (обязательно для крупных сумм, рекомендуется всегда).
5. Заказ оформлен. Статус показывается в Live Activity (Dynamic Island) и в карточке `order`, приходят пуши. Когда водитель подъезжает, Ari сама звонит пользователю: «Ваш водитель Somchai на серебристой Toyota, номер 3กข 1234, уже у входа».
6. Можно отменить заказ: карточка `cancellation` с платой за отмену и подтверждение.

Главное правило: заказ создаётся только нажатием пользователя на карточку в приложении. Ответ «да» в чате или решение LLM заказ не создаёт никогда.

## 2. Кто за что отвечает

| Компонент | Отвечает за |
|---|---|
| iOS-приложение Ari | Отрисовка карточек, кнопки, Face ID, Live Activity, пуши, звонок Ari, экран «Аккаунт Grab» |
| Бэкенд Ari | LLM и вызов инструментов, подпись запросов к Unyly, приём вебхуков, рассылка пушей и обновлений Live Activity, запуск звонка |
| Unyly (готово) | Инструменты, цены и маршруты, карточки, проверка подтверждения, заказы в Grab, статусы, отмены, события, безопасность |
| Grab | API: GrabExpress, Farefeed, Login with Grab, GrabPay и другие (доступ выдаёт Grab) |

Схема: `iPhone (Ari) → бэкенд Ari → Unyly Partner API → API Grab`. Приложение никогда не ходит в Unyly напрямую: секрет партнёра хранится только на бэкенде Ari.

## 3. Доступы и окружение

Unyly выдаёт команде Ari:

| Параметр | Значение |
|---|---|
| Базовый URL | `https://unyly-food.unyly.org` |
| `partner_id` | `ari` |
| `partner_secret` | 64 символа, передаётся отдельно защищённым каналом, хранить в KMS или secret manager |
| `webhook_secret` | для проверки вебхуков от Unyly, передаётся отдельно |
| Режим | `demo` (вымышленные магазины и цены Бангкока). `live` включается по мере выдачи ключей Grab, без изменений на стороне Ari |

Команда Ari сообщает Unyly адрес вебхука (HTTPS), например `https://api.ari.app/webhooks/unyly`.

## 4. Подпись запросов (обязательно для каждого запроса)

Заголовки:

```
X-Unyly-Partner: ari
X-Unyly-Timestamp: <unix-время в секундах>        допуск ±300 секунд
X-Unyly-Nonce: <16-64 символа [A-Za-z0-9_-]>      одноразовый, новый на каждый запрос
X-Unyly-Signature: v1=<hex HMAC-SHA256>
Content-Type: application/json                     если есть тело
```

Строка для подписи (разделитель `\n`):

```
v1
<МЕТОД В ВЕРХНЕМ РЕГИСТРЕ>
<путь с query ровно как в запросе, например /partner/v1/users/u_1/events?after=12>
<X-Unyly-Timestamp>
<X-Unyly-Nonce>
<hex(sha256(сырое тело запроса)); для пустого тела sha256 от пустой строки>
```

Подпись: `v1=` + hex(HMAC_SHA256(partner_secret, строка)). Подписываются ровно те байты, которые уходят в теле.

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

Проверка: `GET /partner/v1/ping` отвечает `{"ok": true, "partner": "ari", "mode": "demo"}`. Любая ошибка подписи даёт 401 `PARTNER_AUTH_FAILED` без подробностей.

---

## 5. Задачи для бэкенда Ari

### B1. Клиент Unyly
Модуль с функцией подписи из раздела 4, таймаут 15 секунд, логирование метода, пути, статуса и `operation_id` из ошибок. Секрет только из secret manager.
Готово, когда: `ping` проходит из staging и prod Ari.

### B2. Пользователь
При первом запросе пользователя, связанном с Grab, вызвать `PUT /partner/v1/users/{uid}` с телом `{"locale": "th", "region": "TH", "display_name": "Alex"}`.
- `uid`: стабильный внутренний id пользователя Ari (1-128 символов `[A-Za-z0-9._:@-]`), не телефон и не email.
- `locale`: `en, th, vi, id, ms, fil, km, my, zh, ru`. `region`: `TH, SG, MY, ID, VN, PH, KH, MM`.
- Повторный вызов обновляет язык и регион (ответ 200, первый раз 201).
Готово, когда: смена языка в Ari меняет язык карточек.

### B3. Инструменты для LLM
1. При старте (и раз в сутки) загрузить `GET /partner/v1/tools`: в ответе `instructions` (добавить в системный промпт Ari, когда пользователь говорит о Grab) и `tools[]` с `name`, `description`, `input_schema` (JSON Schema). Формат подходит для tool calling OpenAI и Anthropic без изменений.
2. Вызов инструмента моделью: `POST /partner/v1/users/{uid}/tools/{name}` с телом `{"arguments": {...}}`.
3. Ответ: `ok`, `mode`, `result` (данные для модели), `next_actions`, `notices`, `card` (для приложения). Модели отдавать `result`, `next_actions`, `notices`; приложению отдавать `card`.
4. При `ok: false` (HTTP 422) модели отдать `error.code`, `error.message`, `error.user_action`: там написано, что спросить у пользователя.
5. Основные пути: еда и магазины `search_stores` → `create_cart {store_id, items}`; поездка и посылка `estimate_trip` → `create_cart {service, pickup, dropoff, items:[{item_id, quantity:1}]}`. После `create_cart` приходит карточка `checkout`.
6. Если пользователь выбирает вариант нажатием на карточку `options`, приложение присылает `action.tool` (имя и готовые аргументы), бэкенд вызывает этот инструмент напрямую, без LLM.
Готово, когда: «такси до аэропорта» в Ari показывает карточку вариантов, выбор показывает карточку с итогом.

### B4. Подтверждение заказа (критично для безопасности)
Эндпоинт бэкенда Ari, который вызывает только приложение после нажатия кнопки:
```
POST /partner/v1/users/{uid}/checkouts/{checkout_id}/confirm
{"confirm_hash": "<из action.endpoint.body карточки>", "user_verification": "biometric", "confirmed_at": "<время нажатия ISO 8601>", "device_id": "<id устройства>"}
```
- `user_verification`: `biometric` (Face ID / Touch ID), `passcode` или `tap`. Если в карточке `requires_user_verification: "biometric"`, то `tap` вернёт 403 `STEP_UP_REQUIRED`.
- `confirm_hash` привязывает подтверждение к той цене и составу, которые видел пользователь. Если корзина изменилась, вернётся 409 `CONFIRM_HASH_MISMATCH`: нужно запросить `GET .../checkouts/{id}` и показать новую карточку.
- Повторный вызов безопасен: вернёт тот же заказ, второй заказ не создаётся.
- Модель (LLM) не должна иметь доступа к этому вызову. Только нажатие пользователя в приложении.
- «Не сейчас»: `POST .../checkouts/{id}/decline`.
- Ответ: `checkout` (статус) и `order: {id, card}`. Live GrabPay: дополнительно `payment.pay_url`, его открыть в `ASWebAuthenticationSession`.
Готово, когда: заказ создаётся только кнопкой; сообщение «да» в чат заказ не создаёт (проверить тестом).

### B5. Вебхуки от Unyly
Принимать `POST` на адрес вебхука. Заголовки: `X-Unyly-Event`, `X-Unyly-Delivery` (id события), `X-Unyly-Partner`, `X-Unyly-Timestamp`, `X-Unyly-Nonce`, `X-Unyly-Signature`. Подпись проверяется по той же схеме (раздел 4) с `webhook_secret` и путём вашего вебхука.
1. Проверить подпись и время (±300 с), иначе 401.
2. Дедупликация по `event_id`.
3. Ответить 2xx быстро (до 5 секунд), обработку вести асинхронно. При ошибке Unyly повторит до 12 раз с экспоненциальной задержкой.
4. Типы: `order.created`, `order.status_changed`, `checkout.confirmed`, `cancellation.confirmed`, `grab.linked`, `grab.unlinked`.
5. Поле `notify` уже локализовано на язык пользователя:
   - `level: "info"`: только обновить Live Activity и карточку.
   - `level: "important"`: обычный пуш `title` + `body`.
   - `level: "urgent"` и `suggest_call: true`: пуш и звонок Ari пользователю (существующая функция «Ari звонит»), текст звонка собрать из `notify.body` и карточки заказа (`courier.name`, `courier.vehicle`, `courier.plate`).
   - `live_activity: {state, progress (0..1), eta_at}`: обновление Live Activity через APNs.
6. Резервный путь: `GET /partner/v1/users/{uid}/events?after=<seq>` возвращает те же события. Использовать для восстановления после простоя.
Готово, когда: статусы заказа приходят в приложение без опроса, при «Водитель едет к вам» Ari звонит.

### B6. Места пользователя
Адреса доставки и ярлыки «Дом», «Работа» из памяти Ari передавать в `POST /partner/v1/users/{uid}/places` (`label`, `line1`, `district`, `city`, `country`, `instructions`, `is_default`). Список `GET .../places`, удаление `DELETE .../places/{place_id}`. После этого пользователь может сказать «такси домой».

### B7. Аккаунт Grab
`POST /partner/v1/users/{uid}/grab/link`. В демо аккаунт связывается сразу (симуляция). В live возвращается `authorize_url` (Login with Grab, OAuth 2.0 PKCE): открыть его в `ASWebAuthenticationSession`; после возврата проверить `GET .../grab`. Отвязка `DELETE .../grab`. Пароли и OTP Grab Ari не видит никогда.

### B8. Удаление данных
При удалении аккаунта Ari вызвать `DELETE /partner/v1/users/{uid}`: удаляет все данные пользователя в Unyly (PDPA, GDPR).

### B9. Обработка ошибок
| Код | HTTP | Что делать |
|---|---|---|
| `PARTNER_AUTH_FAILED` | 401 | Проверить часы сервера, секрет и путь в подписи |
| `NOT_FOUND` | 404 | Сначала `PUT /users/{uid}` |
| `VALIDATION_FAILED` | 400 | Исправить аргументы (сообщение называет поле) |
| `CONFIRM_HASH_MISMATCH` | 409 | Перезапросить карточку, показать новую цену |
| `STEP_UP_REQUIRED` | 403 | Запросить Face ID и повторить с `biometric` |
| `CONFIRMATION_EXPIRED`, `PRICE_CHANGED`, `CONFIRMATION_INVALIDATED` | 409 | Создать корзину заново (модель сама вызовет `quote_cart` или `create_cart`) |
| `PLACE_NOT_FOUND`, `PLACE_AMBIGUOUS` | 404, 409 | Спросить пользователя, в `details.suggestions` варианты |
| `SUBMISSION_UNKNOWN` | 202 | Не создавать заказ повторно, ждать события |
| `SUBMISSIONS_PAUSED`, `PROVIDER_UNAVAILABLE` | 503 | Сообщить пользователю, повторить позже |
| `RATE_LIMITED` | 429 | Повторить с задержкой |

---

## 6. Задачи для iOS-приложения Ari

### A1. Карточки `unyly.card.v1`
Нативный SwiftUI-рендер карточек. Общие поля: `type`, `title`, `subtitle`, `badges[]`, `demo` (показывать плашку «Демо»), `footnote`, `actions[]`.
- `options`: список `options[]` (`title`, `subtitle`, `price`, `eta`, `badges[]`). Если есть `disabled_reason`, вариант неактивен и показывает причину. Нажатие отправляет на бэкенд `action.tool`.
- `checkout`: `route` (откуда, куда, км), `lines[]` (`title`, `quantity`, `value`), `breakdown[]`, `total`, кнопки из `actions[]`: `kind: confirm` (главная), `kind: decline` («Не сейчас»). Показывать `expires_at` (подтверждение действует до 15 минут).
- `order`: `status` (`label`, `progress`, `steps[]` для прогресс-бара, `eta_at`, `is_final`), `courier` (`name`, `vehicle`, `plate`, `rating`; в демо `fictional: true`), `total`, кнопка отмены `kind: prepare_cancel`.
- `cancellation`: текст с платой, кнопка `kind: confirm` (destructive) и «Оставить заказ».
- `handoff`: кнопка `kind: open_url` открывает приложение Grab с подготовленным заказом.
- `message`: текст, что нужно поправить.
Дизайн: тёмная и светлая темы, Dynamic Type, VoiceOver.

### A2. Подтверждение
На кнопке `confirm`: `LAContext().evaluatePolicy(.deviceOwnerAuthentication, ...)`. Рекомендуем спрашивать Face ID всегда; обязательно, когда `requires_user_verification == "biometric"`. После успеха отправить на бэкенд `checkout_id`, `confirm_hash`, `user_verification`, время нажатия. Кнопку блокировать до ответа (защита от двойного нажатия). После успеха заменить кнопки на «Подтверждено».

### A3. Live Activity
ActivityKit: `attributes` = `service`, `title`, `order_id`; `contentState` = `status_label`, `progress`, `eta_at`, `courier_name`, `plate`. Запуск при `order.created`, обновления пушами Live Activity по событиям `order.status_changed`, завершение при `is_final`. Компактный вид Dynamic Island: иконка сервиса и минуты до прибытия.

### A4. Пуши
Для событий с `level: important` и `urgent`. Нажатие открывает чат с карточкой заказа.

### A5. Звонок Ari
При `suggest_call: true` запускать существующий входящий звонок Ari и озвучивать текст. Если пользователь не ответил, отправить сообщение в чат.

### A6. Экран «Аккаунт Grab»
В настройках: статус связи (`GET .../grab`), «Привязать» и «Отвязать», выбор страны, ссылка на удаление данных.

### A7. Язык
Добавить тайский язык интерфейса (сейчас в App Store EN и RU). Тексты карточек уже приходят на языке пользователя.

### A8. Siri и App Intents
Intent «Ask Ari» уже есть. Добавить подсказки: «Ari, такси домой», «Ari, отправь посылку».

---

## 7. Приёмка (демо-режим, Бангкок)

1. «Такси от Siam Paragon до Suvarnabhumi» → карточка вариантов → выбор → карточка с итогом → Face ID → заказ → Live Activity → пуш «Водитель назначен» → звонок Ari «Водитель едет к вам» → «Поездка завершена».
2. «Ужин на двоих до 600 бат без орехов» → 3 ресторана с пометкой бюджета → выбор → итог со сборами → подтверждение → статусы.
3. «Отправь посылку 3 кг в ICONSIAM» → варианты курьера → заказ → отмена с платой 0 или 20 бат.
4. Сообщение «да, заказывай» без нажатия кнопки не создаёт заказ.
5. Изменение корзины после показа карточки → 409 → приложение показывает новую цену.
6. Сумма выше порога (2 000 бат) → подтверждение только с Face ID.
7. Отключение бэкенда Ari на 10 минут → после включения события догружаются через `/events`.
8. Удаление аккаунта Ari → `DELETE /users/{uid}` → повторный запрос даёт 404.

## 8. Оценка

| Блок | Оценка |
|---|---|
| Бэкенд B1-B9 | 4-6 рабочих дней |
| iOS A1-A2 | 4-5 дней |
| iOS A3-A5 | 3-4 дня |
| iOS A6-A8 | 2-3 дня |
| Совместное тестирование | 2 дня |

Итого 2-3 недели для одного бэкенд- и одного iOS-разработчика. Сторона Unyly готова; контакт по API: alxvasilevv@gmail.com.

## 9. Приложение: примеры

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

Событие вебхука:
```json
{
  "event_id": "4f2c...", "type": "order.status_changed", "partner_id": "ari", "user_id": "u_1", "created_at": "...",
  "data": { "order_id": "...", "service": "ride", "status": "preparing", "is_final": false, "eta_at": "...", "status_label": "Driver arriving" },
  "notify": { "title": "Водитель едет к вам", "body": "Водитель уже едет к точке посадки.", "level": "urgent", "suggest_call": true,
              "live_activity": { "state": "preparing", "progress": 0.5, "eta_at": "..." } }
}
```

Статусы заказа (`status`): `submitted`, `accepted`, `preparing`, `picked_up`, `delivered`, `cancelled`, `failed`. Подписи на языке пользователя приходят в `status.label` и `notify.title`.
