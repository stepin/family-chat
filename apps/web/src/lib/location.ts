// Places (docs/PLAN.md 7.5, 8.6): the pure part. Coordinates and accuracy as
// text, the low-accuracy warning, and the "Открыть в картах" link for the
// platform. No map tiles are loaded: nothing about a place leaves the device
// except inside the encrypted message, and the link opens only when tapped.

import type { Os } from './platform.ts';

export interface Place {
  readonly lat: number;
  readonly lon: number;
  /** Radius of the accuracy circle, metres. */
  readonly accuracy: number;
}

/** Accuracy worse than this many metres is pointed out before sending. */
export const LOW_ACCURACY_M = 500;

export function isLowAccuracy(accuracy: number): boolean {
  return !Number.isFinite(accuracy) || accuracy > LOW_ACCURACY_M;
}

/** A position from the Geolocation API as the message carries it (6 decimals ≈ 10 cm, whole metres). */
export function placeFromCoords(c: { readonly latitude: number; readonly longitude: number; readonly accuracy: number }): Place {
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    lat: Math.max(-90, Math.min(90, round6(c.latitude))),
    lon: Math.max(-180, Math.min(180, round6(c.longitude))),
    accuracy: Math.max(0, Math.min(1e7, Math.round(Number.isFinite(c.accuracy) ? c.accuracy : 1e7))),
  };
}

/** "55.75580, 37.61730" (decimal degrees with a dot: what every map app accepts). */
export function formatCoords(p: Pick<Place, 'lat' | 'lon'>): string {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

/** "около 25 м", "около 1,2 км", "около 12 км". */
export function formatAccuracy(metres: number): string {
  if (!Number.isFinite(metres)) return 'неизвестна';
  if (metres < 1000) {
    const step = metres < 100 ? 5 : 10;
    return `около ${Math.max(step, Math.round(metres / step) * step)} м`;
  }
  const km = metres / 1000;
  return `около ${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} км`;
}

/** Map zoom that shows the accuracy circle. */
export function zoomFor(accuracy: number): number {
  if (accuracy <= 50) return 17;
  if (accuracy <= 200) return 16;
  if (accuracy <= 1000) return 15;
  if (accuracy <= 5000) return 13;
  return 11;
}

export interface MapsLink {
  readonly href: string;
  /** Opens in a new tab (web maps); `geo:` hands over to the map app instead. */
  readonly newTab: boolean;
}

/**
 * Android: a `geo:` link (the person's map app); iOS: Apple Maps; elsewhere
 * OpenStreetMap in the browser.
 */
export function mapsLink(p: Pick<Place, 'lat' | 'lon' | 'accuracy'>, os: Os): MapsLink {
  const lat = String(p.lat);
  const lon = String(p.lon);
  if (os === 'android') return { href: `geo:${lat},${lon}?q=${lat},${lon}`, newTab: false };
  if (os === 'ios') return { href: `https://maps.apple.com/?ll=${lat},${lon}&q=${lat},${lon}`, newTab: true };
  const z = zoomFor(p.accuracy);
  return { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${z}/${lat}/${lon}`, newTab: true };
}

export type GeoProblem = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure';

/** GeolocationPositionError codes: 1 denied, 2 unavailable, 3 timeout. */
export function geoProblem(code: number): GeoProblem {
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  return 'unavailable';
}
