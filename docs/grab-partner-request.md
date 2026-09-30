# Черновик обращения в Grab (НЕ ОТПРАВЛЕН)

Статус: **черновик, никуда не отправлялся**. Партнёрства с Grab нет, ответа от Grab нет.

Куда: форма «Get In Touch» на developer.grab.com (категории Food, Transport и Express) и/или partnerapp.partnerships@grabtaxi.com; вопрос про ключи GrabExpress - в отдел продаж Grab (бизнес-аккаунт).
Перед отправкой: проверить формулировки, указать юрлицо, контакты и ожидаемые объёмы.

---

**Subject:** Partnership request: AI-assistant ordering for Grab customers (Food, Mart, Transport, Express; Thailand)

Hello Grab Partnerships team,

We are building Unyly, a service that lets people use Grab through AI assistants (ChatGPT, Claude, Gemini and other clients that support the Model Context Protocol): food delivery, GrabMart (groceries, flowers, household pharmacy items, cakes), rides and parcels. The assistant helps the customer choose within a budget and dietary constraints, or pick a vehicle for a trip, and the customer confirms every order on a secure confirmation page before anything is placed. We never ask for Grab passwords, OTPs or card details, and we do not automate the Grab app or scrape Grab data.

Today we run a demo with synthetic Bangkok data for all four services and a hand-off flow that sends users to the official Grab pages (Food, Mart, Transport, Express) to complete orders themselves. We would like to offer a proper integration in Thailand first, and we would appreciate information on the following:

1. Is there an API (partner, affiliate or consumer-ordering) that lets an approved partner search GrabFood and GrabMart merchants, read menus or catalogues with modifiers and availability, get a full price quote (items, delivery and platform fees, promotions), and create an order on behalf of a signed-in Grab user?
2. Ride booking: is there a partner API to get fare estimates for vehicle types between two points and book a ride on behalf of a signed-in Grab user, with driver status updates and cancellation?
3. GrabExpress: we would like sandbox keys for the GrabExpress Delivery API for a business account, and the steps to production access in Thailand. Parcels could be our first live service.
4. Which GrabID (Login with Grab) scopes would such an integration require, and what is the onboarding process for them?
5. How would payment work: a hosted Grab checkout/confirmation page, or tokenised GrabPay?
6. Order lifecycle: status webhooks, their signature scheme, and cancellation/refund endpoints for customer orders.
7. Idempotency: can partners pass an idempotency key when creating an order, or look an order up by the partner's reference? We use this to avoid duplicate orders after network timeouts.
8. Officially supported deep links to open a specific merchant, a pre-filled cart, or a pre-filled pickup and drop-off in the Grab app.
9. Sandbox access and certification requirements, plus any rate limits.
10. Commercial terms (affiliate/referral commission) and brand guidelines for mentioning Grab.

We are also interested in the Partner Apps programme if that is the preferred route.

Thank you,
<name, role>
<company / legal entity>
<email, phone>
Unyly - <website>

---

**Минимальный перечень доступов для Live:**
- consumer-ordering API для Food и Mart (или его эквивалент): поиск, меню и каталог, quote, create order, get order, cancel;
- API бронирования поездок: оценка тарифа по типам машин, бронирование от имени пользователя, статус водителя, отмена;
- ключи sandbox GrabExpress Delivery API для бизнес-аккаунта и порядок выхода в production в TH;
- GrabID scopes для заказов от имени пользователя и зарегистрированные redirect URI;
- способ оплаты и подтверждения платежа;
- webhooks статусов с подписью и схемой повторов;
- idempotency key или lookup по ссылке партнёра;
- sandbox с тестовыми мерчантами и поездками в TH;
- разрешение на использование бренда и формулировки о партнёрстве.
