<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { CreatedInvite, InviteInfo } from '@family-chat/core';
  import QrCode from './QrCode.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { copyText } from '../lib/clipboard.ts';
  import { errorText } from '../lib/errors.ts';
  import { t } from '../lib/strings.ts';

  // Create an invitation (QR and link), list issued ones, revoke
  //. The code is shown once and never logged.
  // The flow says plainly that an invitation lets in one person, that
  // the visible link is the newest one, and that the button makes another
  // one for the next relative ("Создать ещё одно приглашение"); the older
  // invitation keeps working.
  let { accountId, showList = true }: { accountId: string; showList?: boolean } = $props();

  let created = $state<CreatedInvite | null>(null);
  let invites = $state<InviteInfo[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let status = $state<string | null>(null);

  async function load(): Promise<void> {
    if (!showList) return;
    try {
      invites = [...(await app.core.admin.listInvites(accountId))].reverse();
    } catch (e) {
      error = errorText(e);
      app.log('warn', 'admin', 'listing invitations failed', e);
    }
  }

  onMount(() => {
    void load();
    return () => (created = null);
  });

  async function create(): Promise<void> {
    busy = true;
    error = null;
    status = null;
    try {
      created = await app.core.admin.createInvite(accountId);
      await load();
      status = null;
      // The new invitation replaces the one shown: the focus goes to it, so a screen reader hears it.
      await tick();
      document.getElementById('new-invite-title')?.focus();
    } catch (e) {
      error = errorText(e);
      app.log('warn', 'admin', 'creating an invitation failed', e);
    } finally {
      busy = false;
    }
  }

  async function copy(): Promise<void> {
    if (!created) return;
    status = (await copyText(created.link)) ? t.common.copied : t.common.copyFailed;
  }

  async function share(): Promise<void> {
    if (!created) return;
    try {
      await navigator.share({ title: t.invites.shareText(app.account?.familyName ?? ''), url: created.link });
    } catch {
      // cancelled
    }
  }

  async function revoke(id: string): Promise<void> {
    error = null;
    try {
      await app.core.admin.revokeInvite(accountId, id);
      if (created?.id === id) created = null;
      status = t.invites.revoked;
      await load();
    } catch (e) {
      error = t.invites.failed;
      app.log('warn', 'admin', 'revoking an invitation failed', e);
    }
  }

  function nameOf(userId: string | null): string | null {
    if (!userId) return null;
    return app.members.find((m) => m.userId === userId)?.name ?? null;
  }

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
</script>

<div class="stack">
  {#if created}
    <section class="created stack" aria-labelledby="new-invite-title">
      <h3 id="new-invite-title" tabindex="-1">{t.invites.newTitle}</h3>
      <p>{t.invites.newLead}</p>
      <div class="qr-wrap"><QrCode text={created.link} label={t.invites.qrLabel} /></div>
      <div class="field">
        <label for="invite-link">{t.invites.linkLabel}</label>
        <input id="invite-link" class="input mono" type="text" readonly value={created.link} data-testid="invite-link" />
      </div>
      <div class="row">
        <button class="btn" type="button" onclick={copy}>{t.invites.copyLink}</button>
        {#if canShare}
          <button class="btn secondary" type="button" onclick={share}>{t.invites.share}</button>
        {/if}
      </div>
      <p class="muted small">{t.invites.expires(created.expiresAt)}. {t.invites.secretNote}</p>
    </section>
  {/if}
  <div class="create stack">
    <button class="btn" class:secondary={!!created} type="button" disabled={busy} onclick={create} aria-describedby="invite-create-hint" data-testid="create-invite">
      {busy ? t.invites.creating : created ? t.invites.createAnother : t.invites.create}
    </button>
    <p id="invite-create-hint" class="muted small">{created ? t.invites.createAnotherHint : t.invites.oneEach}</p>
  </div>
  {#if status}<p role="status">{status}</p>{/if}
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}

  {#if showList}
    <h3>{t.invites.listTitle}</h3>
    {#if invites.length === 0}
      <p class="muted">{t.invites.none}</p>
    {:else}
      <ul class="list">
        {#each invites as inv (inv.id)}
          <li>
            <span class="small">
              {inv.usedAt ? t.invites.used(nameOf(inv.usedBy), inv.usedAt) : t.invites.active(inv.expiresAt)}
            </span>
            {#if !inv.usedAt}
              <button class="btn secondary small" type="button" onclick={() => revoke(inv.id)}>{t.invites.revoke}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .created {
    padding: var(--sp-4);
    border-radius: var(--r-m);
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .created .muted {
    color: var(--on-accent-soft-muted);
  }

  .create {
    gap: var(--sp-1);
  }

  .create .btn {
    align-self: flex-start;
  }

  #new-invite-title:focus {
    outline: none;
  }

  #new-invite-title:focus-visible {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }

  .qr-wrap {
    display: flex;
    justify-content: center;
  }

  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    min-height: var(--touch);
    padding: var(--sp-1) 0;
    border-top: 1px solid var(--line);
  }
</style>
