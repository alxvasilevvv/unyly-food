// Grab markets and service entry points. Only Thailand has been checked page by page; the other
// markets link to Grab's country home page and are marked unverified until someone checks them.
// None of these links carries a pickup, drop-off, store or cart: Grab documents no such parameters.

export type Service = 'food' | 'mart' | 'ride' | 'express';
export const SERVICES: Service[] = ['food', 'mart', 'ride', 'express'];
/** Services priced by a trip (pickup -> dropoff) instead of a delivery address. */
export const TRIP_SERVICES: Service[] = ['ride', 'express'];
export const isTripService = (s: Service) => TRIP_SERVICES.includes(s);

export const SERVICE_LABEL: Record<Service, string> = {
  food: 'GrabFood (restaurant delivery)',
  mart: 'GrabMart (groceries, flowers, pharmacy, cakes)',
  ride: 'Grab transport (taxi, car, bike)',
  express: 'GrabExpress (send a parcel)',
};

export interface GrabLink {
  url: string;
  verified: boolean;
  checked_at?: string;
  note: string;
}

export interface Region {
  code: string;
  name: string;
  currency: string;
  /** Demo catalog exists (synthetic stores, places and fares). */
  demo_city: string | null;
  links: Record<Service, GrabLink>;
}

const CHECKED = '2026-09-30';
const verified = (url: string): GrabLink => ({ url, verified: true, checked_at: CHECKED, note: 'Official Grab page for this service. Opens the service, not a specific store, trip or cart.' });
const home = (cc: string): GrabLink => ({
  url: `https://www.grab.com/${cc}/`,
  verified: false,
  note: 'Grab country home page. The service-specific page for this market has not been checked yet; the user picks the service in the Grab app.',
});

function market(code: string, name: string, currency: string): Region {
  const cc = code.toLowerCase();
  return { code, name, currency, demo_city: null, links: { food: home(cc), mart: home(cc), ride: home(cc), express: home(cc) } };
}

export const REGIONS: Record<string, Region> = {
  TH: {
    code: 'TH', name: 'Thailand', currency: 'THB', demo_city: 'Bangkok',
    links: {
      food: verified('https://food.grab.com/th/en/'),
      mart: verified('https://www.grab.com/th/en/mart/'),
      ride: verified('https://www.grab.com/th/en/transport/'),
      express: verified('https://www.grab.com/th/en/express/'),
    },
  },
  SG: market('SG', 'Singapore', 'SGD'),
  MY: market('MY', 'Malaysia', 'MYR'),
  ID: market('ID', 'Indonesia', 'IDR'),
  VN: market('VN', 'Vietnam', 'VND'),
  PH: market('PH', 'Philippines', 'PHP'),
  KH: market('KH', 'Cambodia', 'USD'),
  MM: market('MM', 'Myanmar', 'MMK'),
};
export const REGION_CODES = Object.keys(REGIONS);
export const regionOf = (code: string): Region => REGIONS[code] ?? REGIONS.TH;
