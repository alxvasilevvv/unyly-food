import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// MCP prompts: clients such as Claude Desktop, VS Code and Cursor show them as slash commands.
// Each one renders a single user message that sends the assistant down the safe tool path.
// Prompt arguments are strings in MCP. Optional ones may arrive as "" from some clients: blank means omitted.

const req = (max: number, description: string) => z.string().trim().min(1).max(max).describe(description);
const opt = (max: number, description: string) => z.string().trim().max(max).optional().describe(description);

/** The rules every prompt ends with. Kept short: the server instructions carry the details. */
export const CONFIRM_RULES =
  'Rules: use the Unyly tools. Show me the full price (items, every fee, total and currency) and give me the confirm_url. ' +
  'Only I can place the order, by pressing Confirm on the Unyly page; my saying yes in chat is not a confirmation. ' +
  'Never say the order is placed until get_checkout_status shows it. ' +
  'If the result says demo mode, tell me it is a demo. In handoff mode give me the Grab link and checklist instead.';

type Args = Record<string, string | undefined>;
interface PromptDef {
  title: string;
  description: string;
  args?: Record<string, z.ZodType<string | undefined>>;
  render: (a: Args) => string;
}

/** Joins the non-blank lines. */
const lines = (...parts: (string | false | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== '').join('\n');
const has = (v: string | undefined): v is string => !!v && v.trim() !== '';

export const PROMPTS: Record<string, PromptDef> = {
  order_food: {
    title: 'Order food',
    description: 'Food delivery from a restaurant via Grab: find a place, build the order, get the confirmation link.',
    args: {
      request: req(300, 'What to eat, e.g. "Thai curry for dinner"'),
      budget: opt(40, 'Total budget, e.g. "600 THB"'),
      people: opt(10, 'Number of people'),
      avoid: opt(200, 'Allergens or ingredients to avoid'),
    },
    render: (a) => lines(
      `Order food for me with Unyly: ${a.request}`,
      has(a.budget) && `Budget (total): ${a.budget}`,
      has(a.people) && `People: ${a.people}`,
      has(a.avoid) && `Avoid: ${a.avoid}. Never call an item safe; relay allergen_check notes as they are.`,
      'Path: search_stores (service "food", with party_size, budget_total_major, exclude_allergens or dietary where they fit), agree the choice with me, then create_cart.',
    ),
  },
  buy_groceries: {
    title: 'Buy groceries',
    description: 'Groceries or convenience items delivered via Grab Mart.',
    args: { items: req(500, 'Shopping list, e.g. "milk, eggs, 2 kg rice"') },
    render: (a) => lines(
      `Buy groceries for me with Unyly: ${a.items}`,
      'Path: search_stores (service "mart", category "supermarket" or "convenience", query), tell me about anything missing or substituted, then create_cart.',
    ),
  },
  send_flowers: {
    title: 'Send flowers',
    description: 'Flowers delivered to someone via Grab Mart, with an optional card message.',
    args: {
      what: req(200, 'Which flowers, e.g. "a dozen red roses"'),
      recipient: req(300, 'Who receives them and where (name, phone, address), as far as known'),
      card_text: opt(200, 'Message for the card'),
    },
    render: (a) => lines(
      `Send flowers with Unyly: ${a.what}`,
      `Recipient: ${a.recipient}`,
      has(a.card_text) && `Card message: ${a.card_text}`,
      'Path: search_stores (service "mart", category "flowers"), then create_cart with the card message as the item note and deliver_to for the recipient. Ask me for any missing recipient detail (name, phone, street address, district, city); do not guess.',
    ),
  },
  pharmacy: {
    title: 'Pharmacy',
    description: 'Household remedies and pharmacy items via Grab Mart. No prescription medicines.',
    args: { need: req(300, 'What you need, e.g. "paracetamol and plasters"') },
    render: (a) => lines(
      `Get pharmacy items for me with Unyly: ${a.need}`,
      'Path: search_stores (service "mart", category "pharmacy", query), then create_cart.',
      'Household remedies only: no prescription medicines and no dosing advice beyond the label. If I need a prescription medicine, tell me to see a pharmacist or doctor.',
    ),
  },
  order_cake: {
    title: 'Order a cake',
    description: 'A cake for an occasion via Grab Mart, with an optional inscription.',
    args: {
      occasion: req(200, 'Occasion, e.g. "birthday for 8 people"'),
      inscription: opt(100, 'Text to write on the cake'),
    },
    render: (a) => lines(
      `Order a cake for me with Unyly. Occasion: ${a.occasion}`,
      has(a.inscription) && `Inscription: ${a.inscription}`,
      'Path: search_stores (service "mart", category "cakes"), then create_cart with the inscription as the item note.',
    ),
  },
  book_ride: {
    title: 'Book a ride',
    description: 'A Grab ride between two places: compare fares, then get the confirmation link.',
    args: {
      from: opt(160, 'Pickup place or saved address label; asked if missing'),
      to: req(160, 'Destination'),
      passengers: opt(10, 'Number of passengers'),
    },
    render: (a) => lines(
      `Book a ride for me with Unyly to ${a.to}`,
      has(a.from) ? `From: ${a.from}` : 'Ask me for the pickup place.',
      has(a.passengers) && `Passengers: ${a.passengers}`,
      'Path: estimate_trip (service "ride"), show me the options, then create_cart with the vehicle I choose. If a place is ambiguous, ask me; do not pick one for me.',
    ),
  },
  send_parcel: {
    title: 'Send a parcel',
    description: 'A Grab Express parcel delivery between two places.',
    args: {
      from: opt(160, 'Pickup place or saved address label; asked if missing'),
      to: req(160, 'Drop-off place'),
      weight_kg: z.string().trim().regex(/^\d{1,4}(?:[.,]\d{1,2})?$/, 'must be a number of kilograms').describe('Parcel weight in kg, e.g. "3.5"'),
    },
    render: (a) => lines(
      `Send a parcel for me with Unyly to ${a.to}`,
      has(a.from) ? `From: ${a.from}` : 'Ask me for the pickup place.',
      `Weight: ${a.weight_kg} kg`,
      'Path: estimate_trip (service "express", parcel_weight_kg), show me the options, then create_cart with the vehicle I choose.',
    ),
  },
  track_orders: {
    title: 'Track my orders',
    description: 'Status of recent Unyly orders, rides and parcels.',
    render: () => lines(
      'Show my recent Unyly orders, rides and parcels with list_orders, and the current status of active ones with get_order_status. For a confirmation still waiting for me, use get_checkout_status.',
      'Do not create, submit or cancel anything. Report statuses as the tools give them.',
    ),
  },
};

export function registerPrompts(server: McpServer) {
  for (const [name, p] of Object.entries(PROMPTS)) {
    const message = (text: string) => ({
      description: p.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${text}\n${name === 'track_orders' ? '' : CONFIRM_RULES}`.trim() } }],
    });
    if (p.args) server.registerPrompt(name, { title: p.title, description: p.description, argsSchema: p.args as any }, (a: any) => message(p.render(a)));
    else server.registerPrompt(name, { title: p.title, description: p.description }, () => message(p.render({})));
  }
}
