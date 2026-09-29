import type { Config } from './config.js';
import type { Db, Queryable } from './db/db.js';
import { DemoProvider } from './providers/demo/provider.js';
import { HandoffGrabProvider, LiveGrabProvider } from './providers/unavailable.js';
import type { Mode, Provider } from './providers/types.js';
import { createMailer, Mailer } from './services/mailer.js';

export interface Clock {
  now(): Date;
}

/** Test-friendly clock: real time plus an adjustable offset. */
export class OffsetClock implements Clock {
  offsetMs = 0;
  now() {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number) {
    this.offsetMs += ms;
  }
}

export interface Providers {
  demo: DemoProvider;
  handoff: HandoffGrabProvider;
  live: LiveGrabProvider;
}

export interface Ctx {
  cfg: Config;
  db: Db;
  clock: Clock;
  providers: Providers;
  mailer: Mailer;
  provider(mode: Mode): Provider;
}

/** Who is acting. user_id always comes from an authenticated session or token, never from tool arguments. */
export interface Actor {
  userId: string;
  via: 'web' | 'mcp' | 'system';
  clientId?: string;
  scopes?: string[];
}
export const actorLabel = (a: Actor) => (a.via === 'mcp' ? `mcp:${a.clientId}` : a.via);

export function createCtx(cfg: Config, db: Db, clock: Clock = new OffsetClock()): Ctx {
  const providers: Providers = {
    demo: new DemoProvider({ db, now: () => clock.now(), webhookSecret: cfg.demoWebhookSecret, timeScale: cfg.demoTimeScale }),
    handoff: new HandoffGrabProvider(),
    live: new LiveGrabProvider(),
  };
  return {
    cfg,
    db,
    clock,
    providers,
    mailer: createMailer(cfg),
    provider: (mode) => providers[mode],
  };
}

export async function audit(
  q: Queryable,
  e: { userId?: string | null; actor: string; action: string; mode?: string | null; entity?: string; entityId?: string; details?: Record<string, unknown> },
) {
  await q.query(
    'INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [e.userId ?? null, e.actor, e.action, e.mode ?? null, e.entity ?? null, e.entityId ?? null, JSON.stringify(e.details ?? {})],
  );
}
