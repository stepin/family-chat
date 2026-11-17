<script lang="ts">
  import type { AccountView } from '@family-chat/core';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { familyAddressLabel, pageServerUrl } from '../lib/invite.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { pushAccountOf } from '../lib/push.ts';
  import { t } from '../lib/strings.ts';

  // Families on this device: which server each one is
  // on, whether it shares the identity with another family, which family
  // sends the notifications, adding one, and removing one from this device
  // (with its local history) after a plain warning.
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;
  let target = $state.raw<AccountView | null>(null);
  let understood = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const unread = $derived(app.unreadByAccount);
  const pushAccount = $derived(pushAccountOf(app.accounts, pageServerUrl(location)));
  const lastOfIdentity = $derived(!!target && app.accounts.filter((a) => a.userId === target!.userId).length === 1);

  function shared(a: AccountView): boolean {
    return app.accounts.some((b) => b.id !== a.id && b.userId === a.userId);
  }


  function ask(e: MouseEvent, a: AccountView): void {
    opener = e.currentTarget as HTMLElement;
    target = a;
    understood = false;
    error = null;
    dialog?.showModal();
  }

  async function remove(): Promise<void> {
    const a = target;
    if (!a || !understood || busy) return;
    busy = true;
    error = null;
    try {
      await app.removeAccount(a.id);
      dialog?.close();
      app.notify(t.families.removed(a.familyName));
      if (app.accounts.length === 0) nav.reset({ name: 'welcome' });
    } catch (e) {
      error = t.families.removeFailed;
      app.log('warn', 'accounts', 'removing an account failed', e);
    } finally {
      busy = false;
    }
  }
</script>

<Page title={t.families.title} onback={() => nav.back()}>
  <section class="section">
    <p class="muted">{t.families.lead}</p>
    <ul class="families">
      {#each app.accounts as a (a.id)}
        {@const n = unread[a.id] ?? 0}
        <li class="family" data-testid="family-row">
          <div class="lines">
            <span class="fname">{a.familyName}{#if a.id === app.account?.id}<span class="muted small"> · {t.families.current}</span>{/if}</span>
            <span class="sub">{t.families.server(familyAddressLabel(a.serverUrl))}</span>
            <span class="sub">{shared(a) ? t.families.sameIdentity : t.families.otherIdentity}{#if n > 0} · {t.families.unread(n)}{/if}</span>
            <span class="sub">{a.pushRegistered || pushAccount?.id === a.id ? t.families.pushHere : t.families.pushElsewhere}</span>
          </div>
          <div class="row">
            {#if a.id !== app.account?.id}
              <button class="btn secondary small" type="button" onclick={() => app.switchAccount(a.id).then(() => nav.reset({ name: 'list' }))}>{t.families.open}</button>
            {/if}
            <button class="btn danger small" type="button" onclick={(e) => ask(e, a)} data-testid="family-remove">{t.families.remove}</button>
          </div>
        </li>
      {/each}
    </ul>
    <button class="btn" type="button" onclick={() => nav.push({ name: 'add-family' })}>{t.families.add}</button>
  </section>
</Page>

<dialog bind:this={dialog} aria-labelledby="family-remove-title" onclose={() => opener?.focus()}>
  <div class="stack">
    <h2 id="family-remove-title">{t.families.removeTitle(target?.familyName ?? '')}</h2>
    <ul class="points">
      {#each t.families.removePoints as p, i (i)}<li>{p}</li>{/each}
    </ul>
    {#if lastOfIdentity}<p class="notice warn">{t.families.removeLastIdentity}</p>{/if}
    <label class="check">
      <input type="checkbox" bind:checked={understood} />
      <span>{t.families.removeCheck}</span>
    </label>
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={() => dialog?.close()}>{t.common.cancel}</button>
      <button class="btn danger" type="button" disabled={!understood || busy} onclick={remove} data-testid="family-remove-confirm">
        {busy ? t.families.removing : t.families.removeButton}
      </button>
    </div>
  </div>
</dialog>

<style>
  .families {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .family {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding-bottom: var(--sp-3);
    border-bottom: 1px solid var(--line);
  }

  .lines {
    display: flex;
    flex-direction: column;
  }

  .fname {
    font-weight: 600;
  }

  .sub {
    font-size: var(--text-s);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .section > .btn {
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
