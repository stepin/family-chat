// The app icon badge (Badging API) and the unread count in the page title
// (M5). The counting rule is in packages/core/src/badge.ts; the service
// worker (public/push-sw.js) counts pushes while the app is closed.

import { titleWithUnread } from '@family-chat/core';

export interface BadgeNavigator {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * The app icon badge (Badging API) and the page title (M5). Feature-detected:
 * browsers without the API do nothing, errors are ignored.
 */
export function showUnread(total: number, nav: BadgeNavigator = navigator as BadgeNavigator, doc: Pick<Document, 'title'> = document): void {
  doc.title = titleWithUnread('Family Chat', total);
  try {
    if (total > 0) void nav.setAppBadge?.(total)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch {
    // Not available in this context.
  }
}
