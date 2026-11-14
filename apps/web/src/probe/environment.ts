import type { ProbeEnvironment } from './probe.ts';

/** Collects what the report needs to know about this browser. */
export async function collectEnvironment(): Promise<ProbeEnvironment> {
  let localNetworkAccess = 'не поддерживается';
  try {
    // Chrome 142+: permission for requests to private and local addresses.
    const status = await navigator.permissions.query({ name: 'local-network-access' as PermissionName });
    localNetworkAccess = status.state;
  } catch {
    // unsupported name in this browser
  }
  return {
    pageOrigin: location.origin,
    userAgent: navigator.userAgent,
    isSecureContext: window.isSecureContext,
    localNetworkAccess,
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

/** Reads `#url=...&user=...` so that a link can prefill the form (never the password). */
export function prefillFromHash(hash: string): { url: string; user: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return { url: params.get('url') ?? '', user: params.get('user') ?? '' };
}
