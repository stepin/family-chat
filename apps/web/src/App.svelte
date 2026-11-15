<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './lib/app.svelte.ts';
  import { nav } from './lib/nav.svelte.ts';
  import { sameServer, takeInviteFromLocation } from './lib/invite.ts';
  import { refreshSubscription } from './lib/push.ts';
  import { t } from './lib/strings.ts';
  import { lazy } from './lib/lazy.ts';
  import Main from './screens/Main.svelte';

  // Onboarding is seen once per device: it loads only when needed.
  const Onboarding = lazy(() => import('./screens/onboarding/Onboarding.svelte'));

  const ID = /^[a-z2-7]{16,26}$/;

  /**
   * Opens the chat a notification pointed to. Chat ids are unique across
   * servers (the server id is part of a direct chat id; group ids are
   * random), and the service worker also names the account: the app switches
   * to that family first.
   */
  async function openChatById(chatId: string | null, accountId: string | null = null): Promise<void> {
    const account = app.account;
    if (!chatId || !account || nav.root.name !== 'list') return;
    const item = app.chatList.find((c) => c.chatId === chatId && (!accountId || c.accountId === accountId));
    const target = item?.accountId ?? (accountId && app.accounts.some((a) => a.id === accountId) ? accountId : account.id);
    if (target !== app.account?.id) await app.switchAccount(target);
    nav.openChat(target, chatId);
  }

  /** Content shared into the app (Web Share Target): the chooser of the family and chat opens. */
  async function takeShare(param: string | null): Promise<void> {
    if (param === 'unavailable') {
      app.notify(t.share.unavailable);
      return;
    }
    const shared = await app.core.takeShared().catch(() => null);
    if (!shared) {
      if (param !== null) app.notify(t.share.lost);
      return;
    }
    if (shared.problem) {
      app.notify(t.share.problem(shared.problem));
      return;
    }
    if (!shared.text && shared.files.length === 0) {
      app.notify(t.share.empty);
      return;
    }
    app.choosingShare = shared;
  }

  onMount(() => {
    // Secrets never stay in the address bar: the fragment goes at once.
    const invite = takeInviteFromLocation(location, history);
    const params = new URLSearchParams(location.search);
    const chatParam = params.get('chat');
    const accountParam = params.get('account');
    const shareParam = params.get('share');
    if (chatParam !== null || shareParam !== null) history.replaceState(history.state, '', location.pathname);

    const wideQuery = matchMedia('(min-width: 900px)');
    app.wide = wideQuery.matches;
    wideQuery.addEventListener('change', (e) => (app.wide = e.matches));

    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string; chatId?: unknown; accountId?: unknown } | null;
      if (data?.type === 'fc-open-chat') {
        void openChatById(typeof data.chatId === 'string' ? data.chatId : null, typeof data.accountId === 'string' ? data.accountId : null);
      }
    });

    void (async () => {
      await app.boot();
      if (app.phase !== 'ready') return;
      const account = app.account;
      if (account) {
        nav.reset({ name: 'list' });
        if (invite) {
          // An invitation into another family: "add a family?" (docs/PLAN.md 6.10).
          if (app.accounts.some((a) => sameServer(a.serverUrl, invite.serverUrl))) app.notify(t.join.already);
          else {
            app.invite = invite;
            nav.push({ name: 'add-family' });
          }
        }
        if (chatParam && /^[a-z2-7]{26}$/.test(chatParam)) {
          await openChatById(chatParam, accountParam && ID.test(accountParam) ? accountParam : null);
        }
        void takeShare(shareParam);
        void refreshSubscription(app.core, app.accounts).catch((e: unknown) =>
          app.log('warn', 'push', 'push subscription refresh failed', e),
        );
      } else if (invite) {
        app.invite = invite;
        nav.reset({ name: 'gateway' });
      } else {
        nav.reset({ name: 'welcome' });
      }
    })();
  });
</script>

<!-- M7: a new interface language renders every screen again (the state lives in app and nav). -->
{#key app.lang}
{#if app.phase === 'loading'}
  <div class="splash" role="status">{t.boot.loading}</div>
{:else if app.phase === 'db-newer'}
  <main class="fatal">
    <h1>{t.boot.dbNewerTitle}</h1>
    <p>{t.boot.dbNewerText}</p>
    <button class="btn" type="button" onclick={() => location.reload()}>{t.boot.reload}</button>
  </main>
{:else if app.phase === 'old-browser'}
  <main class="fatal">
    <h1>{t.boot.oldBrowserTitle}</h1>
    <p>{t.boot.oldBrowserText}</p>
  </main>
{:else if app.phase === 'failed'}
  <main class="fatal">
    <h1>{t.boot.startFailedTitle}</h1>
    <p>{t.boot.startFailedText}</p>
    <button class="btn" type="button" onclick={() => location.reload()}>{t.boot.reload}</button>
  </main>
{:else if nav.root.name === 'list' && app.account}
  <Main />
{:else}
  {#await Onboarding()}
    <div class="splash" role="status">{t.boot.loading}</div>
  {:then { default: OnboardingScreen }}
    <OnboardingScreen />
  {:catch}
    <main class="fatal">
      <h1>{t.boot.startFailedTitle}</h1>
      <p>{t.boot.startFailedText}</p>
      <button class="btn" type="button" onclick={() => location.reload()}>{t.boot.reload}</button>
    </main>
  {/await}
{/if}

{/key}

{#if app.toast}
  <div class="toast" role="status">{app.toast}</div>
{/if}

<style>
  .splash {
    margin: auto;
    color: var(--muted);
  }

  .fatal {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    max-width: 32rem;
    margin: auto;
    padding: var(--sp-6);
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: max(var(--sp-6), env(safe-area-inset-bottom));
    transform: translateX(-50%);
    max-width: min(30rem, calc(100vw - 2rem));
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--text);
    color: var(--bg);
    z-index: 10;
  }
</style>
