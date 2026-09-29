import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import { DomainError } from '../domain/errors.js';
import { MODES, Mode } from '../providers/types.js';
import { loadCart } from './carts.js';
import { requireCapability, submissionsEnabled } from './common.js';
import { getDefaultAddress, getUser, maskedAddress } from './users.js';

export async function createHandoff(ctx: Ctx, actor: Actor, cartId: string) {
  const cart = await loadCart(ctx.db, actor.userId, cartId);
  requireCapability(ctx, cart.mode, 'handoff');
  if (!cart.items.length) throw new DomainError('CART_EMPTY', 'Cart has no items');
  const user = await getUser(ctx.db, actor.userId);
  const link = ctx.provider(cart.mode).handoffUrl?.(user.region);
  if (!link) throw new DomainError('CAPABILITY_UNAVAILABLE', `No verified Grab link for region ${user.region}`);
  const checklist = cart.items.map((l) => ({ name: l.name, quantity: l.quantity, note: l.note ?? null }));
  const r = await ctx.db.tx(async (q) => {
    const h = await q.query(
      'INSERT INTO handoffs (user_id, cart_id, cart_version, url, checklist) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
      [actor.userId, cart.id, cart.version, link.url, JSON.stringify(checklist)],
    );
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'handoff.created', mode: cart.mode, entity: 'handoff', entityId: h.rows[0].id });
    return h.rows[0];
  });
  return {
    handoff_id: r.id,
    open_url: link.url,
    link_source: link.source,
    restaurant: cart.restaurant_name,
    checklist,
    instructions: [
      'Open the link (or the Grab app) and search for the restaurant yourself.',
      'Add the items from the checklist. Prices, fees, availability and allergen information are shown only in Grab.',
      'Review and pay inside Grab. Opening the link does NOT create an order, and Unyly cannot see whether you completed it.',
    ],
    order_created: false,
  };
}

export async function getCapabilities(ctx: Ctx, actor: Actor) {
  const user = await getUser(ctx.db, actor.userId);
  const addr = await getDefaultAddress(ctx.db, actor.userId);
  const modes: Record<string, unknown> = {};
  for (const m of MODES) {
    modes[m] = { capabilities: ctx.provider(m).capabilities(), submissions_enabled: await submissionsEnabled(ctx, ctx.db, m) };
  }
  const current = modes[user.mode] as any;
  return {
    region: user.region,
    region_note: user.region === 'TH' ? 'Thailand is a preliminary product assumption; no live Grab access has been granted.' : undefined,
    current_mode: user.mode as Mode,
    mode_explanations: {
      demo: 'Synthetic restaurants and orders. No real food, delivery or payment.',
      handoff: 'Unyly prepares a checklist; you order and pay inside Grab yourself.',
      live: 'Real Grab orders placed by Unyly. Not available: requires a Grab partner agreement.',
    },
    current: current,
    delivery_address: maskedAddress(addr),
    unyly_scopes_granted: actor.scopes ?? null,
    settings_url: `${ctx.cfg.webOrigin}/app`,
  };
}
