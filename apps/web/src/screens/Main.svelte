<script lang="ts">
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';
  import ChatList from './ChatList.svelte';
  import Chat from './Chat.svelte';
  import NewChat from './NewChat.svelte';
  import Settings from './Settings.svelte';
  import PhraseScreen from './PhraseScreen.svelte';
  import ServerDetails from './ServerDetails.svelte';
  import Invites from './Invites.svelte';
  import Diagnostics from './Diagnostics.svelte';

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
        {#key `${top.accountId}/${top.chatId}`}
          <Chat accountId={top.accountId} chatId={top.chatId} focus={top.focus ?? false} />
        {/key}
      {:else if top.name === 'new-chat'}
        <NewChat />
      {:else if top.name === 'settings'}
        <Settings />
      {:else if top.name === 'phrase'}
        <PhraseScreen />
      {:else if top.name === 'server'}
        <ServerDetails />
      {:else if top.name === 'invites'}
        <Invites />
      {:else if top.name === 'diagnostics'}
        <Diagnostics />
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
