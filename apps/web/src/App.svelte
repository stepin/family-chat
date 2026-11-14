<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './lib/app.svelte.ts';
  import { nav } from './lib/nav.svelte.ts';
  import { takeInviteFromLocation } from './lib/invite.ts';
  import { refreshSubscription } from './lib/push.ts';
  import { t } from './lib/strings.ts';
  import { lazy } from './lib/lazy.ts';
  import Main from './screens/Main.svelte';

  // Onboarding is seen once per device: it loads only when needed.
  const Onboarding = lazy(() => import('./screens/onboarding/Onboarding.svelte'));

  /** Opens the chat a notification pointed to (by chat id; one account in the interface). */
  function openChatById(chatId: string | null): void {
    const account = app.account;
    if (!chatId || !account || nav.root.name !== 'list') return;
    const item = app.chatList.find((c) => c.chatId === chatId);
    nav.openChat(item?.accountId ?? account.id, chatId);
  }

  onMount(() => {
    // Secrets never stay in the address bar: the fragment goes at once.
    const invite = takeInviteFromLocation(location, history);
    const params = new URLSearchParams(location.search);
    const chatParam = params.get('chat');
    if (chatParam !== null) history.replaceState(history.state, '', location.pathname);

    const wideQuery = matchMedia('(min-width: 900px)');
    app.wide = wideQuery.matches;
    wideQuery.addEventListener('change', (e) => (app.wide = e.matches));

    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string; chatId?: unknown } | null;
      if (data?.type === 'fc-open-chat') openChatById(typeof data.chatId === 'string' ? data.chatId : null);
    });

    void (async () => {
      await app.boot();
      if (app.phase !== 'ready') return;
      const account = app.account;
      if (account) {
        nav.reset({ name: 'list' });
        if (invite) app.notify(t.join.already);
        if (chatParam && /^[a-z2-7]{26}$/.test(chatParam)) nav.openChat(account.id, chatParam);
        void refreshSubscription(app.core, account).catch((e: unknown) =>
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
