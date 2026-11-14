import { describe, expect, it } from 'vitest';
import { detectPlatform, gatewayBranch, mustInstallFirst, type PlatformInput } from './platform.ts';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipadOs:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iphoneInstagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 385.0.0.21.86',
  iphoneFacebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0]',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0 Mobile Safari/537.36',
  androidWhatsApp:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36 WhatsApp/2.25.1',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};

const branch = (input: PlatformInput) => gatewayBranch(detectPlatform(input));

describe('platform detection for the gateway', () => {
  it('iPhone Safari, not installed: install first', () => {
    expect(detectPlatform({ userAgent: UA.iphoneSafari })).toEqual({ os: 'ios', inApp: false, standalone: false, iosSafari: true });
    expect(branch({ userAgent: UA.iphoneSafari })).toBe('ios-install');
    expect(mustInstallFirst(detectPlatform({ userAgent: UA.iphoneSafari }))).toBe(true);
  });

  it('the installed app goes straight on', () => {
    expect(branch({ userAgent: UA.iphoneSafari, standalone: true })).toBe('continue');
    expect(mustInstallFirst(detectPlatform({ userAgent: UA.iphoneSafari, standalone: true }))).toBe(false);
  });

  it('iPadOS presents itself as a Mac but has touch', () => {
    expect(branch({ userAgent: UA.ipadOs, maxTouchPoints: 5 })).toBe('ios-install');
    expect(branch({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toBe('continue');
  });

  it('another browser on iOS: open in Safari', () => {
    expect(branch({ userAgent: UA.iphoneChrome })).toBe('ios-open-safari');
  });

  it('messenger and social in-app browsers', () => {
    for (const ua of [UA.iphoneInstagram, UA.iphoneFacebook, UA.androidWebView, UA.androidWhatsApp]) {
      expect(branch({ userAgent: ua }), ua).toBe('in-app');
    }
  });

  it('Android Chrome and desktop', () => {
    expect(branch({ userAgent: UA.androidChrome })).toBe('android');
    expect(mustInstallFirst(detectPlatform({ userAgent: UA.androidChrome }))).toBe(false);
    expect(branch({ userAgent: UA.windowsChrome })).toBe('continue');
  });
});
