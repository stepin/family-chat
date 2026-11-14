<script lang="ts">
  import { onMount } from 'svelte';
  import Page from '../../components/Page.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { copyText } from '../../lib/clipboard.ts';
  import { inviteLinkFor, pageServerUrl } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { gatewayBranch } from '../../lib/platform.ts';
  import { t } from '../../lib/strings.ts';

  // The gateway (docs/PLAN.md 8.1): what to do on this platform before the
  // invitation can be used. Without an invitation (setup or restore started
  // on iOS Safari) it only leads to the installation.
  const invite = app.invite;
  const branch = gatewayBranch(app.platform);
  let family = $state<string | null>(null);
  let copied = $state<string | null>(null);

  /** What to copy: the invitation link, or the page address when there is none. */
  const link = invite ? inviteLinkFor(invite) : `${pageServerUrl(location)}/`;

  onMount(() => {
    if (branch === 'continue') {
      if (invite) nav.replace({ name: 'join' });
      return;
    }
    if (invite) {
      app.core
        .serverInfo(invite.serverUrl)
        .then((h) => (family = h.familyName))
        .catch(() => undefined);
    }
  });

  async function copy(message: string): Promise<void> {
    copied = (await copyText(link)) ? message : t.common.copyFailed;
  }

  async function install(): Promise<void> {
    const p = app.installPrompt;
    if (!p) return;
    await p.prompt();
    const choice = await p.userChoice.catch(() => null);
    app.installPrompt = null;
    // Chrome on Android shares storage with the installed app: joining
    // here is kept there as well.
    if (choice?.outcome === 'accepted' && invite) nav.push({ name: 'join' });
  }

  const back = nav.stack.length > 1 ? () => nav.back() : undefined;
</script>

{#if branch === 'in-app'}
  <Page title={t.gateway.inAppTitle} onback={back} narrow>
    <div class="stack">
      {#if invite}<p class="lead">{t.gateway.title(family)}</p>{/if}
      <p>{t.gateway.inAppText}</p>
      <button class="btn block" type="button" onclick={() => copy(t.gateway.linkCopied)}>{t.gateway.copyLink}</button>
      {#if copied}<p role="status">{copied}</p>{/if}
    </div>
  </Page>
{:else if branch === 'ios-open-safari'}
  <Page title={t.gateway.iosOtherTitle} onback={back} narrow>
    <div class="stack">
      {#if invite}<p class="lead">{t.gateway.title(family)}</p>{/if}
      <p>{t.gateway.iosOtherText}</p>
      <button class="btn block" type="button" onclick={() => copy(t.gateway.linkCopied)}>{t.gateway.copyLink}</button>
      {#if copied}<p role="status">{copied}</p>{/if}
    </div>
  </Page>
{:else if branch === 'ios-install'}
  <Page title={invite ? t.gateway.title(family) : t.gateway.iosInstallTitle} onback={back} narrow>
    <div class="stack">
      <p>{t.gateway.iosInstallText}</p>
      <ol class="steps">
        {#if invite}
          <li>
            <h2>{t.gateway.iosStep1Title}</h2>
            <button class="btn block" type="button" onclick={() => copy(t.gateway.inviteCopied)}>{t.gateway.copyInvite}</button>
            {#if copied}<p role="status">{copied}</p>{/if}
          </li>
        {/if}
        <li>
          <h2>{t.gateway.iosStep2Title}</h2>
          <p class="muted">{t.gateway.iosStep2Text}</p>
          <svg class="pict" viewBox="0 0 48 48" aria-hidden="true">
            <rect x="12" y="18" width="24" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="2.5" />
            <path d="M24 6v22M17 13l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </li>
        <li>
          <h2>{t.gateway.iosStep3Title}</h2>
          <p class="muted">{t.gateway.iosStep3Text}</p>
          <svg class="pict" viewBox="0 0 48 48" aria-hidden="true">
            <rect x="8" y="8" width="32" height="32" rx="7" fill="none" stroke="currentColor" stroke-width="2.5" />
            <path d="M24 16v16M16 24h16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          </svg>
        </li>
        <li>
          <h2>{t.gateway.iosStep4Title}</h2>
          {#if invite}<p class="muted">{t.gateway.iosStep4Text}</p>{/if}
        </li>
      </ol>
    </div>
  </Page>
{:else if branch === 'android'}
  <Page title={invite ? t.gateway.title(family) : t.gateway.androidTitle} onback={back} narrow>
    <div class="stack">
      <h2>{t.gateway.androidTitle}</h2>
      <p>{t.gateway.androidText}</p>
      {#if app.installPrompt}
        <button class="btn block" type="button" onclick={install}>{t.gateway.install}</button>
      {:else}
        <p class="muted small">{t.gateway.androidManual}</p>
      {/if}
      {#if invite}
        <button
          class="btn block"
          class:secondary={!!app.installPrompt}
          type="button"
          onclick={() => nav.push({ name: 'join' })}>{t.gateway.continueBrowser}</button
        >
      {/if}
    </div>
  </Page>
{/if}

<style>
  .lead {
    font-size: var(--text-l);
    font-weight: 600;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    margin: 0;
    padding-left: var(--sp-6);
  }

  .steps li {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .steps li::marker {
    font-weight: 700;
    color: var(--accent);
  }

  .steps h2 {
    font-size: var(--text-m);
  }

  .pict {
    width: 48px;
    height: 48px;
    color: var(--accent);
  }
</style>
