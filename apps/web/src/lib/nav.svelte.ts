// Screen stack without a router library. Each push adds a browser history
// entry (with the same address), so the Android and browser "Back" closes the
// top screen first; the address bar never carries state or secrets.

export type Route =
  | { readonly name: 'welcome' }
  | { readonly name: 'paste-invite' }
  | { readonly name: 'gateway' }
  | { readonly name: 'join' }
  | { readonly name: 'admin' }
  | { readonly name: 'restore' }
  | { readonly name: 'revoke-phrase' }
  | { readonly name: 'list' }
  | {
      readonly name: 'chat';
      readonly accountId: string;
      readonly chatId: string;
      readonly focus?: boolean;
      /** Open at this message and mark it briefly (a search result). */
      readonly jump?: { readonly senderId: string; readonly msgId: string; readonly gseq: number };
    }
  | { readonly name: 'search' }
  | { readonly name: 'new-chat' }
  | { readonly name: 'new-group'; readonly members?: readonly string[]; readonly title?: string }
  | { readonly name: 'chat-info'; readonly accountId: string; readonly chatId: string }
  | { readonly name: 'contact'; readonly accountId: string; readonly userId: string }
  | { readonly name: 'profile' }
  | { readonly name: 'storage' }
  | { readonly name: 'security' }
  | { readonly name: 'settings' }
  | { readonly name: 'phrase' }
  | { readonly name: 'server' }
  | { readonly name: 'invites' }
  | { readonly name: 'diagnostics' }
  | { readonly name: 'families' }
  | { readonly name: 'add-family' }
  | { readonly name: 'sticker-packs' }
  | { readonly name: 'appearance' };

export type RouteName = Route['name'];

interface HistoryState {
  readonly fcDepth: number;
}

class Nav {
  stack: Route[] = $state([{ name: 'welcome' }]);
  #listening = false;

  get top(): Route {
    return this.stack[this.stack.length - 1] ?? { name: 'welcome' };
  }

  get root(): Route {
    return this.stack[0] ?? { name: 'welcome' };
  }

  /** Starts over with one screen (after joining, or when the account disappears). */
  reset(route: Route): void {
    this.#listen();
    this.stack = [route];
    history.replaceState({ fcDepth: 0 } satisfies HistoryState, '');
  }

  push(route: Route): void {
    this.#listen();
    this.stack = [...this.stack, route];
    history.pushState({ fcDepth: this.stack.length - 1 } satisfies HistoryState, '');
  }

  /** Replaces the top screen (switching chats in the two-column layout). */
  replace(route: Route): void {
    this.stack = [...this.stack.slice(0, -1), route];
  }

  /** Opens a chat: replaces an open chat instead of stacking chats. */
  openChat(accountId: string, chatId: string, focus = false, jump?: { senderId: string; msgId: string; gseq: number }): void {
    const route: Route = { name: 'chat', accountId, chatId, focus, ...(jump ? { jump } : {}) };
    const top = this.top;
    if (top.name === 'chat' || top.name === 'new-chat' || top.name === 'new-group') this.replace(route);
    else if (this.stack.length > 1) {
      // From settings and similar screens: back to the list, then the chat.
      this.stack = [this.root, route];
      history.replaceState({ fcDepth: 1 } satisfies HistoryState, '');
    } else this.push(route);
  }

  back(): void {
    if (this.stack.length <= 1) return;
    history.back();
  }

  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    window.addEventListener('popstate', (e) => {
      const depth = (e.state as HistoryState | null)?.fcDepth ?? 0;
      if (depth < this.stack.length - 1) this.stack = this.stack.slice(0, Math.max(1, depth + 1));
    });
  }
}

export const nav = new Nav();
