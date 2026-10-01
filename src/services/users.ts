import type { Locale } from '../domain/locales.js';
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { sha256, stableJson } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import { REGION_CODES } from '../domain/regions.js';
import { normalizeContactName, normalizePhone, parseCoordinates } from '../providers/grab/places.js';
import type { DeliveryAddress, Mode } from '../providers/types.js';

export interface UserRow {
  id: string;
  email: string;
  locale: Locale;
  is_guest?: boolean;
  region: string;
  mode: Mode;
  onboarded_at: string | null;
  created_at: string;
}

export const SUPPORTED_REGIONS = REGION_CODES;
export const ALLERGENS = ['peanut', 'tree_nut', 'milk', 'egg', 'wheat', 'soy', 'fish', 'shellfish', 'sesame'] as const;
export const DIETS = ['vegetarian', 'vegan', 'halal', 'no_pork', 'no_beef'] as const;

export async function getUser(q: Queryable, id: string): Promise<UserRow> {
  const r = await q.query<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!r.rows[0]) throw new DomainError('AUTH_REQUIRED', 'Account not found or deleted');
  return r.rows[0];
}

/**
 * `verified`: the caller has just proven ownership of the email (email-code sign-in). Accounts
 * created without that proof (passkey registration) start with email_verified_at = NULL.
 * An existing account is returned as is: verifying it is the caller's job (see verifyLoginCode).
 */
