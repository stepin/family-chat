import { describe, expect, it } from 'vitest';
import { formatAccuracy, formatCoords, geoProblem, isLowAccuracy, LOW_ACCURACY_M, mapsLink, placeFromCoords, zoomFor } from './location.ts';

const place = { lat: 55.7558, lon: 37.6173, accuracy: 25 };

describe('location', () => {
  it('formats coordinates with five decimals and a dot', () => {
    expect(formatCoords(place)).toBe('55.75580, 37.61730');
    expect(formatCoords({ lat: -33.8688, lon: -151.2093 })).toBe('-33.86880, -151.20930');
  });

  it('formats accuracy in metres and kilometres', () => {
    expect(formatAccuracy(3)).toBe('около 5 м');
    expect(formatAccuracy(23)).toBe('около 25 м');
    expect(formatAccuracy(140)).toBe('около 140 м');
    expect(formatAccuracy(999)).toBe('около 1000 м');
    expect(formatAccuracy(1234)).toBe('около 1,2 км');
    expect(formatAccuracy(25_000)).toBe('около 25 км');
    expect(formatAccuracy(Number.NaN)).toBe('неизвестна');
  });

  it('warns when the accuracy is worse than 500 m', () => {
    expect(LOW_ACCURACY_M).toBe(500);
    expect(isLowAccuracy(500)).toBe(false);
    expect(isLowAccuracy(501)).toBe(true);
    expect(isLowAccuracy(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('opens the platform maps: geo: on Android, Apple Maps on iOS, OpenStreetMap elsewhere', () => {
    expect(mapsLink(place, 'android')).toEqual({ href: 'geo:55.7558,37.6173?q=55.7558,37.6173', newTab: false });
    expect(mapsLink(place, 'ios')).toEqual({ href: 'https://maps.apple.com/?ll=55.7558,37.6173&q=55.7558,37.6173', newTab: true });
    expect(mapsLink(place, 'other')).toEqual({
      href: 'https://www.openstreetmap.org/?mlat=55.7558&mlon=37.6173#map=17/55.7558/37.6173',
      newTab: true,
    });
    expect(mapsLink({ ...place, accuracy: 3000 }, 'other').href).toContain('#map=13/');
    expect([zoomFor(10), zoomFor(150), zoomFor(800), zoomFor(4000), zoomFor(1e6)]).toEqual([17, 16, 15, 13, 11]);
  });

  it('takes a position as the message carries it', () => {
    expect(placeFromCoords({ latitude: 55.75580123, longitude: 37.61730987, accuracy: 24.6 })).toEqual({
      lat: 55.755801,
      lon: 37.61731,
      accuracy: 25,
    });
    expect(placeFromCoords({ latitude: 91, longitude: -181, accuracy: Number.NaN })).toEqual({ lat: 90, lon: -180, accuracy: 1e7 });
  });

  it('maps Geolocation errors', () => {
    expect(geoProblem(1)).toBe('denied');
    expect(geoProblem(2)).toBe('unavailable');
    expect(geoProblem(3)).toBe('timeout');
  });
});
