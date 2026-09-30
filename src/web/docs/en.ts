// User-facing documentation, English source. ru.ts and th.ts are translations of this file:
// keep section ids, subheading ids, code blocks, URLs and tool names unchanged when translating.
import type { DocMeta, DocSection } from './types.js';

export const META_EN: DocMeta = {
  title: "Unyly documentation",
  description: "How Unyly works: connect an AI assistant, prepare Grab orders, confirm them yourself, and the MCP tools, errors, limits and data behind it.",
  updated: "2026-09-30",
  labels: { info: "Note", warn: "Important", safety: "Safety", contents: "Contents", updated: "Updated" },
};

const MCP_URL = "https://unyly-food.unyly.org/mcp";

export const DOCS_EN: DocSection[] = [
  // ------------------------------------------------------------------ Overview
  {
    id: "overview",
    title: "Overview",
    summary: "Unyly lets your AI assistant prepare Grab orders. You always confirm them yourself.",
    blocks: [
      { type: "paragraph", text: "**Unyly** is a remote MCP server with a website. It connects AI assistants such as ChatGPT, Claude, Gemini, Microsoft Copilot, Perplexity, Grok, Mistral Le Chat, or any MCP client running DeepSeek, Qwen or Llama models, to Grab services: food delivery, groceries, flowers, pharmacy household remedies, cakes, rides and parcels." },
      { type: "paragraph", text: "You write one message, for example `Dinner for two under 600 baht, no nuts`. The assistant finds options that fit your budget and restrictions, builds the cart or the trip, and shows the full price with every fee. Nothing is ordered until **you** press Confirm on an Unyly page. A message from the model saying that you agree never counts as confirmation." },
      { type: "callout", kind: "warn", text: "Unyly is an independent concept brand. It is **not affiliated with, endorsed by or a partner of Grab**. Grab and the names of its services belong to their owners. Real Grab orders through Unyly are not available today, see [Modes](#modes)." },
      { type: "paragraph", text: "What you can do today:" },
      { type: "list", items: [
        "**Demo mode**: the complete flow for every service on synthetic Bangkok data, from search to delivery status and cancellation. Nothing is delivered, driven or charged.",
        "**Handoff mode**: the assistant writes your list or route, and Unyly gives you the official Grab page for that service plus a checklist. You order and pay inside Grab yourself.",
        "**Try it in the browser** without an account at [/try](/try): the guided demo calls the same tools an assistant would.",
      ] },
    ],
  },

  // ------------------------------------------------------------------ How it works
  {
    id: "how-it-works",
    title: "How it works",
    summary: "From one chat message to a confirmed order, in six steps.",
    blocks: [
      { type: "steps", items: [
        { title: "Ask your assistant", text: "Write what you need in your own words and language: `12 red roses with a card`, `Taxi from Siam Paragon to Suvarnabhumi`, `Send a 3 kg parcel to ICONSIAM`." },
        { title: "Get options", text: "For food and shops the assistant calls `search_stores` and receives stores with a suggested order, an estimated total and an allergen check. For rides and parcels it calls `estimate_trip` and receives vehicle options with estimated fares." },
        { title: "Build the cart", text: "After you choose, the assistant calls `create_cart`. One cart belongs to one store or one trip." },
        { title: "See the full price", text: "The same call returns the binding quote: items or fare, delivery fee, service fee, small-order fee, discount, total, ETA and any blocking issues, plus a one-time confirmation link." },
        { title: "You confirm on Unyly", text: "Open the link, sign in if needed, and review the store or route, items, options, address, every amount, payment method, cancellation terms and expiry time. Press **Confirm** to place the order, or **Decline**." },
        { title: "Follow the status", text: "The assistant calls `get_checkout_status` and then `get_order_status`, or you open [Orders](/app/orders). Status comes from the provider and is never invented." },
      ] },
      { type: "callout", kind: "info", text: "Pressing Confirm on the Unyly page places the order immediately. The assistant does not need to do anything else except check the result." },
    ],
  },

  // ------------------------------------------------------------------ Services
  {
    id: "services",
    title: "Services",
    summary: "Four Grab services over one flow: food, mart, ride and express.",
    blocks: [
      { type: "table", header: ["Service", "What it covers", "How the assistant finds it"], rows: [
        ["**Food**", "Restaurant delivery", "`search_stores` with `service: food`"],
        ["**Mart**", "Supermarket, convenience store, flowers, pharmacy (household remedies only), cakes", "`search_stores` with `service: mart` and a `category`"],
        ["**Ride**", "GrabBike, JustGrab, GrabTaxi, GrabCar Premium, GrabCar SUV, GrabVan", "`estimate_trip` with `service: ride`"],
        ["**Express**", "Parcels by bike, car, SUV or pickup truck", "`estimate_trip` with `service: express`"],
      ] },
      { type: "subheading", text: "Food", id: "services-food" },
      { type: "paragraph", text: "Results can include a suggested order for your party size and budget, with an estimated total and a mark when it fits the budget. Dishes can have required options (for example spice level); the assistant must ask you instead of choosing. Allergen information is only what the restaurant declared, see [Confirmation and safety](#safety)." },
      { type: "subheading", text: "Mart: groceries, flowers, pharmacy, cakes", id: "services-mart" },
      { type: "list", items: [
        "**Supermarket and convenience**: everyday goods with prices and availability.",
        "**Flowers**: wrapping is a required option; the card message goes in the item note.",
        "**Pharmacy**: household remedies only. No prescription medicines, no dosing advice beyond the label, and a per-order limit on each item.",
        "**Cakes**: the inscription goes in the item note.",
      ] },
      { type: "paragraph", text: "A food or mart order can be sent as a gift to someone else: the assistant passes the recipient's name, phone and address with `deliver_to`. The address is saved as a one-off address in your account (never the default) and shown on the confirmation page." },
      { type: "subheading", text: "Ride", id: "services-ride" },
      { type: "table", header: ["Vehicle", "Seats"], rows: [
        ["GrabBike", "1"], ["JustGrab", "4"], ["GrabTaxi (metered, the final fare may differ)", "4"], ["GrabCar Premium", "4"], ["GrabCar SUV", "6"], ["GrabVan", "10"],
      ] },
      { type: "paragraph", text: "In Demo the fare is a formula: base fare plus per-kilometre and per-minute rates, with a 50 THB fee for an airport pickup. Options that fit your number of passengers and cost less come first." },
      { type: "subheading", text: "Express (parcels)", id: "services-express" },
      { type: "table", header: ["Vehicle", "Maximum weight"], rows: [
        ["Bike", "20 kg"], ["Car", "100 kg"], ["SUV", "200 kg"], ["Pickup truck", "300 kg"],
      ] },
      { type: "paragraph", text: "The parcel weight is required. If the parcel is too heavy for the chosen vehicle, the quote names the smallest vehicle that fits, and the assistant asks you before switching." },
      { type: "subheading", text: "What the assistant asks you", id: "services-questions" },
      { type: "list", items: [
        "Only the details that are missing: which airport when you just say `airport`, the parcel weight, a choice for each required option.",
        "Places can be landmarks, districts or the names of your saved addresses (`Home`, `Office`), in any of the ten interface languages.",
        "If a place is ambiguous or not found, the assistant lists the suggestions and lets you pick. It must not pick for you.",
      ] },
    ],
  },

  // ------------------------------------------------------------------ Modes
  {
    id: "modes",
    title: "Modes: Demo, Handoff, Live",
    summary: "Your account is in exactly one mode. Every tool result says which.",
    blocks: [
      { type: "table", header: ["Mode", "Status", "What happens"], rows: [
        ["**Demo**", "Available", "Synthetic Bangkok stores, fares and orders. The full flow for every service: search, cart, quote, confirmation, submission, status timeline, cancellation. Payment status is `not_charged_demo`."],
        ["**Handoff**", "Available", "The assistant writes your list (store and items, or pickup and drop-off). Unyly returns the official Grab page for the service and a checklist. No order is created; you order and pay in Grab, and Unyly cannot see the outcome."],
        ["**Live**", "Not available", "Real Grab orders placed by Unyly on your behalf. Every Live capability returns `CAPABILITY_UNAVAILABLE` with the reason."],
      ] },
      { type: "subheading", text: "Why Live is not available", id: "modes-live" },
      { type: "paragraph", text: "Grab does not publish an API that lets a third party search stores, price a cart, place and pay for a GrabFood or GrabMart order, or book a ride on behalf of a customer. Grab's public Food and Mart APIs are for merchants and POS systems, and Grab's terms forbid bots, scripts and scraping, so Unyly does not automate the Grab app. Live needs partner access from Grab. The first candidate is parcels, because the GrabExpress Delivery API exists for business accounts." },
      { type: "subheading", text: "No silent fallback", id: "modes-fallback" },
      { type: "paragraph", text: "The provider is chosen by the mode of your account (or of the cart). If a provider is unavailable, you get `PROVIDER_UNAVAILABLE`. Demo data is **never** substituted for real data, and an order status that cannot be refreshed is returned from the database with a notice." },
      { type: "callout", kind: "info", text: "Change the mode and region at [Region and mode](/app/mode). The assistant is told to say so whenever results are demo data." },
    ],
  },

  // ------------------------------------------------------------------ Markets and languages
  {
    id: "markets-languages",
    title: "Markets and languages",
    blocks: [
      { type: "paragraph", text: "You can pick any of the 8 Grab markets as your region. Demo data exists only for Bangkok; in every market Handoff works." },
      { type: "table", header: ["Market", "Currency", "Handoff links"], rows: [
        ["Thailand (TH)", "THB", "Verified: Food, Mart, Transport and Express pages"],
        ["Singapore (SG)", "SGD", "Grab country home page, marked unverified"],
        ["Malaysia (MY)", "MYR", "Grab country home page, marked unverified"],
        ["Indonesia (ID)", "IDR", "Grab country home page, marked unverified"],
        ["Vietnam (VN)", "VND", "Grab country home page, marked unverified"],
        ["Philippines (PH)", "PHP", "Grab country home page, marked unverified"],
        ["Cambodia (KH)", "USD", "Grab country home page, marked unverified"],
        ["Myanmar (MM)", "MMK", "Grab country home page, marked unverified"],
      ] },
      { type: "paragraph", text: "Handoff links open the service, not a specific store, cart or route: Grab documents no such parameters. Each link comes with `link_verified` so the assistant can tell you when a page has not been checked." },
      { type: "subheading", text: "Interface languages", id: "languages" },
      { type: "paragraph", text: "The website is available in ten languages: English, Thai, Vietnamese, Indonesian, Malay, Filipino, Khmer, Burmese, Chinese and Russian. Pick one in the language menu in the header, or add `?lang=` with the code (`en`, `th`, `vi`, `id`, `ms`, `fil`, `km`, `my`, `zh`, `ru`) to any address. Without a choice the site follows your browser language. This documentation is written in English, Russian and Thai." },
      { type: "paragraph", text: "Tool results for assistants are in English; your assistant answers you in your language." },
    ],
  },

  // ------------------------------------------------------------------ Getting started
  {
    id: "getting-started",
    title: "Getting started",
    blocks: [
      { type: "subheading", text: "Try the demo without an account", id: "start-try" },
      { type: "paragraph", text: "Open [/try](/try) and write a request about any service. The demo detects the service, shows which MCP calls an assistant would make, lets you choose an option, confirm it and watch the live status. It runs on a temporary guest account that is deleted with all its data after 24 hours. Guest accounts cannot connect assistants or create tokens." },
      { type: "subheading", text: "Create an account", id: "start-account" },
      { type: "steps", items: [
        { title: "Sign in", text: "Go to [Sign in](/login). Create an account with a **passkey** (Face ID, Touch ID, Windows Hello or a security key; no password), or sign in with a **one-time 6-digit code** sent to your email. The code is valid for 10 minutes." },
        { title: "Choose region and mode", text: "At [Region and mode](/app/mode) pick your Grab market and Demo or Handoff." },
        { title: "Add an address", text: "At [Addresses](/app/addresses) add a delivery address with a short label such as `Home`. The label also works as a place name for rides and parcels. In Demo, addresses are in Bangkok districts." },
        { title: "Set preferences", text: "At [Preferences](/app/preferences) set your diet (vegetarian, vegan, halal, no pork, no beef), your allergies and a default party size. **Allergies and diet are stored separately**, and allergies are used only to filter results." },
        { title: "Connect your assistant", text: "Follow [Connecting your assistant](#connect)." },
      ] },
    ],
  },

  // ------------------------------------------------------------------ Connecting
  {
    id: "connect",
    title: "Connecting your assistant",
    summary: "Add one URL to your assistant, sign in to Unyly and choose permissions.",
    blocks: [
      { type: "paragraph", text: "Unyly is a remote MCP server (Streamable HTTP). Server URL:" },
      { type: "code", lang: "text", text: MCP_URL },
      { type: "paragraph", text: "There are two ways to authorize an assistant:" },
      { type: "list", items: [
        "**OAuth sign-in** (recommended): the assistant opens an Unyly page, you sign in, see which permissions it asks for, untick any you do not want and press Allow. Tokens refresh automatically.",
        "**Personal token**: for clients that only accept a fixed bearer token. Create one at [Connections](/app/connections), then use the header `Authorization: Bearer unyly_pat_...`.",
      ] },
      { type: "subheading", text: "Permissions (scopes)", id: "connect-scopes" },
      { type: "table", header: ["Scope", "Allows"], rows: [
        ["`orders:read`", "View stores, menus, fares, carts and order status"],
        ["`orders:prepare`", "Build carts and prepare orders for your confirmation"],
        ["`orders:submit`", "Send orders you have already confirmed"],
        ["`orders:cancel`", "Prepare and execute cancellations you have confirmed"],
      ] },
      { type: "callout", kind: "safety", text: "No scope lets an assistant confirm an order. Even with every permission, an order or cancellation only happens after you press the button on an Unyly page." },
      { type: "subheading", text: "Popular assistants", id: "connect-assistants" },
      { type: "paragraph", text: "Menu names and plan availability change often. The steps below follow each platform's documentation as of 30 September 2026 and have not been tested by hand in every assistant. The same list is on the [Connect page](/connect)." },
      { type: "table", header: ["Assistant", "Where", "Sign-in"], rows: [
        ["ChatGPT", "Web, developer mode", "OAuth"],
        ["Claude", "claude.ai, Desktop, mobile", "OAuth"],
        ["Gemini", "Gemini Enterprise and Gemini CLI", "OAuth"],
        ["Microsoft Copilot", "Copilot Studio", "OAuth or token"],
        ["Perplexity", "Connectors", "OAuth or token"],
        ["Grok", "Connectors", "OAuth"],
        ["Mistral Le Chat", "Connectors, all plans", "OAuth or token"],
        ["DeepSeek", "Through an MCP client", "Token"],
        ["Qwen", "Qwen-Agent and MCP clients", "Token"],
        ["Meta AI", "Meta AI app", "No MCP yet"],
      ] },
      { type: "subheading", text: "ChatGPT", id: "connect-chatgpt" },
      { type: "list", ordered: true, items: [
        "Settings → Apps → Advanced → Developer mode.",
        "Create an app, paste the MCP URL, choose OAuth authentication.",
        "Sign in to Unyly and allow access.",
      ] },
      { type: "paragraph", text: "Write actions (placing orders) are not available on every plan; account policy decides." },
      { type: "subheading", text: "Claude", id: "connect-claude" },
      { type: "list", ordered: true, items: [
        "Settings → Connectors → Add custom connector.",
        "Paste the MCP URL. The OAuth Client ID and Secret fields can stay empty.",
        "Sign in to Unyly and allow access.",
      ] },
      { type: "paragraph", text: "The free plan allows one custom connector. On Team and Enterprise an organization owner adds the connector first." },
      { type: "subheading", text: "Gemini", id: "connect-gemini" },
      { type: "list", items: [
        "**Gemini Enterprise**: an admin adds an MCP server with the URL above (Streamable HTTP, OAuth).",
        "**Gemini CLI**: add the server to `settings.json` (`httpUrl`) and sign in via the browser.",
      ] },
      { type: "paragraph", text: "The consumer Gemini app does not yet connect third-party MCP servers in every country." },
      { type: "subheading", text: "Microsoft Copilot", id: "connect-copilot" },
      { type: "list", ordered: true, items: [
        "Copilot Studio → your agent → Tools → Add an MCP server.",
        "Paste the MCP URL.",
        "Sign in with OAuth, or create a personal token under Connections and choose bearer authentication.",
      ] },
      { type: "paragraph", text: "The consumer Copilot app does not connect custom MCP servers." },
      { type: "subheading", text: "Perplexity", id: "connect-perplexity" },
      { type: "list", ordered: true, items: [
        "Settings → Connectors → Add custom (remote MCP).",
        "Paste the MCP URL.",
        "Sign in with OAuth, or use a personal token with bearer authentication.",
      ] },
      { type: "subheading", text: "Grok", id: "connect-grok" },
      { type: "list", ordered: true, items: [
        "Settings → Connectors → Add custom.",
        "Paste the MCP URL.",
        "Sign in to Unyly and allow access.",
      ] },
      { type: "paragraph", text: "Available if your plan offers custom connectors." },
      { type: "subheading", text: "Mistral Le Chat", id: "connect-lechat" },
      { type: "list", ordered: true, items: [
        "Intelligence → Connectors → Add connector → custom MCP.",
        "Paste the MCP URL.",
        "Sign in with OAuth, or use a personal token with bearer authentication.",
      ] },
      { type: "subheading", text: "DeepSeek, Qwen and Llama models", id: "connect-token-clients" },
      { type: "paragraph", text: "The DeepSeek and Meta AI apps do not connect MCP servers. Use DeepSeek, Qwen (for example in Qwen-Agent) or Llama models inside an MCP-capable client or agent, with the MCP URL and an Unyly personal token:" },
      { type: "code", lang: "json", text: `{"mcpServers":{"unyly":{"url":"${MCP_URL}","headers":{"Authorization":"Bearer unyly_pat_..."}}}}` },
      { type: "subheading", text: "Claude Code", id: "connect-claude-code" },
      { type: "code", lang: "bash", text: `claude mcp add --transport http unyly ${MCP_URL}\n# then, inside Claude Code:\n/mcp   # select unyly, Authenticate, sign in to Unyly, Allow` },
      { type: "subheading", text: "OpenAI Responses API", id: "connect-openai-api" },
      { type: "paragraph", text: "Pass an Unyly access token or personal token in `authorization`. Requiring approval for the two irreversible tools is recommended; the Unyly confirmation page is still required." },
      { type: "code", lang: "json", text: `{\n  "model": "<your model>",\n  "input": "Dinner for two under 600 baht, no nuts",\n  "tools": [{\n    "type": "mcp",\n    "server_label": "unyly",\n    "server_url": "${MCP_URL}",\n    "authorization": "unyly_pat_...",\n    "require_approval": { "always": { "tool_names": ["submit_order", "cancel_order"] } }\n  }]\n}` },
      { type: "subheading", text: "Anthropic Messages API", id: "connect-anthropic-api" },
      { type: "paragraph", text: "Use the MCP connector (beta header `mcp-client-2025-11-20`) with `mcp_servers: [{ type: \"url\", url, name, authorization_token }]` and an `mcp_toolset` tool. The API has no approval step of its own, so the Unyly confirmation page is what protects you." },
    ],
  },

  // ------------------------------------------------------------------ Safety
  {
    id: "safety",
    title: "Confirmation and safety",
    summary: "Only you can place or cancel an order, and only for exactly what you saw.",
    blocks: [
      { type: "subheading", text: "The confirmation page", id: "safety-confirm" },
      { type: "list", items: [
        "Each order gets a **one-time** confirmation link `/confirm/<id>`. It opens only for your signed-in account; anyone else gets \"not found\".",
        "The link is valid for up to **15 minutes**. The page shows the exact time.",
        "The page shows the store or route, items and options, the address, every fee, the total, the payment method, the cancellation terms and which assistant prepared it.",
        "**Confirm** places the order right away. **Decline** closes the confirmation. There is no tool that confirms on your behalf, and extra arguments such as `confirmed: true` are rejected.",
      ] },
      { type: "subheading", text: "Price re-check", id: "safety-price" },
      { type: "paragraph", text: "The confirmation is bound to one cart version, one quote, the address or route, the total and the currency. If anything changes (items, address, route, a saved address used as a trip point), the confirmation is invalidated and the assistant must prepare a new one." },
      { type: "paragraph", text: "When you press Confirm after the provider's quote has aged, Unyly re-prices the **same** cart. If the total is the same and nothing blocks the order, it goes ahead. If the total differs, the confirmation is cancelled with `PRICE_CHANGED` and nothing is ordered. The page offers **Refresh price**, which creates a new confirmation for the same cart; you still have to press Confirm again." },
      { type: "subheading", text: "No duplicate orders", id: "safety-duplicates" },
      { type: "list", items: [
        "One confirmation can produce at most one submission. Double clicks, retries, network errors and restarts do not create a second order.",
        "`submit_order` and `cancel_order` are idempotent: repeating them returns the same result.",
        "If the provider's answer is lost, the status becomes `SUBMISSION_UNKNOWN`. Unyly reconciles it with the provider and **never resends**. Do not order the same thing elsewhere until the status is clear.",
        "Closing the chat or the browser tab never cancels an order and never stops a submission that has started.",
      ] },
      { type: "subheading", text: "Cancellation", id: "safety-cancel" },
      { type: "list", ordered: true, items: [
        "The assistant calls `prepare_cancellation` (or you press Cancel on the order page). Unyly asks the provider for the current terms and fee.",
        "You open the cancellation page `/confirm-cancel/<id>`, see the fee and the terms, and confirm. This page is valid for 5 minutes.",
        "If the fee changed in the meantime, the cancellation is refused and you review it again.",
      ] },
      { type: "paragraph", text: "In Demo, cancellation is free right after acceptance; later a fee applies (50% of the order total while a restaurant is preparing, 30 THB for a ride, 20 THB for a parcel) and it is not possible after pickup. Demo fees are never charged." },
      { type: "subheading", text: "Allergens and medicines", id: "safety-allergens" },
      { type: "callout", kind: "safety", text: "Allergen information is only what the store **declared**. Each item is reported as `none_declared` or `unknown`. Unyly never calls a dish **safe**, and neither should your assistant. If you have a serious allergy, check with the restaurant." },
      { type: "paragraph", text: "The pharmacy offers household remedies only, with per-order limits. The assistant is instructed not to suggest prescription medicines or dosing beyond the label." },
      { type: "subheading", text: "What assistants can and cannot see", id: "safety-privacy" },
      { type: "list", items: [
        "Assistants see only the **label and area** of your addresses (for example `Home` in `Watthana, Bangkok`), never the street line.",
        "Store names, menus and descriptions are passed as untrusted data, and the assistant is told not to follow instructions found in them.",
        "Unyly **never** asks for your Grab password, SMS or OTP codes, or card details. If anything asks you for them in the name of Unyly, do not enter them.",
      ] },
    ],
  },

  // ------------------------------------------------------------------ Tools
  {
    id: "tools",
    title: "MCP tools reference",
    summary: "15 tools, one envelope format, machine-readable errors.",
    blocks: [
      { type: "paragraph", text: "Transport: Streamable HTTP, `POST /mcp`, stateless (no sessions; `GET` and `DELETE` return 405). Input schemas are strict: unknown arguments are rejected, and `null` in an optional argument is treated as omitted. Your user is taken only from the token." },
      { type: "table", header: ["Tool", "Scope", "What it does", "Side effects"], rows: [
        ["`get_capabilities`", "`orders:read`", "Region, services available in the current mode with how to use each, the 8 markets, whether new orders are enabled, default address", "None"],
        ["`search_stores`", "`orders:read`", "Restaurants (`food`) or shops (`mart`: supermarket, convenience, flowers, pharmacy, cakes) that deliver to your default address; budget, party size, allergens, diet", "None"],
        ["`get_store`", "`orders:read`", "All items of one store: prices, availability, option groups, per-order limits, declared allergens", "None"],
        ["`estimate_trip`", "`orders:read`", "Fare options for a ride or a parcel between two places", "None, nothing is booked"],
        ["`create_cart`", "`orders:prepare`", "Creates a cart for one store or trip; by default also quotes it and returns the confirmation link. In Handoff returns the Grab link and checklist. `from_order_id` repeats a past order at current prices", "Saves a cart and a pending confirmation"],
        ["`update_cart`", "`orders:prepare`", "Add, change or remove items, set the address or the trip; by default re-quotes and returns a new link", "Invalidates earlier confirmation links"],
        ["`quote_cart`", "`orders:prepare`", "Exact breakdown, ETA, blocking issues and quote expiry", "Stores a quote; orders nothing"],
        ["`prepare_checkout`", "`orders:prepare`", "Creates the one-time confirmation and `confirm_url` (up to 15 minutes)", "Orders nothing"],
        ["`get_checkout_status`", "`orders:read`", "Confirmation status, submission, `order_id`, one-sentence summary", "None"],
        ["`submit_order`", "`orders:submit`", "Sends an order you already confirmed, only if pressing Confirm did not send it (rare)", "**Irreversible**, idempotent"],
        ["`get_order_status`", "`orders:read`", "Current status of an order, ride or parcel with a readable label", "May refresh from the provider"],
        ["`list_orders`", "`orders:read`", "Your orders, rides and parcels, newest first, plus recent Handoff checklists", "None"],
        ["`prepare_cancellation`", "`orders:cancel`", "Gets the current cancellation terms and fee and creates a confirmation page", "Cancels nothing"],
        ["`cancel_order`", "`orders:cancel`", "Executes a cancellation you already confirmed", "**Irreversible**, idempotent"],
        ["`create_handoff`", "`orders:prepare`", "Handoff mode: Grab link for the service and a checklist (`create_cart` already does this)", "Saves the checklist; no order"],
      ] },
      { type: "subheading", text: "Shortest paths", id: "tools-paths" },
      { type: "list", items: [
        "**Food or shop**: `search_stores` → `create_cart` → (you confirm) → `get_checkout_status`.",
        "**Ride or parcel**: `estimate_trip` → `create_cart` with `service`, `pickup`, `dropoff` and one vehicle `item_id` (plus `parcel_weight_kg` for express) → (you confirm) → `get_checkout_status`.",
        "**Handoff**: `create_cart` with the store name and item names, or pickup and drop-off, returns the Grab link and checklist in `result.handoff`.",
      ] },
      { type: "paragraph", text: "`submit_order` is needed only when `get_checkout_status` shows `approved` with no submission. Calling it before you confirm returns `CONFIRMATION_REQUIRED`." },
      { type: "subheading", text: "Example call", id: "tools-example" },
      { type: "code", lang: "bash", text: `curl -s ${MCP_URL} \\\n  -H "Authorization: Bearer unyly_pat_..." \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_stores","arguments":{"party_size":2,"budget_total_major":600,"exclude_allergens":["peanut","tree_nut"],"limit":3}}}'` },
      { type: "subheading", text: "Response envelope", id: "tools-envelope" },
      { type: "paragraph", text: "Every tool returns the same envelope in `structuredContent` (and the same JSON as text):" },
      { type: "code", lang: "json", text: `{\n  "ok": true,\n  "mode": "demo",\n  "data_as_of": "2026-09-30T03:40:12.000Z",\n  "result": { "...": "..." },\n  "next_actions": [{ "tool": "get_checkout_status", "why": "Once the user says they confirmed on confirm_url" }],\n  "notices": ["DEMO MODE: synthetic stores, fares and orders. Nothing is delivered, driven or charged. Always tell the user this is a demo."]\n}` },
      { type: "paragraph", text: "On error the result has `isError: true` and:" },
      { type: "code", lang: "json", text: `{\n  "ok": false,\n  "mode": "demo",\n  "data_as_of": "2026-09-30T03:41:02.000Z",\n  "operation_id": "5b0c7a1e-...",\n  "error": {\n    "code": "PLACE_AMBIGUOUS",\n    "message": "Bangkok has two airports. Ask the user which one.",\n    "details": { "suggestions": ["Suvarnabhumi Airport (BKK)", "Don Mueang Airport (DMK)"] },\n    "user_action": "Ask the user which place they mean (for example: Suvarnabhumi Airport (BKK), Don Mueang Airport (DMK)). Do not pick one for them."\n  },\n  "next_actions": [{ "tool": "create_cart", "why": "Retry with the place the user chooses" }],\n  "notices": []\n}` },
      { type: "paragraph", text: "`operation_id` appears only on errors, so you can quote it to support. `user_action` tells the assistant what to do or what to ask you." },
      { type: "subheading", text: "Error codes", id: "tools-errors" },
      { type: "table", header: ["Code", "Meaning", "What happens next"], rows: [
        ["`AUTH_REQUIRED`", "Token invalid or account deleted", "Reconnect the assistant"],
        ["`INSUFFICIENT_SCOPE`", "A permission was not granted", "Reconnect and allow the named scope"],
        ["`NOT_FOUND`", "The object does not exist or is not yours", "Nothing to do"],
        ["`VALIDATION_FAILED`", "Wrong or missing argument (`details.field`)", "The assistant fixes it and asks you for anything missing"],
        ["`CAPABILITY_UNAVAILABLE`", "Not available in the current mode", "The assistant checks `get_capabilities`"],
        ["`ADDRESS_REQUIRED`, `ADDRESS_AMBIGUOUS`", "No delivery address, or it is incomplete", "Add one at [Addresses](/app/addresses), or send a gift with `deliver_to`"],
        ["`DELIVERY_UNAVAILABLE`, `RESTAURANT_CLOSED`", "The store cannot deliver now", "Choose another store"],
        ["`OUT_OF_STOCK`, `ITEM_NOT_FOUND`, `MINIMUM_ORDER_NOT_MET`", "Cart problem", "Change the cart"],
        ["`MODIFIERS_INVALID`", "A required option has no choice", "You are asked to choose"],
        ["`QUANTITY_LIMIT`", "More than the per-order limit of an item", "You are asked whether to order fewer"],
        ["`PLACE_NOT_FOUND`, `PLACE_AMBIGUOUS`", "A place was not found or is ambiguous", "You pick from the suggestions"],
        ["`TRIP_REQUIRED`, `OUTSIDE_SERVICE_AREA`", "Pickup, drop-off or parcel weight missing, or a place outside the service area", "You are asked for the missing detail"],
        ["`WEIGHT_LIMIT`", "The parcel is too heavy for the vehicle", "With your consent the vehicle is switched"],
        ["`CART_VERSION_CONFLICT`", "The cart changed since the assistant last read it", "The assistant re-reads and retries"],
        ["`CART_EMPTY`, `CART_NOT_OPEN`", "The cart is empty or already ordered", "Start a new cart"],
        ["`QUOTE_REQUIRED`, `QUOTE_EXPIRED`, `PRICE_CHANGED`", "No current quote, or the price changed", "New quote, then a new confirmation for you"],
        ["`CONFIRMATION_REQUIRED`", "You have not confirmed yet", "You get the link; the assistant checks the status afterwards"],
        ["`CONFIRMATION_EXPIRED`, `CONFIRMATION_INVALIDATED`", "The link expired or no longer matches the cart", "A new quote and link"],
        ["`SUBMISSIONS_PAUSED`", "New orders are paused by the operator", "Try later; status reading still works"],
        ["`PROVIDER_UNAVAILABLE`", "The provider cannot be reached; demo data is never substituted", "Try later"],
        ["`PROVIDER_REJECTED`", "The provider refused the order", "Review and try again or choose another option"],
        ["`SUBMISSION_UNKNOWN`", "The outcome is still being checked with the provider", "Do **not** order again; check status later"],
        ["`CANCELLATION_NOT_ALLOWED`", "The order can no longer be cancelled", "Nothing to do"],
        ["`CANCELLATION_UNKNOWN`", "The cancellation outcome is being checked", "Check the order status later"],
        ["`RATE_LIMITED`", "Too many requests", "Wait and retry"],
        ["`INTERNAL`", "Unexpected error; nothing irreversible was done by that call unless a status tool says otherwise", "Retry or contact support with `operation_id`"],
      ] },
    ],
  },

  // ------------------------------------------------------------------ Authentication
  {
    id: "authentication",
    title: "Authentication",
    blocks: [
      { type: "paragraph", text: "Unyly runs its own OAuth 2.1 authorization server for the MCP resource. Clients discover it automatically: a request without a token gets `401` with a `WWW-Authenticate` header that points to the protected resource metadata." },
      { type: "table", header: ["Item", "Value"], rows: [
        ["Protected resource metadata", "`https://unyly-food.unyly.org/.well-known/oauth-protected-resource/mcp`"],
        ["Authorization server metadata", "`https://unyly-food.unyly.org/.well-known/oauth-authorization-server`"],
        ["Endpoints", "`/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`"],
        ["Grant types", "Authorization code with PKCE (`S256` only), refresh token"],
        ["Client registration", "Dynamic Client Registration, or a Client ID Metadata Document (an https `client_id`)"],
        ["Client authentication", "None (public clients)"],
        ["Scopes", "`orders:read`, `orders:prepare`, `orders:submit`, `orders:cancel`; `offline_access` is accepted"],
        ["Access token lifetime", "1 hour"],
        ["Refresh token lifetime", "30 days, rotated on every use"],
      ] },
      { type: "list", items: [
        "Redirect URIs must match exactly; loopback addresses (`localhost`, `127.0.0.1`, `[::1]`) match on any port.",
        "Tokens are bound to the MCP resource (audience check) and are never forwarded to Grab.",
        "If a used refresh token is presented again later than 60 seconds after use, Unyly treats it as theft and revokes the whole connection.",
        "When a client asks for no Unyly scope (or only `offline_access`), the consent page offers all scopes and you untick the ones you do not want.",
        "Guest accounts from `/try` cannot authorize assistants.",
      ] },
      { type: "subheading", text: "Personal tokens", id: "auth-pat" },
      { type: "list", items: [
        "Create them at [Connections](/app/connections) with a name, the scopes you choose and a lifetime of 30, 90 or 365 days. Up to 10 active tokens.",
        "They start with `unyly_pat_`, are shown **once**, and only a hash is stored.",
        "Send them only in the header `Authorization: Bearer ...`. Tokens in a URL query are never accepted.",
        "A personal token cannot confirm orders either: confirmation always happens on the website.",
      ] },
      { type: "subheading", text: "Revoking access", id: "auth-revoke" },
      { type: "paragraph", text: "Open [Connections](/app/connections) and press **Revoke** next to an assistant or a personal token. It stops working immediately." },
    ],
  },

  // ------------------------------------------------------------------ Privacy
  {
    id: "privacy",
    title: "Your data and privacy",
    blocks: [
      { type: "paragraph", text: "Unyly stores only what the service needs: your email, passkeys (public key only), addresses, preferences, carts, trips and orders, assistant connections and an audit log. It never stores Grab passwords, SMS codes or payment details." },
      { type: "table", header: ["Data", "Kept"], rows: [
        ["Sign-in codes", "Deleted after 1 day"],
        ["Website sessions", "14 days, then deleted"],
        ["Guest demo accounts", "Deleted with all data after 24 hours"],
        ["Assistant connections (OAuth)", "Tokens deleted on revocation or expiry"],
        ["Personal tokens", "Hash only; deleted 30 days after revocation or expiry"],
        ["Passkeys", "Public key only, until you remove it"],
        ["Addresses and gift recipients", "Until you delete them; deletion erases the address text"],
        ["Trips, item notes, parcel descriptions", "Kept with carts and orders"],
        ["Allergies and diet", "Used only for filtering, until you change them"],
        ["Carts, quotes, orders", "While the account exists (order history)"],
        ["Audit log", "Unlinked from you and scrubbed when you delete the account"],
      ] },
      { type: "list", items: [
        "**Export**: [Data](/app/data) → Export downloads a JSON file with your account, preferences, addresses, passkey metadata, carts, quotes, confirmations, orders, connections and Handoff checklists.",
        "**Delete**: on the same page type `DELETE` and confirm. The account and its data are removed and you are signed out.",
        "The full retention table is on [Data and retention](/privacy).",
      ] },
      { type: "callout", kind: "info", text: "In Handoff mode, what you order in Grab is between you and Grab. Unyly does not see it." },
    ],
  },

  // ------------------------------------------------------------------ Limits
  {
    id: "limits",
    title: "Limits",
    summary: "Numbers you may run into.",
    blocks: [
      { type: "table", header: ["Limit", "Value"], rows: [
        ["Confirmation link lifetime", "Up to 15 minutes"],
        ["Cancellation confirmation lifetime", "5 minutes"],
        ["Lines per cart", "30"],
        ["Quantity per line", "1 to 20; some items have a lower per-order limit counted across all lines"],
        ["Vehicles per ride or parcel", "Exactly one"],
        ["Operations per `update_cart` call", "Up to 20"],
        ["Stores per search", "Default 5, up to 10"],
        ["Orders per `list_orders` page", "Default 10, up to 50"],
        ["Saved addresses, including gift recipients", "30"],
        ["Active personal tokens", "10, each valid up to 365 days"],
        ["MCP requests", "120 per minute per token"],
        ["Website requests", "300 per minute per IP address (static files excluded)"],
        ["Sign-in codes", "5 per hour per email, 5 attempts per code, valid 10 minutes"],
        ["Guest demo sessions", "A limited number per hour per IP address; deleted after 24 hours"],
      ] },
      { type: "paragraph", text: "When a limit is hit, tools return `RATE_LIMITED`, `QUANTITY_LIMIT` or `VALIDATION_FAILED` with a message that says which limit applies." },
    ],
  },

  // ------------------------------------------------------------------ FAQ
  {
    id: "faq",
    title: "FAQ",
    blocks: [
      { type: "subheading", text: "Is this an official Grab service?" },
      { type: "paragraph", text: "No. Unyly is an independent concept prepared as a partnership proposal and is not affiliated with or endorsed by Grab." },
      { type: "subheading", text: "Can I order real food through Unyly today?" },
      { type: "paragraph", text: "Not through Unyly directly. Use Handoff: the assistant prepares your list or route and you order in Grab. Live orders need partner access from Grab." },
      { type: "subheading", text: "Can my assistant order without me?" },
      { type: "paragraph", text: "No. Every order and every cancellation is confirmed by you on an Unyly page after signing in. The assistant cannot press that button, whatever it says in the chat." },
      { type: "subheading", text: "Is anything charged in Demo?" },
      { type: "paragraph", text: "No. Stores, drivers and prices are fictional, nothing is delivered and no money moves." },
      { type: "subheading", text: "What if the price changes before I confirm?" },
      { type: "paragraph", text: "The confirmation stops being valid and nothing is ordered. Press **Refresh price** on the page, or ask the assistant for a new link, and confirm the new total." },
      { type: "subheading", text: "What does \"outcome unknown\" mean?" },
      { type: "paragraph", text: "The connection to the provider dropped after the order was sent. Unyly checks the result itself and never resends. Do not order the same thing elsewhere until the status is clear." },
      { type: "subheading", text: "How accurate is allergen information?" },
      { type: "paragraph", text: "It is only what the store declared. If there is no data, Unyly says so. It never calls a dish safe." },
      { type: "subheading", text: "Does the assistant see my home address?" },
      { type: "paragraph", text: "It sees the label and area (for example `Home` in `Watthana, Bangkok`), not the street line. The full address appears only on your confirmation page." },
      { type: "subheading", text: "My assistant only accepts a token. What do I do?" },
      { type: "paragraph", text: "Create a personal token at [Connections](/app/connections) and set the header `Authorization: Bearer unyly_pat_...` in the client." },
      { type: "subheading", text: "How do I disconnect an assistant?" },
      { type: "paragraph", text: "Open [Connections](/app/connections) and press Revoke. Access stops immediately." },
      { type: "subheading", text: "Why is the Grab link not verified in my country?" },
      { type: "paragraph", text: "Only the Thai service pages have been checked. Other markets link to the Grab country home page until someone checks the service pages there." },
      { type: "subheading", text: "Where do I report a problem?" },
      { type: "paragraph", text: "Use [Contacts](/contact). For an order placed inside Grab, contact Grab support. If a tool returned an error, include its `operation_id`." },
    ],
  },

  // ------------------------------------------------------------------ Developers and partners
  {
    id: "developers",
    title: "For developers and partners",
    blocks: [
      { type: "list", items: [
        "The [proposal for Grab](/for-grab) describes the partnership idea, what exists today and what Live would need.",
        "The MCP endpoint, OAuth metadata and tools are described above. Any MCP client that speaks Streamable HTTP and OAuth 2.1 with PKCE can connect.",
        "Tool results are the same envelope for every tool, so a client can handle `ok`, `mode`, `next_actions` and `error.user_action` generically.",
        "For partnerships, API access and security reports, use [Contacts](/contact). Security reports are answered within 24 hours.",
      ] },
      { type: "callout", kind: "info", text: "Tool names describe Unyly's own operations. They do not imply that Grab offers an API with the same operations." },
    ],
  },

  // ------------------------------------------------------------------ Changelog
  {
    id: "changelog",
    title: "Changelog",
    blocks: [
      { type: "subheading", text: "30 September 2026" },
      { type: "list", items: [
        "Documentation section with Markdown downloads in English, Russian and Thai.",
        "Contacts page and footer contacts; unicorn logo and icons.",
        "Ten interface languages: English, Thai, Vietnamese, Indonesian, Malay, Filipino, Khmer, Burmese, Chinese and Russian, with a language menu.",
        "One-call checkout: `create_cart` returns the quote and the confirmation link together. Confirmations last 15 minutes, with a Refresh price button.",
        "Gift delivery to another person with `deliver_to`.",
        "Personal tokens, `offline_access` and loopback redirects on any port for wider assistant compatibility; connection guide for ten assistants.",
        "All Grab services over one flow: food, groceries, flowers, pharmacy household remedies, cakes, rides and parcels.",
        "Guided demo at /try without an account, and the proposal page for Grab.",
        "Passkey sign-in, data export and account deletion.",
        "First release: MCP server, OAuth 2.1, Demo, Handoff and Live modes, web confirmation.",
      ] },
    ],
  },
];
