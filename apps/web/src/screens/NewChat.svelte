<script lang="ts">
  import { onMount } from 'svelte';
  import type { Member } from '@family-chat/core';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { displayNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // New chat: pick a relative, or "Новая группа".
  const account = $derived(app.account!);
  const names = $derived(displayNames(app.members.filter((m) => !m.isMe), t.common.unknownName));
  const others = $derived(
    app.members
      .filter((m) => !m.isMe && !m.removed && !m.revoked)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ru')),
  );

  onMount(() => {
    void app.core.refreshMembers(account.id).catch(() => undefined);
  });

  async function pick(m: Member): Promise<void> {
    try {
      const chatId = await app.core.openChat(account.id, m.userId);
      nav.openChat(account.id, chatId, true);
    } catch (e) {
      app.notify(t.errors.generic);
      app.log('warn', 'chat', 'opening a chat failed', e);
    }
  }
</script>

<Page title={t.newChat.title} onback={() => nav.back()}>
  <div class="stack">
    {#if others.length > 0}
      <button class="new-group" type="button" onclick={() => nav.push({ name: 'new-group' })}>
        <Avatar accountId={account.id} kind="group" size={40} />
        <span class="name">{t.newChat.newGroup}</span>
        <Icon name="chevron" size={20} />
      </button>
    {/if}
    <p class="muted">{t.newChat.lead}</p>
    {#if others.length === 0}
      <p>{t.newChat.empty}</p>
      {#if account.admin}
        <button class="btn" type="button" onclick={() => nav.push({ name: 'invites' })}>{t.newChat.invite}</button>
      {/if}
    {:else}
      <ul class="people">
        {#each others as m (m.userId)}
          <li>
            <button type="button" class="person" onclick={() => pick(m)}>
              <Avatar accountId={account.id} userId={m.userId} name={m.name} hasAvatar={!!m.avatar} size={40} />
              <span class="name">{names.get(m.userId) ?? t.common.unknownName}</span>
              <Icon name="chevron" size={20} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Page>

<style>
  .people {
    margin: 0;
    padding: 0;
    list-style: none;
    border-radius: var(--r-l);
    background: var(--surface);
    overflow: hidden;
  }

  .new-group {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 60px;
    padding: var(--sp-2) var(--sp-4);
    border: 0;
    border-radius: var(--r-l);
    background: var(--surface);
    text-align: left;
    cursor: pointer;
  }

  .new-group:hover {
    background: var(--surface-2);
  }

  .person {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 60px;
    padding: var(--sp-2) var(--sp-4);
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .people li:last-child .person {
    border-bottom: 0;
  }

  .person:hover {
    background: var(--surface-2);
  }


  .name {
    flex: 1 1 auto;
    font-size: var(--text-m);
    font-weight: 600;
  }
</style>
