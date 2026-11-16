// Platform detection for the invitation gateway.
//
// iOS keeps the storage of Safari and of the installed app apart, so on iOS
// nothing (no identity) may be created before the app is installed. Messenger
// in-app browsers cannot install a web app at all.

export type Os = 'ios' | 'android' | 'other';

export interface PlatformInfo {
  readonly os: Os;
  /** Opened inside a messenger or social app (WebView), not a real browser. */
  readonly inApp: boolean;
  /** Running as an installed app (Home Screen / standalone window). */
  readonly standalone: boolean;
  /** Real Safari on iOS (only it can add to the Home Screen reliably). */
  readonly iosSafari: boolean;
}

export interface PlatformInput {
  readonly userAgent: string;
  /** `navigator.maxTouchPoints`: iPadOS presents itself as a Mac. */
  readonly maxTouchPoints?: number;
  /** `navigator.standalone` (iOS) or `display-mode: standalone`. */
  readonly standalone?: boolean;
}

// Messenger and social apps that open links in their own WebView.
const IN_APP =
  /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|WhatsApp|Telegram|Viber|VKClient|vkontakte|OKApp|Snapchat|Twitter|LinkedInApp|Pinterest|GSA\/|YaApp|YaBrowser\/.*Mobile.*SA\/|; wv\)/i;

export function detectPlatform(input: PlatformInput): PlatformInfo {
  const ua = input.userAgent;
  const touch = (input.maxTouchPoints ?? 0) > 1;
  const iosDevice = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch);
  const android = !iosDevice && /Android/i.test(ua);
  const os: Os = iosDevice ? 'ios' : android ? 'android' : 'other';
  const inApp = os !== 'other' && IN_APP.test(ua);
  // Chrome, Firefox, Edge, Opera, Yandex on iOS carry their own tokens.
  const otherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|Brave/i.test(ua);
  const iosSafari = os === 'ios' && !inApp && !otherIosBrowser && /Safari\//i.test(ua) && /Version\//i.test(ua);
  return { os, inApp, standalone: input.standalone === true, iosSafari };
}

/**
 * What the gateway shows before the invitation can be used:
 * - `continue`: go straight to joining (desktop, installed app);
 * - `in-app`: "open in Safari / Chrome" and copy the link;
 * - `ios-open-safari`: another browser on iOS: open the link in Safari;
 * - `ios-install`: Safari on iOS, not installed: add to the Home Screen first;
 * - `android`: offer installation when the browser allows it, then continue.
 */
export type GatewayBranch = 'continue' | 'in-app' | 'ios-open-safari' | 'ios-install' | 'android';

export function gatewayBranch(p: PlatformInfo): GatewayBranch {
  if (p.standalone) return 'continue';
  if (p.inApp) return 'in-app';
  if (p.os === 'ios') return p.iosSafari ? 'ios-install' : 'ios-open-safari';
  if (p.os === 'android') return 'android';
  return 'continue';
}

/** True when an identity must not be created here yet (iOS outside the installed app, in-app browsers). */
export function mustInstallFirst(p: PlatformInfo): boolean {
  const b = gatewayBranch(p);
  return b === 'in-app' || b === 'ios-install' || b === 'ios-open-safari';
}

/** Reads the current browser's platform. */
export function currentPlatform(): PlatformInfo {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone =
    nav.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  return detectPlatform({ userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints, standalone });
}