export async function findOrCreateUserByEmail(q: Queryable, email: string, locale: Locale, opts: { verified?: boolean } = {}): Promise<UserRow & { email_verified_at?: string | null }> {
  const e = email.trim().toLowerCase();
  const found = await q.query<UserRow>('SELECT * FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [e]);
  if (found.rows[0]) return found.rows[0];
  const r = await q.query<UserRow>(
    `INSERT INTO users (email, locale, email_verified_at) VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END)
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET email = EXCLUDED.email RETURNING *`,
    [e, locale, !!opts.verified],
  );
  await q.query('INSERT INTO preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [r.rows[0].id]);
  await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status) VALUES ($1,'demo','demo','connected') ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  await audit(q, { userId: r.rows[0].id, actor: 'web', action: 'user.created' });
  return r.rows[0];
}

/**
 * Creates an account only if no active account uses this email; returns null otherwise (never the
 * existing account). For sign-in methods that must not attach to an existing account (Login with Grab).
 */
export async function createUserIfEmailFree(q: Queryable, email: string, locale: Locale, opts: { verified: boolean }): Promise<UserRow | null> {
  const e = email.trim().toLowerCase();
  const r = await q.query<UserRow>(
    `INSERT INTO users (email, locale, email_verified_at) VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END)
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING RETURNING *`,
    [e, locale, opts.verified],
  );
  if (!r.rows[0]) return null;
  await q.query('INSERT INTO preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [r.rows[0].id]);
  await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status) VALUES ($1,'demo','demo','connected') ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  await audit(q, { userId: r.rows[0].id, actor: 'web', action: 'user.created' });
  return r.rows[0];
}

export async function setRegionAndMode(ctx: Ctx, userId: string, region: string, mode: Mode) {
  if (!SUPPORTED_REGIONS.includes(region)) throw new DomainError('VALIDATION_FAILED', 'Unsupported region');
  const caps = ctx.provider(mode).capabilities();
  const usable = mode === 'handoff' ? caps.handoff.available : caps.submit_order.available || caps.search_restaurants.available || caps.quote.available;
  if (!usable) throw new DomainError('CAPABILITY_UNAVAILABLE', `Mode ${mode} is not available`, { reason: caps.submit_order.reason });
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE users SET region = $2, mode = $3 WHERE id = $1', [userId, region, mode]);
    if (mode !== 'demo') {
      await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status) VALUES ($1,'grab',$2,'connected') ON CONFLICT DO NOTHING`, [userId, mode]);
    }
    await audit(q, { userId, actor: 'web', action: 'user.mode_set', mode, details: { region } });
  });
}

export async function setLocale(q: Queryable, userId: string, locale: Locale) {
  await q.query('UPDATE users SET locale = $2 WHERE id = $1', [userId, locale]);
}

export async function markOnboarded(q: Queryable, userId: string) {
  await q.query('UPDATE users SET onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $1', [userId]);
}

// ---------------- Addresses ----------------
export interface AddressRow {
  id: string;
  user_id: string;
  label: string;
  line1: string;
  district: string;
  city: string;
  country: string;
  instructions: string | null;
  is_default: boolean;
  /** Exact coordinates (6 decimals) and contact, entered by the user; needed for Live GrabExpress and Farefeed. */
  latitude?: number | null;
  longitude?: number | null;
  contact_name?: string | null;
  contact_phone?: string | null;
}

export function addressFingerprint(a: Pick<AddressRow, 'line1' | 'district' | 'city' | 'country' | 'instructions'> & Partial<Pick<AddressRow, 'latitude' | 'longitude' | 'contact_name' | 'contact_phone'>>): string {
  // Coordinates and contact are included only when set, so fingerprints of older addresses do not change.
  const live = a.latitude != null || a.contact_phone ? { lat: a.latitude ?? null, lng: a.longitude ?? null, cn: a.contact_name ?? null, cp: a.contact_phone ?? null } : {};
  return sha256(stableJson({ line1: a.line1, district: a.district, city: a.city, country: a.country, instructions: a.instructions ?? null, ...live }));
}

export function toDeliveryAddress(a: AddressRow): DeliveryAddress {
  return { fingerprint: addressFingerprint(a), label: a.label, line1: a.line1, district: a.district, city: a.city, country: a.country, instructions: a.instructions };
}

/** Minimal representation for MCP responses: label + district only (no street, no instructions). */
export function maskedAddress(a: AddressRow | null) {
  if (!a) return null;
  return { address_id: a.id, label: a.label, area: `${a.district}, ${a.city}` };
}

export function validateAddressInput(input: {
  label: string; line1: string; district: string; city: string; country: string; instructions?: string;
  /** Optional, for Live: "lat, lng" pasted from a map, contact name and phone (E.164). */
  coordinates?: string; contact_name?: string; contact_phone?: string;
}) {
  const coords = parseCoordinates(input.coordinates);
  const clean = {
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    contact_name: normalizeContactName(input.contact_name),
    contact_phone: normalizePhone(input.contact_phone),
    label: input.label.trim().slice(0, 40),
    line1: input.line1.trim().slice(0, 200),
    district: input.district.trim().slice(0, 80),
    city: input.city.trim().slice(0, 80),
    country: input.country.trim().toUpperCase().slice(0, 2),
    instructions: input.instructions?.trim().slice(0, 300) || null,
  };
  const problems: string[] = [];
  if (!clean.label) problems.push('label');
  if (clean.line1.length < 5 || !/\d/.test(clean.line1)) problems.push('line1'); // needs a house/building number
  if (clean.district.length < 2) problems.push('district');
  if (clean.city.length < 2) problems.push('city');
  if (!REGION_CODES.includes(clean.country)) problems.push('country');
  if (problems.length) throw new DomainError('ADDRESS_AMBIGUOUS', 'Address is incomplete or ambiguous', { fields: problems });
  return clean;
}

export async function listAddresses(q: Queryable, userId: string): Promise<AddressRow[]> {
  return (await q.query<AddressRow>('SELECT * FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at', [userId])).rows;
}

export async function getAddress(q: Queryable, userId: string, id: string): Promise<AddressRow> {
  const r = await q.query<AddressRow>('SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Address not found');
  return r.rows[0];
}

export async function getDefaultAddress(q: Queryable, userId: string): Promise<AddressRow | null> {
  return (await listAddresses(q, userId))[0] ?? null;
}

export async function addAddress(ctx: Ctx, userId: string, input: Parameters<typeof validateAddressInput>[0], makeDefault: boolean) {
  const a = validateAddressInput(input);
  return ctx.db.tx(async (q) => {
    const count = (await q.query('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1 AND deleted_at IS NULL', [userId])).rows[0].n;
    if (count >= 10) throw new DomainError('VALIDATION_FAILED', 'Too many addresses (max 10)');
    const isDefault = makeDefault || count === 0;
    if (isDefault) await q.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
    const r = await q.query<AddressRow>(
      `INSERT INTO addresses (user_id, label, line1, district, city, country, instructions, is_default, latitude, longitude, contact_name, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, a.label, a.line1, a.district, a.city, a.country, a.instructions, isDefault, a.latitude, a.longitude, a.contact_name, a.contact_phone],
    );
    await audit(q, { userId, actor: 'web', action: 'address.added', entity: 'address', entityId: r.rows[0].id });
    return r.rows[0];
  });
}

