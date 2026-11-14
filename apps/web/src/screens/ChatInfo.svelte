<script lang="ts">
  import { onMount } from 'svelte';
  import type { GroupMemberView, GroupView, IdentityLinkView } from '@family-chat/core';
  import Avatar from '../components/Avatar.svelte';
  import MemberChecklist from '../components/MemberChecklist.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { displayNames, joinNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Group info (docs/PLAN.md screen 17): name and members for everyone; the
  // owner renames, adds (with the honest confirmation and "Добавить без
  // прежней переписки", docs/PLAN-v2.md 8), removes and transfers ownership;
  // everyone can leave (the owner names the new owner first).
  let { accountId, chatId }: { accountId: string; chatId: string } = $props();

  let group = $state.raw<GroupView | null>(null);
  const account = $derived(app.accounts.find((a) => a.id === accountId) ?? null);
  const names = $derived(displayNames(app.members, t.common.unknownName));
  const memberById = $derived(new Map(app.members.map((m) => [m.userId, m])));
  const canManage = $derived(!!group && group.isOwner && group.member && !group.frozen && !group.broken);
  const inGroup = $derived(new Set(group?.members.map((m) => m.userId) ?? []));
  const addable = $derived(
    app.members
      .filter((m) => !m.isMe && !m.removed && !m.revoked && !inGroup.has(m.userId))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ru')),
  );
  const others = $derived(group?.members.filter((m) => !m.isMe && !m.removed && !m.revoked) ?? []);

  let renaming = $state(false);
  let newName = $state('');
  let busy = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;
  type Dialog =
    | { readonly kind: 'add'; readonly step: 'pick' | 'confirm' }
    | { readonly kind: 'remove'; readonly member: GroupMemberView }
    | { readonly kind: 'owner'; readonly member: GroupMemberView }
    | { readonly kind: 'leave' };
  let dlg = $state.raw<Dialog | null>(null);
  let toAdd = $state<string[]>([]);
  let newOwner = $state<string | null>(null);
  let dlgError = $state<string | null>(null);

  // M5: a member linked on this device to a newer identity (docs/PLAN.md 8.6): the owner is offered to add it.
  let links = $state.raw<IdentityLinkView[]>([]);
  const suggested = $derived(
    canManage
      ? links.filter((l) => l.valid && inGroup.has(l.userId) && !inGroup.has(l.to) && addable.some((m) => m.userId === l.to))
      : [],
  );

  onMount(() => {
    void app.core.refreshMembers(accountId).catch(() => undefined);
    const unsubLinks = app.core.identityLinks(accountId).subscribe((l) => (links = l));
    const unsub = app.core.group(accountId, chatId).subscribe((g) => (group = g));
    return () => {
      unsub();
      unsubLinks();
    };
  });

  async function addLinked(userId: string): Promise<void> {
    busy = true;
    try {
      await app.core.addGroupMembers(accountId, chatId, [userId]);
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'group', 'adding a linked identity failed', e);
    } finally {
      busy = false;
    }
  }

  function nameOf(m: GroupMemberView): string {
    return names.get(m.userId) ?? m.name ?? t.common.unknownName;
  }

  function marks(m: GroupMemberView): string {
    return [
      m.isMe ? t.group.you : null,
      m.isOwner ? t.group.owner : null,
      m.revoked ? t.group.revoked : m.removed ? t.group.removed : null,
      m.keyMismatch ? t.group.keyMismatch : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  function open(next: Dialog, e: Event): void {
    opener = e.currentTarget as HTMLElement;
    dlg = next;
    dlgError = null;
    toAdd = [];
    newOwner = null;
    dialog?.showModal();
  }

  function close(): void {
    dialog?.close();
  }

  function onClose(): void {
    dlg = null;
    opener?.focus();
  }

  function failure(e: unknown): string {
    const text = errorText(e);
    return text === t.errors.generic ? t.group.changeFailed : text;
  }

  async function run(what: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    dlgError = null;
    try {
      await action();
      close();
    } catch (e) {
      dlgError = failure(e);
      app.log('warn', 'group', `${what} failed`, e);
    } finally {
      busy = false;
    }
  }

  async function rename(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy || newName.trim() === '') return;
    busy = true;
    try {
      await app.core.renameGroup(accountId, chatId, newName.trim());
      renaming = false;
      app.notify(t.group.renamed);
    } catch (err) {
      app.notify(failure(err));
      app.log('warn', 'group', 'rename failed', err);
    } finally {
      busy = false;
    }
  }

  const addNames = $derived(joinNames(toAdd.map((id) => names.get(id) ?? t.common.unknownName)));

  function add(history: boolean): Promise<void> {
    const ids = [...toAdd];
    return run('adding members', () => app.core.addGroupMembers(accountId, chatId, ids, { history }));
  }

  function leave(): Promise<void> {
    if (group?.isOwner) {
      const to = newOwner;
      if (!to) return Promise.resolve();
      return run('leaving the group', async () => {
        await app.core.leaveGroup(accountId, chatId, { transferTo: to });
        nav.back();
      });
    }
    return run('leaving the group', async () => {
      await app.core.leaveGroup(accountId, chatId);
      nav.back();
    });
  }
</script>

<Page title={t.group.info} onback={() => nav.back()}>
  {#if group}
    <section class="section head" aria-labelledby="info-name">
      <Avatar {accountId} kind="group" size={72} />
      <h2 id="info-name" class="group-name">{group.name ?? t.group.title(null)}</h2>
      <p class="muted">{t.group.members(group.members.length)}</p>
      {#if canManage}
        {#if renaming}
          <form class="rename stack" onsubmit={rename} novalidate>
            <div class="field">
              <label for="rename-field">{t.group.renameLabel}</label>
              <input id="rename-field" class="input" type="text" maxlength="64" bind:value={newName} />
            </div>
            <div class="row">
              <button class="btn" type="submit" disabled={busy || newName.trim() === ''}>{t.common.save}</button>
              <button class="btn secondary" type="button" onclick={() => (renaming = false)}>{t.common.cancel}</button>
            </div>
          </form>
        {:else}
          <button
            class="btn secondary small"
            type="button"
            onclick={() => {
              newName = group?.name ?? '';
              renaming = true;
            }}>{t.group.rename}</button
          >
        {/if}
      {/if}
    </section>

    {#if group.frozen}
      <p class="notice warn">{t.group.frozen}</p>
    {/if}
    {#if !group.member}
      <p class="notice">{t.group.notMember}</p>
    {/if}
    {#each suggested as l (l.userId)}
      <div class="notice stack" data-testid="linked-suggestion">
        <p>{t.group.linkedSuggestion(names.get(l.userId) ?? t.common.unknownName, names.get(l.to) ?? t.common.unknownName)}</p>
        <button class="btn small" type="button" disabled={busy} onclick={() => addLinked(l.to)}>{t.group.addLinked}</button>
      </div>
    {/each}

    <section class="section" aria-labelledby="info-members">
      <div class="row between">
        <h2 id="info-members">{t.group.members(group.members.length)}</h2>
        {#if canManage}
          <button class="btn small" type="button" onclick={(e) => open({ kind: 'add', step: 'pick' }, e)}>{t.group.add}</button>
        {/if}
      </div>
      <ul class="members">
        {#each group.members as m (m.userId)}
          {@const mark = marks(m)}
          <li data-testid="group-member">
            {#if m.isMe}
              <span class="who">
                <Avatar {accountId} userId={m.userId} name={nameOf(m)} hasAvatar={!!m.avatar} size={40} />
                <span class="text"><span class="name">{nameOf(m)}</span>{#if mark}<span class="muted small">{mark}</span>{/if}</span>
              </span>
            {:else}
              <button class="who as-button" type="button" onclick={() => nav.push({ name: 'contact', accountId, userId: m.userId })}>
                <Avatar {accountId} userId={m.userId} name={nameOf(m)} hasAvatar={!!memberById.get(m.userId)?.avatar} size={40} />
                <span class="text"><span class="name">{nameOf(m)}</span>{#if mark}<span class="muted small">{mark}</span>{/if}</span>
              </button>
            {/if}
            {#if canManage && !m.isMe}
              <span class="actions">
                {#if !m.removed && !m.revoked}
                  <button class="btn secondary small" type="button" onclick={(e) => open({ kind: 'owner', member: m }, e)}>{t.group.makeOwner}</button>
                {/if}
                <button class="btn secondary small" type="button" onclick={(e) => open({ kind: 'remove', member: m }, e)}>{t.group.remove}</button>
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    {#if group.member}
      <section class="section">
        <button class="btn danger" type="button" onclick={(e) => open({ kind: 'leave' }, e)}>{t.group.leave}</button>
      </section>
    {/if}
  {:else}
    <p class="muted" role="status">{t.common.loading}</p>
  {/if}
</Page>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="info-dialog-title">
  {#if dlg?.kind === 'add' && dlg.step === 'pick'}
    <div class="stack">
      <h2 id="info-dialog-title">{t.group.addTitle}</h2>
      {#if addable.length === 0}
        <p>{t.group.addNone}</p>
        <div class="row end"><button class="btn secondary" type="button" onclick={close}>{t.common.close}</button></div>
      {:else}
        <p class="muted">{t.group.addPick}</p>
        <MemberChecklist {accountId} members={addable} {names} bind:selected={toAdd} label={t.group.addTitle} />
        <div class="row end">
          <button class="btn secondary" type="button" onclick={close}>{t.common.cancel}</button>
          <button class="btn" type="button" disabled={toAdd.length === 0} onclick={() => (dlg = { kind: 'add', step: 'confirm' })}>{t.common.next}</button>
        </div>
      {/if}
    </div>
  {:else if dlg?.kind === 'add'}
    <div class="stack">
      <h2 id="info-dialog-title">{t.group.addConfirmTitle(addNames)}</h2>
      <p>{t.group.addConfirmText(account?.retentionDays ?? 90)}</p>
      {#if dlgError}<p class="error-text" role="alert">{dlgError}</p>{/if}
      <div class="stack">
        <button class="btn" type="button" disabled={busy} onclick={() => add(true)}>{t.group.addWithHistory}</button>
        <button class="btn secondary" type="button" disabled={busy} onclick={() => add(false)}>{t.group.addWithoutHistory}</button>
        <button class="btn secondary" type="button" disabled={busy} onclick={close}>{t.common.cancel}</button>
      </div>
    </div>
  {:else if dlg?.kind === 'remove'}
    {@const m = dlg.member}
    <div class="stack">
      <h2 id="info-dialog-title">{t.group.removeTitle(nameOf(m))}</h2>
      <p>{t.group.removeText}</p>
      {#if dlgError}<p class="error-text" role="alert">{dlgError}</p>{/if}
      <div class="row end">
        <button class="btn secondary" type="button" onclick={close}>{t.common.cancel}</button>
        <button class="btn danger" type="button" disabled={busy} onclick={() => run('removing a member', () => app.core.removeGroupMembers(accountId, chatId, [m.userId]))}>
          {t.group.removeConfirm}
        </button>
      </div>
    </div>
  {:else if dlg?.kind === 'owner'}
    {@const m = dlg.member}
    <div class="stack">
      <h2 id="info-dialog-title">{t.group.ownerTitle(nameOf(m))}</h2>
      <p>{t.group.ownerText}</p>
      {#if dlgError}<p class="error-text" role="alert">{dlgError}</p>{/if}
      <div class="row end">
        <button class="btn secondary" type="button" onclick={close}>{t.common.cancel}</button>
        <button class="btn" type="button" disabled={busy} onclick={() => run('transferring ownership', () => app.core.transferGroupOwnership(accountId, chatId, m.userId))}>
          {t.group.ownerConfirm}
        </button>
      </div>
    </div>
  {:else if dlg?.kind === 'leave'}
    <div class="stack">
      {#if group?.isOwner}
        <h2 id="info-dialog-title">{t.group.leaveOwnerTitle}</h2>
        {#if others.length === 0}
          <p>{t.group.leaveNobody}</p>
          <div class="row end"><button class="btn secondary" type="button" onclick={close}>{t.common.close}</button></div>
        {:else}
          <p>{t.group.leaveOwnerText}</p>
          <fieldset class="owners">
            <legend class="visually-hidden">{t.group.leaveOwnerTitle}</legend>
            {#each others as m (m.userId)}
              <label class="owner-option">
                <input type="radio" name="new-owner" value={m.userId} bind:group={newOwner} />
                <span>{nameOf(m)}</span>
              </label>
            {/each}
          </fieldset>
          <p class="muted small">{t.group.leaveText}</p>
          {#if dlgError}<p class="error-text" role="alert">{dlgError}</p>{/if}
          <div class="row end">
            <button class="btn secondary" type="button" onclick={close}>{t.common.cancel}</button>
            <button class="btn danger" type="button" disabled={busy || !newOwner} onclick={leave}>{t.group.leaveOwnerConfirm}</button>
          </div>
        {/if}
      {:else}
        <h2 id="info-dialog-title">{t.group.leaveTitle}</h2>
        <p>{t.group.leaveText}</p>
        {#if dlgError}<p class="error-text" role="alert">{dlgError}</p>{/if}
        <div class="row end">
          <button class="btn secondary" type="button" onclick={close}>{t.common.cancel}</button>
          <button class="btn danger" type="button" disabled={busy} onclick={leave}>{t.group.leaveConfirm}</button>
        </div>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    text-align: center;
  }

  .group-name {
    font-size: var(--text-xl);
    overflow-wrap: anywhere;
  }

  .rename {
    width: 100%;
    max-width: 24rem;
    text-align: left;
  }

  .between {
    justify-content: space-between;
  }

  .members {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .members li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    min-height: 56px;
    padding: var(--sp-1) 0;
    border-top: 1px solid var(--line);
  }

  .members li:first-child {
    border-top: 0;
  }

  .who {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex: 1 1 12rem;
    min-width: 0;
    min-height: var(--touch);
  }

  .as-button {
    padding: 0;
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .as-button:hover .name {
    text-decoration: underline;
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .owners {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .owner-option {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--touch);
    cursor: pointer;
  }

  .owner-option input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }

  .end {
    justify-content: flex-end;
  }
</style>
