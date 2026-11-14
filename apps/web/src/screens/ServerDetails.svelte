<script lang="ts">
  import { onMount } from 'svelte';
  import type { Member, ServerStats } from '@family-chat/core';
  import InviteFamily from '../components/InviteFamily.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatBytes } from '../lib/format.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Family and server (docs/PLAN-v2.md 8, screen 21). Everyone: address,
  // family name, retention, members. Administrator: invitations, removing a
  // member, disk statistics.
  const account = $derived(app.account!);
  const members = $derived(
    [...app.members].sort((a, b) => Number(b.isMe) - Number(a.isMe) || (a.name ?? '').localeCompare(b.name ?? '', 'ru')),
  );
  // The trust line applies when the app was loaded from the family server itself.
  const fromServer = $derived(account.serverUrl.startsWith(location.origin));
  let stats = $state<ServerStats | null>(null);
  let statsError = $state(false);
  let toRemove = $state<Member | null>(null);
  let removing = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;

  onMount(() => {
    void app.core.refreshMembers(account.id).catch(() => undefined);
    if (account.admin) {
      app.core.admin
        .stats(account.id)
        .then((s) => (stats = s))
        .catch((e: unknown) => {
          statsError = true;
          app.log('warn', 'admin', 'stats failed', e);
        });
    }
  });

  function askRemove(m: Member, e: MouseEvent): void {
    opener = e.currentTarget as HTMLElement;
    toRemove = m;
    dialog?.showModal();
  }

  function closeDialog(): void {
    dialog?.close();
  }

  function onClose(): void {
    toRemove = null;
    // Focus returns to the button that opened the dialog (docs/PLAN.md 8.7).
    opener?.focus();
  }

  async function confirmRemove(): Promise<void> {
    if (!toRemove) return;
    removing = true;
    try {
      await app.core.admin.removeUser(account.id, toRemove.userId);
      closeDialog();
    } catch (e) {
      app.notify(t.server.removeFailed);
      app.log('warn', 'admin', 'removing a member failed', e);
    } finally {
      removing = false;
    }
  }
</script>

<Page title={t.server.title} onback={() => nav.back()}>
  {#if fromServer}
    <p class="notice trust" data-testid="trust-line">{t.server.trust}</p>
  {/if}

  <section class="section" aria-labelledby="srv-info">
    <h2 id="srv-info">{account.familyName}</h2>
    <dl>
      <dt>{t.server.address}</dt>
      <dd class="mono">{account.serverUrl}</dd>
      <dt>{t.server.family}</dt>
      <dd>{account.familyName}</dd>
      <dt>{t.server.retention}</dt>
      <dd>{t.server.retentionValue(account.retentionDays)}</dd>
    </dl>
  </section>

  <section class="section" aria-labelledby="srv-members">
    <h2 id="srv-members">{t.server.members}</h2>
    <ul class="members">
      {#each members as m (m.userId)}
        <li>
          <span class="who">
            <span class="name">{m.name ?? t.common.unknownName}</span>
            <span class="muted small">
              {[m.isMe ? t.server.me : null, m.admin ? t.server.admin : null, m.removed ? t.server.removed : null]
                .filter(Boolean)
                .join(', ')}
            </span>
          </span>
          {#if account.admin && !m.isMe && !m.removed}
            <button class="btn secondary small" type="button" onclick={(e) => askRemove(m, e)}>{t.server.removeMember}</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  {#if account.admin}
    <section class="section" aria-labelledby="srv-invites">
      <h2 id="srv-invites">{t.server.invites}</h2>
      <InviteFamily accountId={account.id} />
    </section>

    <section class="section" aria-labelledby="srv-disk">
      <h2 id="srv-disk">{t.server.disk}</h2>
      {#if stats}
        <ul class="plain small">
          <li>{t.server.diskData(formatBytes(stats.dataBytes))}</li>
          {#if stats.freeBytes !== null}<li>{t.server.diskFree(formatBytes(stats.freeBytes))}</li>{/if}
          <li>{t.server.events(stats.events)}</li>
          <li>{t.server.push(stats.push)}</li>
          <li>{t.server.serverVersion(stats.version)}</li>
        </ul>
      {:else if statsError}
        <p class="error-text">{t.server.loadFailed}</p>
      {:else}
        <p class="muted">{t.common.loading}</p>
      {/if}
    </section>
  {/if}
</Page>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="remove-title">
  {#if toRemove}
    <div class="stack">
      <h2 id="remove-title">{t.server.removeTitle(toRemove.name ?? t.common.unknownName)}</h2>
      <p>{t.server.removeText}</p>
      <div class="row end">
        <button class="btn secondary" type="button" onclick={closeDialog}>{t.common.cancel}</button>
        <button class="btn danger" type="button" disabled={removing} onclick={confirmRemove}>{t.server.removeConfirm}</button>
      </div>
    </div>
  {/if}
</dialog>

<style>
  .trust {
    margin-bottom: var(--sp-4);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--sp-1) var(--sp-4);
    margin: 0;
    overflow-wrap: anywhere;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
  }

  .members,
  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .members li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    min-height: 52px;
    border-top: 1px solid var(--line);
  }

  .members li:first-child {
    border-top: 0;
  }

  .who {
    display: flex;
    flex-direction: column;
  }

  .name {
    font-weight: 600;
  }

  .plain li {
    padding: var(--sp-1) 0;
  }

  .end {
    justify-content: flex-end;
  }
</style>
