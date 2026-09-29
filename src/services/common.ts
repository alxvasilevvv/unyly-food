import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import { DomainError } from '../domain/errors.js';
import { CapabilityKey, CapabilityUnavailableError, Mode, ProviderOutcomeUnknownError, ProviderUnavailableError } from '../providers/types.js';

export function requireCapability(ctx: Ctx, mode: Mode, cap: CapabilityKey) {
  const c = ctx.provider(mode).capabilities()[cap];
  if (!c.available) {
    throw new DomainError('CAPABILITY_UNAVAILABLE', `"${cap}" is not available in ${mode} mode`, { capability: cap, mode, reason: c.reason, source: c.source });
  }
}

/**
 * Maps provider exceptions to domain errors. Crucially, a provider failure is reported as
 * PROVIDER_UNAVAILABLE and is NEVER silently replaced with demo data.
 */
export async function callProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof DomainError) throw e;
    if (e instanceof CapabilityUnavailableError) throw new DomainError('CAPABILITY_UNAVAILABLE', e.reason, { capability: e.capability });
    if (e instanceof ProviderUnavailableError || e instanceof ProviderOutcomeUnknownError) {
      throw new DomainError('PROVIDER_UNAVAILABLE', 'The provider is temporarily unavailable. No fallback data was used.', { provider_message: e.message });
    }
    if (e?.notFound) throw new DomainError('NOT_FOUND', 'Not found at provider');
    throw e;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(onTimeout()), ms);
    }),
  ]);
}

export async function submissionsEnabled(ctx: Ctx, q: Queryable, mode: Mode): Promise<boolean> {
  if (!ctx.cfg.submissionsEnabledEnv) return false;
  const r = await q.query("SELECT value FROM settings WHERE key = 'submissions'");
  return Boolean(r.rows[0]?.value?.[mode]);
}

export async function setSubmissionsEnabled(q: Queryable, mode: Mode, enabled: boolean) {
  await q.query(
    `UPDATE settings SET value = jsonb_set(value, $1, $2::jsonb), updated_at = now() WHERE key = 'submissions'`,
    [`{${mode}}`, JSON.stringify(enabled)],
  );
}

export const newLineId = () => `l_${Math.random().toString(36).slice(2, 10)}`;
