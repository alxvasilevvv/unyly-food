// Temporary diagnostic: where this host is on the network (used once to choose the database region).
import { connect } from 'node:net';

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-northeast-1'];
let result: Record<string, unknown> | null = null;

function tcpMs(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = connect({ host, port: 5432 });
    const done = (v: number | null) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(3000, () => done(null));
    s.once('connect', () => done(Math.round(performance.now() - t0)));
    s.once('error', () => done(null));
  });
}

export function startNetProbe() {
  if (process.env.NET_PROBE !== '1') return;
  void (async () => {
    const out: Record<string, unknown> = {};
    try {
      const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(4000) })).text();
      out.colo = /colo=(\w+)/.exec(t)?.[1] ?? null;
      out.loc = /loc=(\w+)/.exec(t)?.[1] ?? null;
    } catch {
      out.colo = null;
    }
    for (const r of REGIONS) {
      const host = `aws-0-${r}.pooler.supabase.com`;
      await tcpMs(host); // DNS warm-up
      out[r] = Math.min(...(await Promise.all([tcpMs(host), tcpMs(host)])).map((x) => x ?? 9999));
    }
    result = out;
  })();
}

export const netProbe = () => result;
