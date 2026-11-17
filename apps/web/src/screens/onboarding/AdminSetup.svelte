<script lang="ts">
  import { onMount } from 'svelte';
  import { isApiError, isCoreError, isNetworkError, isSecureServer, rootServerUrl, type AccountView } from '@family-chat/core';
  import GenderPicker from '../../components/GenderPicker.svelte';
  import Page from '../../components/Page.svelte';
  import RecoveryPhrase from '../../components/RecoveryPhrase.svelte';
  import InviteFamily from '../../components/InviteFamily.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { copyText } from '../../lib/clipboard.ts';
  import { errorText, joinProblem } from '../../lib/errors.ts';
  import { pageServerUrl } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { pageHello, type HelloState } from '../../lib/page-hello.ts';
  import { t, type Gender } from '../../lib/strings.ts';

  // Setting up a family with the server admin code: server address and code
  // → (on a server whose root family is set up) the new family's name, your
  // name → recovery phrase → the family's address and invitation. On a fresh
  // server this sets up its root family; otherwise a new family with its own
  // address `…/f/<id>` on the same server.
  let step = $state<'server' | 'profile' | 'phrase' | 'invite'>('server');
  const pageUrl = pageServerUrl(location);
  // The field gets the page's address once its hello answered (or failed);
  // what the person typed is never overwritten.
  let helloState = $state<HelloState>('pending');
  let touched = false;
  let serverUrl = $state('');
  let code = $state('');
  let name = $state('');
  let gender = $state<Gender>('m');
  /** The root family's name on a fresh server, or null when a new family is created. */
  let rootFamily = $state<string | null>(null);
  let familyName = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let codeError = $state(false);
  let account = $state<AccountView | null>(null);
  let familyUrl = $state('');
  let copied = $state(false);

  onMount(() => {
    void pageHello(app.core, pageUrl).then((h) => {
      helloState = h ? 'done' : 'failed';
      if (!touched) serverUrl = rootServerUrl(pageUrl);
    });
  });

  /** Errors about the address name the address that was typed. */
  function serverError(err: unknown): string {
    const at = serverUrl.trim();
    if (isNetworkError(err) || (isApiError(err) && err.status >= 500)) return t.admin.noAnswerAt(at);
    if (isApiError(err, 'unexpected_response') || isApiError(err, 'not_found') || err instanceof TypeError) return t.admin.notServerAt(at);
    return errorText(err);
  }

  async function checkServer(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    error = null;
    codeError = false;
    try {
      const root = rootServerUrl(serverUrl);
      // The code is never sent over plain HTTP to another computer.
      if (!isSecureServer(root)) {
        error = t.admin.insecure;
        return;
      }
      const hello = await app.core.serverInfo(root);
      // A 0.1.0 server has one family and a one-time code.
      if (hello.rootSetUp === undefined && !hello.adminCodeActive) {
        error = t.admin.codeWrong;
        codeError = true;
        return;
      }
      rootFamily = hello.rootSetUp === true ? null : hello.familyName;
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
      const r = await app.core.setUpFamily({
        serverUrl,
        serverCode: code.trim(),
        ...(rootFamily === null ? { familyName: familyName.trim() } : {}),
        name: name.trim(),
        gender,
      });
      account = r;
      familyUrl = r.familyUrl;
      void navigator.storage?.persist?.().catch(() => false);
      step = 'phrase';
    } catch (err) {
      error = errorText(err);
      if (joinProblem(err) === 'code' || isApiError(err, 'admin_code_not_set') || isCoreError(err, 'insecure-server')) {
        codeError = joinProblem(err) === 'code';
        step = 'server';
      }
      app.log('warn', 'setup', 'setting up a family failed', err);
    } finally {
      busy = false;
    }
  }

  async function copyAddress(): Promise<void> {
    copied = await copyText(familyUrl);
    if (copied) setTimeout(() => (copied = false), 3000);
  }

  function finish(): void {
    code = '';
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
          disabled={helloState === 'pending'}
          placeholder={helloState === 'pending' ? t.admin.checkingPage : ''}
          oninput={() => (touched = true)}
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
          aria-describedby={codeError && error ? 'admin-code-hint admin-error' : 'admin-code-hint'}
          aria-invalid={codeError ? 'true' : undefined}
          bind:value={code}
        />
        <span id="admin-code-hint" class="hint">{t.admin.codeHint}</span>
      </div>
      {#if error}<p class="error-text" id="admin-error" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || helloState === 'pending' || serverUrl.trim() === '' || code.trim() === ''}>
        {busy ? t.admin.checking : t.common.next}
      </button>
    </form>
  {:else if step === 'profile'}
    <form class="stack" onsubmit={create} novalidate>
      {#if rootFamily !== null}
        <p class="notice" role="status">{t.admin.serverOk(rootFamily)}</p>
      {:else}
        <p class="notice" role="status">{t.admin.newFamilyOk}</p>
        <div class="field">
          <label for="admin-family">{t.admin.familyNameLabel}</label>
          <input
            id="admin-family"
            class="input"
            type="text"
            maxlength="100"
            autocomplete="off"
            aria-describedby={error ? 'admin-family-hint admin-profile-error' : 'admin-family-hint'}
            bind:value={familyName}
          />
          <span id="admin-family-hint" class="hint">{t.admin.familyNameHint}</span>
        </div>
      {/if}
      <p>{t.admin.profileLead}</p>
      <div class="field">
        <label for="admin-name">{t.join.nameLabel}</label>
        <input id="admin-name" class="input" type="text" maxlength="64" autocomplete="given-name" bind:value={name} />
      </div>
      <GenderPicker id="admin" bind:value={gender} />
      {#if error}<p class="error-text" id="admin-profile-error" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || name.trim() === '' || (rootFamily === null && familyName.trim() === '')}>
        {busy ? t.admin.creating : t.admin.create}
      </button>
    </form>
  {:else if step === 'phrase' && account}
    <RecoveryPhrase userId={account.userId} ondone={() => (step = 'invite')} onskip={() => (step = 'invite')} />
  {:else if step === 'invite' && account}
    <div class="stack">
      <div class="field">
        <span class="label" id="family-address-label">{t.admin.familyAddress}</span>
        <div class="address-row">
          <code class="address" aria-labelledby="family-address-label" data-testid="family-address">{familyUrl}</code>
          <button class="btn secondary small" type="button" onclick={copyAddress}>{t.admin.copyAddress}</button>
        </div>
        <span class="visually-hidden" aria-live="polite">{copied ? t.admin.addressCopied : ''}</span>
      </div>
      <p>{t.admin.inviteLead}</p>
      <InviteFamily accountId={account.id} showList={false} />
      <p class="muted small">{t.admin.codeReusable}</p>
      <button class="btn secondary block" type="button" onclick={finish}>{t.admin.finish}</button>
    </div>
  {/if}
</Page>

<style>
  .address-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
  }

  .address {
    flex: 1 1 12rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .label {
    font-weight: 600;
  }
</style>
