// Contract tests for Live ride estimates (Grab Partner Farefeed) against the mock Grab server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGrabConfig } from '../src/providers/grab/config.js';
import { GrabLiveProvider, RIDE_BOOKING_REASON } from '../src/providers/grab/provider.js';
import { addAddress } from '../src/services/users.js';
import { Harness, mcpClient, oauthToken, startHarness, webLogin } from './helpers.js';
import { GrabMock, mockGrabEnv, startGrabMock } from './support/grab-mock.js';

let mock: GrabMock;
let h: Harness;
let u: { cookie: string; csrf: string; userId: string; mcp: Awaited<ReturnType<typeof mcpClient>> };

beforeAll(async () => {
  mock = await startGrabMock();
  // Farefeed only: express stays off.
  h = await startHarness({ cfg: { grab: loadGrabConfig(mockGrabEnv(mock, { GRAB_FAREFEED: 'on' })) } });
  const s = await webLogin(h, 'rider@example.com');
  const mode = await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'live' } });
  expect(mode.statusCode).toBe(302); // Live is selectable with ride estimates alone
  await addAddress(h.ctx, s.userId, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Khlong Toei', city: 'Bangkok', country: 'TH', coordinates: '13.722103, 100.567800' }, true);
  await addAddress(h.ctx, s.userId, { label: 'Airport', line1: '999 Moo 1 Nong Prue', district: 'Bang Phli', city: 'Samut Prakan', country: 'TH', coordinates: '13.690000, 100.750100' }, false);
  await addAddress(h.ctx, s.userId, { label: 'Old place', line1: '5 Silom Road', district: 'Bang Rak', city: 'Bangkok', country: 'TH' }, false);
  const tok = await oauthToken(h, s);
  u = { ...s, mcp: await mcpClient(h, tok.access_token) };
});
afterAll(async () => {
  await u.mcp.close();
  await h.close();
  await mock.close();
});

describe('Live ride estimates (Farefeed)', () => {
  it('estimate_trip returns fare ranges, ETA, surge and deep links; nothing is booked', async () => {
    mock.knobs.farefeedEvilLink = true;
    const r = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Home', dropoff: 'Airport' });
    mock.knobs.farefeedEvilLink = false;
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('live');
    const [just, share, odd] = r.result.options;
    expect(just).toMatchObject({
      item_id: 'ride-302', name: 'JustGrab', surge: 'NONE', booking: 'in_grab_app',
      estimated_total: { amount_minor: 15000, currency: 'THB' },
      fare_range: { min: { amount_minor: 15000 }, max: { amount_minor: 19000 } },
      eta_estimate_minutes: { min: 4, max: 4 },
    });
    expect(just.deep_link).toMatch(/^https:\/\/grab\.onelink\.me\//);
    expect(just.direct_deep_link).toMatch(/^grab:\/\/open\?/);
    expect(share).toMatchObject({ name: 'GrabShare', surge: 'LOW_SURGE', fare_range: { min: { amount_minor: 9850 } } });
    // Links that do not point to Grab are dropped, unknown surge values are flagged.
    expect(odd.deep_link).toBeNull();
    expect(odd.direct_deep_link).toBeNull();
    expect(odd.surge).toBe('UNKNOWN');
    expect(r.result.note).toMatch(/no API to book a ride/);
    const body = mock.ops('farefeed').at(-1)!.body;
    expect(body.pickUp).toEqual({ latitude: 13.722103, longitude: 100.5678, address: '12/3 Sukhumvit Soi 24, Khlong Toei, Bangkok' });
    expect(body.dropOff.latitude).toBe(13.69);
    expect(mock.tokenRequests.map((t) => t.scope)).toContain('ride.estimate');
    expect(mock.ops('create')).toHaveLength(0);
  });

  it('booking a ride is not possible: there is no Grab ride booking API', async () => {
    const r = await u.mcp.call('create_cart', { service: 'ride', pickup: 'Home', dropoff: 'Airport', items: [{ item_id: 'ride-302', quantity: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(JSON.stringify(r.error)).toContain('deep_link');
    const p = h.ctx.providers.live as GrabLiveProvider;
    expect(p.capabilities().submit_order.reason).toContain(RIDE_BOOKING_REASON);
    expect(p.capabilities().quote.available).toBe(true);
  });

  it('express is off: estimate for a parcel is CAPABILITY_UNAVAILABLE; webhook route answers 404', async () => {
    const r = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Home', dropoff: 'Airport', parcel_weight_kg: 1 });
    expect(r.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(r.error.message + JSON.stringify(r.error.details)).toMatch(/GRAB_EXPRESS=off/);
    const w = await mock.emitWebhook(h.baseUrl, { deliveryID: 'x', timestamp: 1, status: 'ALLOCATING' }, { authorization: 'whatever' });
    expect(w.status).toBe(404);
  });

  it('missing coordinates, no service area, and Grab outages are explicit errors', async () => {
    const nc = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Old place', dropoff: 'Airport' });
    expect(nc.error.code).toBe('ADDRESS_REQUIRED');
    expect(nc.error.user_action).toMatch(/coordinates/);
    mock.knobs.farefeedNotFound = true;
    const nf = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Home', dropoff: 'Airport' });
    mock.knobs.farefeedNotFound = false;
    expect(nf.error.code).toBe('OUTSIDE_SERVICE_AREA');
    mock.expireTokens();
    const again = await u.mcp.call('estimate_trip', { service: 'ride', pickup: 'Home', dropoff: 'Airport' });
    expect(again.ok).toBe(true); // 401 -> token refreshed once -> success
  });
});
