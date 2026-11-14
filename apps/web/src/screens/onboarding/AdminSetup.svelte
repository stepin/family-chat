<script lang="ts">
  import type { AccountView } from '@family-chat/core';
  import Page from '../../components/Page.svelte';
  import RecoveryPhrase from '../../components/RecoveryPhrase.svelte';
  import InviteFamily from '../../components/InviteFamily.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { errorText, joinProblem } from '../../lib/errors.ts';
  import { pageServerUrl } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { t } from '../../lib/strings.ts';

  // Administrator route (docs/PLAN.md 8.1 with docs/PLAN-v2.md 8): server
  // address and admin code → name → recovery phrase → invite the family.
  let step = $state<'server' | 'profile' | 'phrase' | 'invite'>('server');
  let serverUrl = $state(pageServerUrl(location));
  let code = $state('');
  let name = $state('');
  let family = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let account = $state<AccountView | null>(null);

  async function checkServer(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const hello = await app.core.serverInfo(serverUrl);
      if (!hello.adminCodeActive) {
        error = t.admin.adminTaken;
        return;
      }
      family = hello.familyName;
      step = 'profile';
    } catch (err) {
      error = errorText(err);
      app.log('warn', 'setup', 'server check failed', err);
    } finally {
      busy = false;
    }
  }

  async function create(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      account = await app.core.join({ serverUrl, code: { adminCode: code.trim() }, name: name.trim() });
      code = '';
      void navigator.storage?.persist?.().catch(() => false);
      step = 'phrase';
    } catch (err) {
      error = errorText(err);
      if (joinProblem(err) === 'code') step = 'server';
      app.log('warn', 'setup', 'joining with the admin code failed', err);
    } finally {
      busy = false;
    }
  }

  function finish(): void {
    nav.reset({ name: 'list' });
  }

  const title = $derived(
    step === 'server'
      ? t.admin.serverStep
      : step === 'profile'
        ? t.admin.profileStep
        : step === 'phrase'
          ? t.phrase.title
          : t.admin.inviteStep,
  );
  const back = $derived(
    step === 'server' ? () => nav.back() : step === 'profile' ? () => (step = 'server') : undefined,
  );
</script>

<Page {title} onback={back} narrow>
  {#if step === 'server'}
    <form class="stack" onsubmit={checkServer} novalidate>
      <p>{t.admin.serverLead}</p>
      <div class="field">
        <label for="admin-server">{t.admin.serverLabel}</label>
        <input
          id="admin-server"
          class="input"
          type="url"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          bind:value={serverUrl}
        />
      </div>
      <div class="field">
        <label for="admin-code">{t.admin.codeLabel}</label>
        <input
          id="admin-code"
          class="input mono"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          aria-describedby="admin-code-hint"
          bind:value={code}
        />
        <span id="admin-code-hint" class="hint">{t.admin.codeHint}</span>
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || serverUrl.trim() === '' || code.trim() === ''}>
        {busy ? t.admin.checking : t.common.next}
      </button>
    </form>
  {:else if step === 'profile'}
    <form class="stack" onsubmit={create} novalidate>
      <p class="notice" role="status">{t.admin.serverOk(family)}</p>
      <p>{t.admin.profileLead}</p>
      <div class="field">
        <label for="admin-name">{t.join.nameLabel}</label>
        <input id="admin-name" class="input" type="text" maxlength="64" autocomplete="given-name" bind:value={name} />
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || name.trim() === ''}>
        {busy ? t.admin.creating : t.admin.create}
      </button>
    </form>
  {:else if step === 'phrase' && account}
    <RecoveryPhrase userId={account.userId} ondone={() => (step = 'invite')} onskip={() => (step = 'invite')} />
  {:else if step === 'invite' && account}
    <div class="stack">
      <p>{t.admin.inviteLead}</p>
      <InviteFamily accountId={account.id} showList={false} />
      <button class="btn secondary block" type="button" onclick={finish}>{t.admin.finish}</button>
    </div>
  {/if}
</Page>
