# Черновик обращения в Grab (НЕ ОТПРАВЛЕН)

Куда: форма «Get In Touch» на developer.grab.com (категория Food) и/или partnerapp.partnerships@grabtaxi.com.
Перед отправкой: проверить формулировки, указать юрлицо, контакты и ожидаемые объёмы.

---

**Subject:** Partnership request: AI-assistant ordering for GrabFood customers (Thailand)

Hello Grab Partnerships team,

We are building Unyly, a service that lets people order food through AI assistants (ChatGPT, Claude and other clients that support the Model Context Protocol). The assistant helps the customer choose dishes within a budget and dietary constraints, and the customer confirms every order on a secure confirmation page before anything is placed. We never ask for Grab passwords, OTPs or card details, and we do not automate the Grab app or scrape Grab data.

Today we run a demo with synthetic data and a hand-off flow that sends users to food.grab.com to complete orders themselves. We would like to offer a proper integration in Thailand first, and we would appreciate information on the following:

1. Is there an API (partner, affiliate or consumer-ordering) that lets an approved partner search GrabFood merchants, read menus with modifiers and availability, get a full price quote (items, delivery and platform fees, promotions), and create an order on behalf of a signed-in Grab user?
2. Which GrabID (Login with Grab) scopes would such an integration require, and what is the onboarding process for them?
3. How would payment work: a hosted Grab checkout/confirmation page, or tokenised GrabPay?
4. Order lifecycle: status webhooks, their signature scheme, and cancellation/refund endpoints for customer orders.
5. Idempotency: can partners pass an idempotency key when creating an order, or look an order up by the partner's reference? We use this to avoid duplicate orders after network timeouts.
6. Officially supported deep links to open a specific GrabFood merchant, or a pre-filled cart, in the Grab app.
7. Sandbox access and certification requirements, plus any rate limits.
8. Commercial terms (affiliate/referral commission) and brand guidelines for mentioning Grab.

We are also interested in the Partner Apps programme if that is the preferred route.

Thank you,
<name, role>
<company / legal entity>
<email, phone>
Unyly - <website>

---

**Минимальный перечень доступов для Live:**
- consumer-ordering API (или его эквивалент): поиск, меню, quote, create order, get order, cancel;
- GrabID scopes для заказов от имени пользователя и зарегистрированные redirect URI;
- способ оплаты и подтверждения платежа;
- webhooks статусов с подписью и схемой повторов;
- idempotency key или lookup по ссылке партнёра;
- sandbox с тестовыми мерчантами в TH;
- разрешение на использование бренда и формулировки о партнёрстве.
