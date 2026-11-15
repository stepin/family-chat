<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Security (docs/PLAN.md screen 20): the recovery phrase and revoking my
  // identity, with a confirmation that says plainly what it means.
  const account = $derived(app.account!);
  const removed = $derived(account.status === 'removed');
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;
  let understood = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  // M5: the same identity in several families (the same phrase gives the same keys and userId).
  const sameIdentity = $derived(app.accounts.filter((a) => a.userId === account.userId));
  const otherIdentities = $derived(new Set(app.accounts.filter((a) => a.userId !== account.userId).map((a) => a.userId)).size);

  function ask(e: MouseEvent): void {
    opener = e.currentTarget as HTMLElement;
    understood = false;
    error = null;
    dialog?.showModal();
  }

  async function revoke(): Promise<void> {
    if (!understood || busy) return;
    busy = true;
    error = null;
    try {
      await app.core.revokeIdentity(account.id);
      dialog?.close();
      app.notify(t.security.revoked);
      nav.reset({ name: 'list' });
    } catch (e) {
      error = errorText(e) === t.errors.generic ? t.security.failed : errorText(e);
      app.log('warn', 'security', 'revoking the identity failed', e);
    } finally {
      busy = false;
    }
  }
</script>

<Page title={t.security.title} onback={() => nav.back()}>
  <section class="section" aria-labelledby="sec-identity">
    <h2 id="sec-identity">{t.security.identityTitle}</h2>
    <p data-testid="identity-families">
      {sameIdentity.length > 1 ? t.security.identityShared(sameIdentity.map((a) => `«${a.familyName}»`).sort((x, y) => x.localeCompare(y, "ru")).join(', ')) : t.security.identityOwn}
    </p>
    {#if otherIdentities > 0}<p class="muted small">{t.security.identityOthers(otherIdentities)}</p>{/if}
  </section>

  <section class="section links" aria-label={t.settings.phrase}>
    <button class="item" type="button" onclick={() => nav.push({ name: 'phrase' })}>
      <span class="label">{t.settings.phrase}<span class="sub">{t.phrase.status(app.flags.phraseConfirmed)}</span></span>
      <Icon name="chevron" size={20} />
    </button>
  </section>

  <section class="section" aria-labelledby="sec-revoke">
    <h2 id="sec-revoke">{t.security.revokeTitle}</h2>
    {#if account.revoked}
      <p>{t.status.revoked(app.familyLabel(account.familyName))}</p>
    {:else}
      <p>{t.security.revokeLead}</p>
      <button class="btn danger" type="button" disabled={removed} onclick={ask}>{t.security.revokeButton}</button>
    {/if}
  </section>
</Page>

<dialog bind:this={dialog} aria-labelledby="revoke-title" onclose={() => opener?.focus()}>
  <div class="stack">
    <h2 id="revoke-title">{t.security.confirmTitle}</h2>
    <ul class="points">
      {#each t.security.confirmPoints as p, i (i)}<li>{p}</li>{/each}
    </ul>
    <label class="check">
      <input type="checkbox" bind:checked={understood} />
      <span>{t.security.confirmCheck}</span>
    </label>
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={() => dialog?.close()}>{t.common.cancel}</button>
      <button class="btn danger" type="button" disabled={!understood || busy} onclick={revoke}>
        {busy ? t.security.revoking : t.security.confirmButton}
      </button>
    </div>
  </div>
</dialog>

<style>
  .links {
    gap: 0;
    padding: 0;
    overflow: hidden;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 56px;
    padding: var(--sp-2) var(--sp-4);
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: var(--surface-2);
  }

  .label {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    font-weight: 600;
  }

  .sub {
    font-weight: 400;
    font-size: var(--text-s);
    color: var(--muted);
  }

  .section .btn {
    align-self: flex-start;
  }

  .points {
    margin: 0;
    padding-left: var(--sp-5);
  }

  .points li + li {
    margin-top: var(--sp-1);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--touch);
    font-weight: 600;
    cursor: pointer;
  }

  .check input {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }

  .end {
    justify-content: flex-end;
  }
</style>
