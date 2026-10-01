// Exact places for Live mode. Real couriers and Grab's fare engine need precise coordinates
// (Grab asks for at least 6 decimal places) and a street address, so Live never uses the approximate
// demo gazetteer: pickup and drop-off are saved addresses with coordinates the user pasted from a map.
import { DomainError } from '../../domain/errors.js';
import type { Place, SavedPlaceInfo } from '../types.js';

/**
 * Parses "lat, lng" as copied from a map app ("13.746228, 100.534713"). Each value needs at least
 * 5 decimal places (about 1 m); values are stored rounded to 6. Returns null for empty input.
 */
export function parseCoordinates(input: string | undefined | null): { latitude: number; longitude: number } | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const m = /^\(?\s*(-?\d{1,2}\.(\d{5,}))\s*[,;\s]\s*(-?\d{1,3}\.(\d{5,}))\s*\)?$/.exec(raw);
  if (!m) {
    throw new DomainError('VALIDATION_FAILED', 'Coordinates must be "latitude, longitude" with at least 5 decimal places, e.g. 13.746228, 100.534713', { field: 'coordinates' });
  }
  const latitude = Math.round(Number(m[1]) * 1e6) / 1e6;
  const longitude = Math.round(Number(m[3]) * 1e6) / 1e6;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) {
    throw new DomainError('VALIDATION_FAILED', 'Coordinates are out of range', { field: 'coordinates' });
  }
  return { latitude, longitude };
}

/** International phone in E.164 (+ and 8 to 15 digits). Stored with the plus; Grab gets digits only. */
export function normalizePhone(input: string | undefined | null): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
    throw new DomainError('VALIDATION_FAILED', 'Phone must be in international format with the country code, e.g. +66 81 234 5678', { field: 'contact_phone' });
  }
  return digits;
}

export function normalizeContactName(input: string | undefined | null): string | null {
  const v = (input ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return null;
  if (v.length > 60 || /[\u0000-\u001f\u007f]/.test(v)) throw new DomainError('VALIDATION_FAILED', 'Contact name must be 1-60 characters', { field: 'contact_name' });
  return v;
}

const norm = (s: string) => s.toLowerCase().replace(/[.,;:!?()"'«»]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Live resolver: only the user's saved addresses, matched by label. An address without coordinates is
 * refused with an action for the assistant (never approximated from a district or landmark).
 */
export function resolveLivePlace(text: string, saved: SavedPlaceInfo[], addressesUrl: string):
  | { ok: true; place: Place }
  | { ok: false; code: 'PLACE_NOT_FOUND' | 'PLACE_AMBIGUOUS'; message: string; suggestions: string[] } {
  const q = norm(text);
  const hits = saved.filter((a) => norm(a.label) === q);
  if (hits.length > 1) {
    return { ok: false, code: 'PLACE_AMBIGUOUS', message: `Several saved addresses are called "${text.slice(0, 40)}"`, suggestions: hits.map((h) => h.label) };
  }
  const a = hits[0];
  if (!a) {
    return {
      ok: false, code: 'PLACE_NOT_FOUND',
      message: `In Live mode pickup and drop-off must be the label of a saved address with exact coordinates ("${text.slice(0, 60)}" is not one). Landmarks and districts are not precise enough for a real courier or driver.`,
      suggestions: saved.map((s) => s.label).slice(0, 10),
    };
  }
  if (a.latitude == null || a.longitude == null) {
    throw new DomainError(
      'ADDRESS_REQUIRED',
      `Saved address "${a.label}" has no exact coordinates, which Grab requires for a real courier or driver.`,
      { address_id: a.id, label: a.label, missing: ['coordinates'], addresses_url: addressesUrl },
      `Ask the user to open ${addressesUrl} and add "${a.label}" again with exact coordinates ("latitude, longitude" copied from a map app) and a contact phone. Then retry with that address label.`,
    );
  }
  return { ok: true, place: { name: a.label, lat: a.latitude, lng: a.longitude, kind: 'saved_address', area: `${a.district}, ${a.city}`, address_id: a.id } };
}
