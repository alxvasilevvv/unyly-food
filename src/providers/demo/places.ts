// Demo place resolver for Bangkok: a small gazetteer of landmarks and district centres with
// English, Russian and Thai names. Coordinates are approximate public locations, used only to
// estimate synthetic demo fares. A live integration would use GrabMaps (AWS Location Service).
import { sha256, stableJson } from '../../domain/crypto.js';
import type { Place, Trip } from '../types.js';

interface Landmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
  airport?: boolean;
}

export const LANDMARKS: Landmark[] = [
  { id: 'bkk', name: 'Suvarnabhumi Airport (BKK)', lat: 13.69, lng: 100.7501, airport: true, aliases: ['suvarnabhumi', 'bkk', 'суварнабхуми', 'สุวรรณภูมิ', 'สนามบินสุวรรณภูมิ'] },
  { id: 'dmk', name: 'Don Mueang Airport (DMK)', lat: 13.9126, lng: 100.6068, airport: true, aliases: ['don mueang', 'donmueang', 'don muang', 'dmk', 'дон муанг', 'донмуанг', 'дон мыанг', 'ดอนเมือง', 'สนามบินดอนเมือง'] },
  { id: 'paragon', name: 'Siam Paragon', lat: 13.7462, lng: 100.5347, aliases: ['siam paragon', 'paragon', 'siam', 'сиам парагон', 'парагон', 'сиам', 'สยามพารากอน', 'พารากอน', 'สยาม'] },
  { id: 'iconsiam', name: 'ICONSIAM', lat: 13.7266, lng: 100.5103, aliases: ['iconsiam', 'icon siam', 'айконсиам', 'айкон сиам', 'ไอคอนสยาม'] },
  { id: 'chatuchak', name: 'Chatuchak Weekend Market', lat: 13.7999, lng: 100.55, aliases: ['chatuchak', 'jatujak', 'chatuchak market', 'чатучак', 'จตุจักร', 'ตลาดนัดจตุจักร'] },
  { id: 'palace', name: 'Grand Palace', lat: 13.75, lng: 100.4913, aliases: ['grand palace', 'royal palace', 'королевский дворец', 'большой дворец', 'พระบรมมหาราชวัง', 'วังหลวง'] },
  { id: 'khaosan', name: 'Khao San Road', lat: 13.7589, lng: 100.4974, aliases: ['khao san', 'khaosan', 'каосан', 'као сан', 'ข้าวสาร'] },
  { id: 'asok', name: 'Asok / Terminal 21', lat: 13.7373, lng: 100.5603, aliases: ['asok', 'asoke', 'terminal 21', 'terminal21', 'асок', 'асоке', 'терминал 21', 'อโศก', 'เทอร์มินอล 21', 'เทอมินอล21'] },
  { id: 'lumphini', name: 'Lumphini Park', lat: 13.7314, lng: 100.5418, aliases: ['lumphini', 'lumpini', 'люмпини', 'лумпини', 'ลุมพินี', 'สวนลุมพินี'] },
  { id: 'saladaeng', name: 'Sala Daeng', lat: 13.7285, lng: 100.5343, aliases: ['sala daeng', 'saladaeng', 'silom', 'сала дэнг', 'силом', 'ศาลาแดง', 'สีลม'] },
  { id: 'thonglo', name: 'Thong Lo', lat: 13.7246, lng: 100.5785, aliases: ['thong lo', 'thonglor', 'thong lor', 'тонглор', 'тонг ло', 'ทองหล่อ'] },
  { id: 'bangsue', name: 'Krung Thep Aphiwat Central Terminal (Bang Sue)', lat: 13.8039, lng: 100.54, aliases: ['bang sue', 'bangsue', 'krung thep aphiwat', 'central terminal', 'бангсы', 'банг су', 'บางซื่อ', 'กรุงเทพอภิวัฒน์'] },
  { id: 'yaowarat', name: 'Yaowarat (Chinatown)', lat: 13.74, lng: 100.51, aliases: ['yaowarat', 'chinatown', 'яоварат', 'чайнатаун', 'китайский квартал', 'เยาวราช'] },
  { id: 'ekkamai', name: 'Ekkamai', lat: 13.7196, lng: 100.5852, aliases: ['ekkamai', 'эккамай', 'เอกมัย'] },
];

