// Partner apps that call Unyly server to server (Ari first). Credentials come from the environment:
//   PARTNERS=ari                         comma-separated partner ids
//   PARTNER_ARI_NAME=Ari                 display name
//   PARTNER_ARI_SECRET=<32+ random chars> request signing secret (HMAC-SHA256)
//   PARTNER_ARI_WEBHOOK_URL=https://...  where Unyly sends order events (optional)
//   PARTNER_ARI_WEBHOOK_SECRET=...       webhook signing secret (defaults to PARTNER_ARI_SECRET)
//   PARTNER_ARI_MODE=demo|live           which Unyly mode this partner's users run in (default demo)
//   PARTNER_ARI_RETURN_URL=ari://grab    where Login with Grab returns (custom scheme or https)
// A built-in "ari-web" partner powers the browser demo on the website. It has no secret and is reachable
// only in-process (never through the signed HTTP API).

export type PartnerMode = 'demo' | 'live';

export interface PartnerConfig {
  id: string;
  name: string;
  secret: string;
  webhookUrl?: string;
  webhookSecret: string;
  mode: PartnerMode;
  returnUrl?: string;
  /** In-process only: the website demo. */
  internal?: boolean;
}

export const WEB_DEMO_PARTNER: PartnerConfig = {
  id: 'ari-web', name: 'Ari (web demo)', secret: '', webhookSecret: '', mode: 'demo', internal: true,
};

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * A signing secret that must not reach production: shorter than 32 characters, a placeholder left over from
 * an example, or hardly any variety (one character repeated, "abcabcabc"). Real ones come from `openssl rand -hex 32`.
 */
export function isWeakSecret(s: string): boolean {
  return s.length < 32 || /change[_-]?me|dev-only|example|placeholder|your[_-]?secret|secret[_-]?here|<[^>]*>/i.test(s) || new Set(s).size < 8 || /^(.{1,16})\1+$/.test(s);
}

export function loadPartners(env: NodeJS.ProcessEnv, appEnv: string): PartnerConfig[] {
  const ids = (env.PARTNERS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const out: PartnerConfig[] = [];
  for (const id of ids) {
    if (!ID_RE.test(id) || id === WEB_DEMO_PARTNER.id) throw new Error(`PARTNERS: invalid partner id "${id}"`);
    const k = (s: string) => env[`PARTNER_${id.toUpperCase().replace(/-/g, '_')}_${s}`]?.trim();
    const secret = k('SECRET') ?? '';
    if (secret.length < 32) throw new Error(`PARTNER_${id.toUpperCase()}_SECRET must be at least 32 characters (openssl rand -hex 32)`);
    if (appEnv === 'production' && isWeakSecret(secret)) throw new Error(`PARTNER_${id.toUpperCase()}_SECRET looks like a placeholder or has too little variety: use a random value in production (openssl rand -hex 32)`);
    const mode = (k('MODE') || 'demo').toLowerCase();
    if (mode !== 'demo' && mode !== 'live') throw new Error(`PARTNER_${id.toUpperCase()}_MODE must be demo or live`);
    const webhookUrl = k('WEBHOOK_URL') || undefined;
    if (webhookUrl && appEnv === 'production' && !webhookUrl.startsWith('https://')) throw new Error(`PARTNER_${id.toUpperCase()}_WEBHOOK_URL must be https in production`);
    const returnUrl = k('RETURN_URL') || undefined;
    if (returnUrl && !/^(https:\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(returnUrl)) throw new Error(`PARTNER_${id.toUpperCase()}_RETURN_URL must be https or an app scheme`);
    const webhookSecret = k('WEBHOOK_SECRET') ?? '';
    // A separate secret per direction: a webhook signed by Unyly must never be a valid partner request.
    if (webhookUrl && (webhookSecret.length < 32 || webhookSecret === secret)) throw new Error(`PARTNER_${id.toUpperCase()}_WEBHOOK_SECRET must be set (32+ characters, different from the request secret) when a webhook URL is configured`);
    if (webhookUrl && appEnv === 'production' && isWeakSecret(webhookSecret)) throw new Error(`PARTNER_${id.toUpperCase()}_WEBHOOK_SECRET looks like a placeholder or has too little variety: use a random value in production (openssl rand -hex 32)`);
    out.push({ id, name: k('NAME') || id, secret, webhookUrl, webhookSecret: webhookSecret || secret, mode, returnUrl });
  }
  return out;
}

export function findPartner(list: PartnerConfig[], id: string): PartnerConfig | undefined {
  if (id === WEB_DEMO_PARTNER.id) return WEB_DEMO_PARTNER;
  return list.find((p) => p.id === id);
}
