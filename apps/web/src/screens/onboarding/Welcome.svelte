<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { pageServerUrl } from '../../lib/invite.ts';
  import { offerSetup, pageHello, type HelloState } from '../../lib/page-hello.ts';
  import { nav, type RouteName } from '../../lib/nav.svelte.ts';
  import { mustInstallFirst } from '../../lib/platform.ts';
  import { t } from '../../lib/strings.ts';
  import PasteInvite from './PasteInvite.svelte';

  // The installed app on iOS starts empty (Safari storage is separate): its
  // first screen is "paste the invitation" (docs/PLAN.md 8.1).
  const installedIos = $derived(app.platform.os === 'ios' && app.platform.standalone);

  // M8: one family per server. "Set up for my family" only while the server
  // has no administrator, with `fcd --offer-setup`, or when hello failed.
  let helloState = $state<HelloState>('pending');
  let showSetup = $state<boolean | undefined>(undefined);

  onMount(() => {
    void pageHello(app.core, pageServerUrl(location)).then((h) => {
      helloState = h ? 'done' : 'failed';
      showSetup = offerSetup(helloState, h);
    });
  });

  function go(name: RouteName & ('paste-invite' | 'admin' | 'restore')): void {
    // On iOS outside the installed app and in messenger browsers nothing may be created yet.
    if (mustInstallFirst(app.platform)) nav.push({ name: 'gateway' });
    else nav.push({ name });
  }
</script>

{#if installedIos}
  <PasteInvite installed setup={showSetup !== false} />
{:else}
  <main class="welcome" data-hello={helloState}>
    <div class="hero">
      <img src="./icon.svg" alt="" width="72" height="72" />
      <h1>{t.welcome.title}</h1>
      <p class="muted">{t.welcome.lead}</p>
    </div>
    <div class="actions">
      <button class="btn block" type="button" onclick={() => go('paste-invite')}>{t.welcome.haveInvite}</button>
      {#if showSetup !== false}
        <!-- While hello is pending the slot is kept (no jump), the button hidden. -->
        <button
          class="btn secondary block"
          class:reserved={showSetup === undefined}
          type="button"
          aria-hidden={showSetup === undefined ? 'true' : undefined}
          tabindex={showSetup === undefined ? -1 : undefined}
          onclick={() => go('admin')}>{t.welcome.setup}</button
        >
      {/if}
      <button class="link-btn" type="button" onclick={() => go('restore')}>{t.welcome.restore}</button>
      {#if showSetup === false}
        <p class="muted small taken" data-testid="server-taken">{t.welcome.taken}</p>
      {/if}
    </div>
  </main>
{/if}

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--sp-8);
    height: 100%;
    max-width: 26rem;
    margin: 0 auto;
    padding: var(--sp-6);
    padding-top: max(var(--sp-6), env(safe-area-inset-top));
    padding-bottom: max(var(--sp-6), env(safe-area-inset-bottom));
    overflow-y: auto;
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    text-align: center;
  }

  .hero img {
    border-radius: var(--r-l);
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    align-items: stretch;
  }

  .actions .link-btn {
    align-self: center;
  }

  .reserved {
    visibility: hidden;
  }

  .taken {
    margin: 0;
    text-align: center;
  }
</style>
