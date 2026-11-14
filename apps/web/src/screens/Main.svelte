<script lang="ts">
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';
  import ChatList from './ChatList.svelte';
  import Chat from './Chat.svelte';
  import { lazy } from '../lib/lazy.ts';

  // The list and the chat are in the first bundle; every other screen loads
  // on first use (code splitting keeps the first load small).
  const NewChat = lazy(() => import('./NewChat.svelte'));
  const Settings = lazy(() => import('./Settings.svelte'));
  const PhraseScreen = lazy(() => import('./PhraseScreen.svelte'));
  const ServerDetails = lazy(() => import('./ServerDetails.svelte'));
  const Invites = lazy(() => import('./Invites.svelte'));
  const Diagnostics = lazy(() => import('./Diagnostics.svelte'));
  const NewGroup = lazy(() => import('./NewGroup.svelte'));
  const ChatInfo = lazy(() => import('./ChatInfo.svelte'));
  const Contact = lazy(() => import('./Contact.svelte'));
  const MyProfile = lazy(() => import('./MyProfile.svelte'));
  const Storage = lazy(() => import('./Storage.svelte'));
  const Security = lazy(() => import('./Security.svelte'));
  const SearchScreen = lazy(() => import('./SearchScreen.svelte'));

  // One column below 900 px (a stack of screens over the chat list), two
  // columns from 900 px: the list and the open screen (docs/PLAN.md 8.2).
  const top = $derived(nav.top);
  const showList = $derived(app.wide || top.name === 'list');
</script>

<div class="main" class:wide={app.wide} data-layout={app.wide ? 'two-columns' : 'one-column'}>
  <div class="list-pane" class:hidden={!showList}>
    <ChatList />
  </div>
  {#if app.wide || top.name !== 'list'}
    <div class="content-pane">
      {#if top.name === 'chat'}
        {#key `${top.accountId}/${top.chatId}/${top.jump?.msgId ?? ''}`}
          <Chat accountId={top.accountId} chatId={top.chatId} focus={top.focus ?? false} jump={top.jump ?? null} />
        {/key}
      {:else if top.name === 'search'}
        {#await SearchScreen() then { default: C }}<C />{/await}
      {:else if top.name === 'new-chat'}
        {#await NewChat() then { default: C }}<C />{/await}
      {:else if top.name === 'new-group'}
        {#await NewGroup() then { default: C }}<C members={top.members ?? []} title={top.title ?? ''} />{/await}
      {:else if top.name === 'chat-info'}
        {#key `${top.accountId}/${top.chatId}`}
          {#await ChatInfo() then { default: C }}<C accountId={top.accountId} chatId={top.chatId} />{/await}
        {/key}
      {:else if top.name === 'contact'}
        {#key `${top.accountId}/${top.userId}`}
          {#await Contact() then { default: C }}<C accountId={top.accountId} userId={top.userId} />{/await}
        {/key}
      {:else if top.name === 'profile'}
        {#await MyProfile() then { default: C }}<C />{/await}
      {:else if top.name === 'storage'}
        {#await Storage() then { default: C }}<C />{/await}
      {:else if top.name === 'security'}
        {#await Security() then { default: C }}<C />{/await}
      {:else if top.name === 'settings'}
        {#await Settings() then { default: C }}<C />{/await}
      {:else if top.name === 'phrase'}
        {#await PhraseScreen() then { default: C }}<C />{/await}
      {:else if top.name === 'server'}
        {#await ServerDetails() then { default: C }}<C />{/await}
      {:else if top.name === 'invites'}
        {#await Invites() then { default: C }}<C />{/await}
      {:else if top.name === 'diagnostics'}
        {#await Diagnostics() then { default: C }}<C />{/await}
      {:else}
        <div class="placeholder"><p class="muted">{t.list.pickChat}</p></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .main {
    display: flex;
    height: 100%;
    min-height: 0;
  }

  .list-pane,
  .content-pane {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  .hidden {
    display: none;
  }

  .wide .list-pane {
    flex: 0 0 var(--list-width);
    border-right: 1px solid var(--line);
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }
</style>
