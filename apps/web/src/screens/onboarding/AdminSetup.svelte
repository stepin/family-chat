<script lang="ts">
  import { onMount } from 'svelte';
  import { isApiError, isNetworkError, type AccountView } from '@family-chat/core';
  import GenderPicker from '../../components/GenderPicker.svelte';
  import Page from '../../components/Page.svelte';
  import RecoveryPhrase from '../../components/RecoveryPhrase.svelte';
  import InviteFamily from '../../components/InviteFamily.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { errorText, joinProblem } from '../../lib/errors.ts';
  import { pageServerUrl } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { pageHello, setupField, type HelloState, type SetupField } from '../../lib/page-hello.ts';
  import { t, type Gender } from '../../lib/strings.ts';

  // Administrator route (docs/PLAN.md 8.1 with docs/PLAN-v2.md 8): server
  // address and admin code → name → recovery phrase → invite the family.
  let step = $state<'server' | 'profile' | 'phrase' | 'invite'>('server');
  const pageUrl = pageServerUrl(location);
  // M8: the field is decided by the hello of the page's server, however the
  // person got here: its address; empty with a hint when this server is taken
  // and runs with `--offer-setup` (setup goes to another server); "an
  // administrator already exists" when it is taken without the flag. While
  // hello is pending (at most 5 s) the field is locked and empty.
  let helloState = $state<HelloState>('pending');
  let field = $state<SetupField>({ kind: 'page' });
  let touched = false;
  let serverUrl = $state('');
  let code = $state('');
  let name = $state('');
  let gender = $state<Gender>('m');
  let family = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let account = $state<AccountView | null>(null);

  onMount(() => {
    void pageHello(app.core, pageUrl).then((h) => {
      helloState = h ? 'done' : 'failed';
      field = setupField(helloState, h);
      // What the person typed is never overwritten.
      if (!touched && field.kind !== 'other') serverUrl = pageUrl;
      if (field.kind === 'taken') error = t.admin.adminTaken;
    });
  });

  /** Errors about another server name the address that was typed. */
  function serverError(err: unknown): string {
    if (field.kind !== 'other') return errorText(err);
    const at = serverUrl.trim();
    if (isNetworkError(err) || (isApiError(err) && err.status >= 500)) return t.admin.noAnswerAt(at);
    if (isApiError(err, 'unexpected_response') || isApiError(err, 'not_found') || err instanceof TypeError) return t.admin.notServerAt(at);
    return errorText(err);
  }

  async function checkServer(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const hello = await app.core.serverInfo(serverUrl);
      if (!hello.adminCodeActive) {
        error = field.kind === 'other' ? t.admin.adminTakenAt(serverUrl.trim()) : t.admin.adminTaken;
        return;
      }
      family = hello.familyName;
      step = 'profile';
    } catch (err) {
      error = serverError(err);
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
      account = await app.core.join({ serverUrl, code: { adminCode: code.trim() }, name: name.trim(), gender });
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
    <form class="stack" onsubmit={checkServer} novalidate data-hello={helloState}>
      {#if field.kind === 'other'}
        <p class="notice" data-testid="setup-other-server">{t.admin.otherServerLead}</p>
      {:else}
        <p>{t.admin.serverLead}</p>
      {/if}
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
          disabled={helloState === 'pending'}
          placeholder={helloState === 'pending' ? t.admin.checkingPage : field.kind === 'other' ? t.admin.otherServerHint : ''}
          aria-describedby={field.kind === 'other' ? 'admin-server-hint' : undefined}
          oninput={() => (touched = true)}
          bind:value={serverUrl}
        />
        {#if field.kind === 'other'}<span id="admin-server-hint" class="hint">{t.admin.otherServerHint}</span>{/if}
      </div>
      {#if field.kind !== 'taken'}
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
      {/if}
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      {#if field.kind !== 'taken'}
        <button class="btn block" type="submit" disabled={busy || helloState === 'pending' || serverUrl.trim() === '' || code.trim() === ''}>
          {busy ? t.admin.checking : t.common.next}
        </button>
      {/if}
    </form>
  {:else if step === 'profile'}
    <form class="stack" onsubmit={create} novalidate>
      <p class="notice" role="status">{t.admin.serverOk(family)}</p>
      <p>{t.admin.profileLead}</p>
      <div class="field">
        <label for="admin-name">{t.join.nameLabel}</label>
        <input id="admin-name" class="input" type="text" maxlength="64" autocomplete="given-name" bind:value={name} />
      </div>
      <GenderPicker id="admin" bind:value={gender} />
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