/**
 * Addresses are immutable once created (carts and checkouts reference them); deleting soft-deletes and scrubs
 * every free-text field: label, street, district, city and instructions become '[deleted]' / NULL. Only country
 * is kept (NOT NULL, two-letter region code). This is safe for history: cart_versions.address_id is ON DELETE
 * SET NULL and the row is kept anyway, checkouts store only an address fingerprint (open ones are invalidated
 * below), and orders keep their own address_label copy taken at acceptance. A submission accepted late (found
 * by reconciliation after the address was deleted) records '[deleted]' as its label, which is intended.
 */
export async function deleteAddress(ctx: Ctx, userId: string, id: string) {
  await ctx.db.tx(async (q) => {
    const r = await q.query(
      `UPDATE addresses SET deleted_at = now(), is_default = false, label = '[deleted]', line1 = '[deleted]', district = '[deleted]', city = '[deleted]', instructions = NULL,
         latitude = NULL, longitude = NULL, contact_name = NULL, contact_phone = NULL
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, userId],
    );
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Address not found');
    // Any open checkout that used this address is no longer valid.
    await q.query(
      `UPDATE checkouts c SET status='invalidated', invalid_reason='ADDRESS_CHANGED' FROM carts k, cart_versions v
       WHERE c.cart_id = k.id AND v.cart_id = k.id AND v.version = c.cart_version AND v.address_id = $1 AND c.status IN ('awaiting_user','approved')`,
      [id],
    );
    const first = await q.query('SELECT id FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1', [userId]);
    if (first.rows[0]) await q.query('UPDATE addresses SET is_default = true WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM addresses WHERE user_id=$2 AND is_default AND deleted_at IS NULL)', [first.rows[0].id, userId]);
    await audit(q, { userId, actor: 'web', action: 'address.deleted', entity: 'address', entityId: id });
  });
}

export async function setDefaultAddress(ctx: Ctx, userId: string, id: string) {
  await ctx.db.tx(async (q) => {
    await getAddress(q, userId, id);
    await q.query('UPDATE addresses SET is_default = (id = $2) WHERE user_id = $1 AND deleted_at IS NULL', [userId, id]);
  });
}

// ---------------- Preferences ----------------
export interface Preferences {
  dietary: string[];
  allergies: string[];
  default_party_size: number;
}
export async function getPreferences(q: Queryable, userId: string): Promise<Preferences> {
  const r = await q.query('SELECT dietary, allergies, default_party_size FROM preferences WHERE user_id = $1', [userId]);
  return r.rows[0] ?? { dietary: [], allergies: [], default_party_size: 1 };
}
export async function savePreferences(q: Queryable, userId: string, p: Preferences) {
  const dietary = p.dietary.filter((d) => (DIETS as readonly string[]).includes(d));
  const allergies = p.allergies.filter((d) => (ALLERGENS as readonly string[]).includes(d));
  const size = Math.min(Math.max(Math.trunc(p.default_party_size) || 1, 1), 20);
  await q.query(
    `INSERT INTO preferences (user_id, dietary, allergies, default_party_size, updated_at) VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (user_id) DO UPDATE SET dietary = $2, allergies = $3, default_party_size = $4, updated_at = now()`,
    [userId, JSON.stringify(dietary), JSON.stringify(allergies), size],
  );
}

// ---------------- Data rights ----------------
export async function exportUserData(q: Queryable, userId: string) {
  // Every value below is plain JSON (text, numbers, booleans, jsonb, timestamps); no bytea/public keys, no token hashes.
  const one = async (sql: string) => (await q.query(sql, [userId])).rows;
  return {
    exported_at: new Date().toISOString(),
    user: (await one('SELECT id, email, locale, region, mode, onboarded_at, created_at FROM users WHERE id = $1'))[0],
    preferences: (await one('SELECT dietary, allergies, default_party_size, updated_at FROM preferences WHERE user_id = $1'))[0] ?? null,
    addresses: await one('SELECT label, line1, district, city, country, instructions, latitude, longitude, contact_name, contact_phone, is_default, created_at FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at'),
    passkeys: await one(
      `SELECT left(id, 8) || '…' AS credential_id_prefix, label, device_type, backed_up, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
    ),
    provider_connections: await one('SELECT provider, mode, status, created_at, revoked_at FROM provider_connections WHERE user_id = $1 ORDER BY created_at'),
    grab_sign_in: await one('SELECT issuer, created_at, last_login_at FROM grab_identities WHERE user_id = $1'),
    carts: await one(
      `SELECT k.id, k.mode, k.service, k.restaurant_name, k.status, k.created_at, k.updated_at,
         COALESCE((SELECT json_agg(json_build_object('version', v.version, 'items', v.items, 'trip', v.trip, 'created_at', v.created_at) ORDER BY v.version)
                   FROM cart_versions v WHERE v.cart_id = k.id), '[]'::json) AS versions
       FROM carts k WHERE k.user_id = $1 ORDER BY k.created_at`,
    ),
    quotes: await one(
      `SELECT id, cart_id, cart_version, mode, currency, lines, subtotal_minor, delivery_fee_minor, service_fee_minor, small_order_fee_minor,
         discount_minor, total_minor, eta_min_minutes, eta_max_minutes, price_source, checkout_allowed, fetched_at, expires_at, created_at
       FROM quotes WHERE user_id = $1 ORDER BY created_at`,
    ),
    checkouts: await one(
      `SELECT id, cart_id, cart_version, quote_id, mode, total_minor, currency, payment_method_label, status, invalid_reason,
         expires_at, approved_at, approved_via, consumed_at, created_by, created_at
       FROM checkouts WHERE user_id = $1 ORDER BY created_at`,
    ),
    submissions: await one(
      `SELECT id, checkout_id, mode, status, provider_order_ref, error_code, started_at, finished_at
       FROM submission_attempts WHERE user_id = $1 ORDER BY started_at`,
    ),
    orders: await one(
      `SELECT o.id, o.mode, o.service, o.provider, o.provider_order_ref, o.restaurant_name, o.address_label,
         CASE WHEN o.service IN ('ride','express') THEN o.address_label END AS trip_label,
         o.items, o.total_minor, o.currency, o.fulfillment_status, o.payment_status, o.eta_at, o.created_at
       FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at`,
    ),
    cancellation_requests: await one(
      `SELECT id, order_id, fee_minor, currency, terms, status, error_code, expires_at, approved_at, executed_at, created_at
       FROM cancellation_requests WHERE user_id = $1 ORDER BY created_at`,
    ),
    handoffs: await one('SELECT cart_id, cart_version, url, checklist, created_at FROM handoffs WHERE user_id = $1 ORDER BY created_at'),
    ai_connections: await one('SELECT client_name, scopes, created_at, last_used_at, revoked_at FROM oauth_grants WHERE user_id = $1 ORDER BY created_at'),
    personal_tokens: await one('SELECT name, scopes, created_at, expires_at, last_used_at, revoked_at FROM personal_tokens WHERE user_id = $1 ORDER BY created_at'),
    activity: await one('SELECT action, actor, mode, entity, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at'),
  };
}

/**
 * Deletes the account and personal data. Audit rows are kept without user linkage.
 * NOTE: in Live mode, provider-side order records are governed by Grab's own retention.
 */
export async function deleteAccount(ctx: Ctx, userId: string) {
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE audit_log SET user_id = NULL, details = $2 WHERE user_id = $1', [userId, JSON.stringify({ scrubbed: true })]);
    await q.query('DELETE FROM users WHERE id = $1', [userId]);
    await audit(q, { actor: 'web', action: 'user.deleted' });
  });
}