export const DISTRICT_CENTRES: Record<string, { lat: number; lng: number; aliases: string[] }> = {
  Watthana: { lat: 13.738, lng: 100.585, aliases: ['watthana', 'ваттхана', 'วัฒนา'] },
  'Khlong Toei': { lat: 13.722, lng: 100.56, aliases: ['khlong toei', 'klong toey', 'кхлонг той', 'คลองเตย'] },
  'Pathum Wan': { lat: 13.744, lng: 100.531, aliases: ['pathum wan', 'pathumwan', 'патхумван', 'ปทุมวัน'] },
  'Bang Rak': { lat: 13.729, lng: 100.524, aliases: ['bang rak', 'bangrak', 'банграк', 'บางรัก'] },
  Sathon: { lat: 13.72, lng: 100.529, aliases: ['sathon', 'sathorn', 'саторн', 'สาทร'] },
  Ratchathewi: { lat: 13.758, lng: 100.534, aliases: ['ratchathewi', 'ратчатхеви', 'ราชเทวี'] },
  'Phaya Thai': { lat: 13.78, lng: 100.542, aliases: ['phaya thai', 'phayathai', 'пхаятхай', 'พญาไท'] },
  'Huai Khwang': { lat: 13.776, lng: 100.579, aliases: ['huai khwang', 'huai kwang', 'хуай кхванг', 'ห้วยขวาง'] },
  'Din Daeng': { lat: 13.77, lng: 100.555, aliases: ['din daeng', 'диндэнг', 'дин дэнг', 'ดินแดง'] },
  Chatuchak: { lat: 13.828, lng: 100.56, aliases: [] }, // the word "Chatuchak" resolves to the market landmark
};

const AIRPORT_WORDS = ['airport', 'аэропорт', 'สนามบิน'];

const THAI = /[\u0E00-\u0E7F]/;
/** Latin/Cyrillic aliases match at a word start (so Russian case endings work); Thai has no spaces, so substring. */
const hits = (q: string, alias: string) => (THAI.test(alias) ? q.includes(alias) : q.includes(` ${alias}`));
const norm = (s: string) => ` ${s.toLowerCase().replace(/[.,;:!?()"'«»]/g, ' ').replace(/\s+/g, ' ').trim()} `;

export interface SavedPlace {
  label: string;
  district: string;
  city: string;
}

export type PlaceResult = { ok: true; place: Place } | { ok: false; code: 'PLACE_NOT_FOUND' | 'PLACE_AMBIGUOUS'; message: string; suggestions: string[] };

/** Resolve a place: saved address label, landmark, then district centre. */
export function resolvePlace(text: string, saved: SavedPlace[] = []): PlaceResult {
  const raw = text.trim();
  const q = norm(raw);
  if (!raw) return { ok: false, code: 'PLACE_NOT_FOUND', message: 'Empty place', suggestions: LANDMARKS.slice(0, 5).map((l) => l.name) };

  const own = saved.find((a) => norm(a.label) === q);
  if (own) {
    const c = DISTRICT_CENTRES[own.district];
    if (c && own.city.toLowerCase() === 'bangkok') {
      return { ok: true, place: { name: own.label, lat: c.lat, lng: c.lng, kind: 'saved_address', area: `${own.district}, ${own.city}` } };
    }
    return { ok: false, code: 'PLACE_NOT_FOUND', message: `Saved address "${own.label}" is outside the demo area (Bangkok)`, suggestions: [] };
  }

  let best: { l: Landmark; len: number } | null = null;
  for (const l of LANDMARKS) {
    for (const a of l.aliases) {
      if (hits(q, a)) {
        if (!best || a.length > best.len) best = { l, len: a.length };
      }
    }
  }
  if (best) {
    const l = best.l;
    return { ok: true, place: { name: l.name, lat: l.lat, lng: l.lng, kind: 'landmark', area: 'Bangkok', is_airport: l.airport } };
  }
  if (AIRPORT_WORDS.some((w) => q.includes(w))) {
    return { ok: false, code: 'PLACE_AMBIGUOUS', message: 'Bangkok has two airports. Ask the user which one.', suggestions: LANDMARKS.filter((l) => l.airport).map((l) => l.name) };
  }
  for (const [district, c] of Object.entries(DISTRICT_CENTRES)) {
    if ([district.toLowerCase(), ...c.aliases].some((a) => hits(q, a))) {
      return { ok: true, place: { name: `${district} (district centre)`, lat: c.lat, lng: c.lng, kind: 'district', area: `${district}, Bangkok` } };
    }
  }
  return {
    ok: false, code: 'PLACE_NOT_FOUND',
    message: `"${raw.slice(0, 80)}" is not in the demo map. The demo knows Bangkok landmarks, districts and your saved addresses.`,
    suggestions: LANDMARKS.map((l) => l.name).slice(0, 8),
  };
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const ROAD_FACTOR = 1.35;
export const AVG_SPEED_KMH = 22;

export function tripFingerprint(t: Omit<Trip, 'fingerprint'>) {
  return sha256(stableJson({ p: t.pickup, d: t.dropoff, parcel: t.parcel ?? null }));
}

/** Build a trip. With coordinates on both ends, adds a road distance and drive time estimate. */
export function buildTrip(pickup: Place, dropoff: Place, parcel?: { weight_kg: number; description?: string }): Trip {
  const base: Omit<Trip, 'fingerprint'> = { pickup, dropoff, parcel };
  if (pickup.lat !== undefined && pickup.lng !== undefined && dropoff.lat !== undefined && dropoff.lng !== undefined) {
    const km = Math.max(1, haversineKm(pickup as any, dropoff as any) * ROAD_FACTOR);
    base.distance_km = Math.round(km * 10) / 10;
    base.duration_min = Math.max(5, Math.round((km / AVG_SPEED_KMH) * 60));
  }
  return { ...base, fingerprint: tripFingerprint(base) };
}
