<script lang="ts">
  import { app } from '../../lib/app.svelte.ts';
  import { nav, type RouteName } from '../../lib/nav.svelte.ts';
  import { mustInstallFirst } from '../../lib/platform.ts';
  import { t } from '../../lib/strings.ts';
  import PasteInvite from './PasteInvite.svelte';

  // The installed app on iOS starts empty (Safari storage is separate): its
  // first screen is "paste the invitation".
  const installedIos = $derived(app.platform.os === 'ios' && app.platform.standalone);

  // "Set up for my family" is always offered (one server holds several
  // families; setting one up needs the server admin code); the invitation
  // stays the main way in.

  function go(name: RouteName & ('paste-invite' | 'admin' | 'restore')): void {
    // On iOS outside the installed app and in messenger browsers nothing may be created yet.
    if (mustInstallFirst(app.platform)) nav.push({ name: 'gateway' });
    else nav.push({ name });
  }
</script>

{#if installedIos}
  <PasteInvite installed />
{:else}
  <main class="welcome">
    <div class="hero">
      <img src="./icon.svg" alt="" width="72" height="72" />
      <h1>{t.welcome.title}</h1>
      <p class="muted">{t.welcome.lead}</p>
    </div>
    <div class="actions">
      <button class="btn block" type="button" onclick={() => go('paste-invite')}>{t.welcome.haveInvite}</button>
      <button class="btn secondary block" type="button" aria-describedby="welcome-setup-hint" onclick={() => go('admin')}>{t.welcome.setup}</button>
      <p class="muted small setup-hint" id="welcome-setup-hint">{t.welcome.setupHint}</p>
      <button class="link-btn" type="button" onclick={() => go('restore')}>{t.welcome.restore}</button>
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

  .setup-hint {
    margin: calc(-1 * var(--sp-2)) 0 0;
    text-align: center;
  }
</style>
