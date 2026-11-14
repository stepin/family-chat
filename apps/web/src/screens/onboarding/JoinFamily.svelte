<script lang="ts">
  import { onMount } from 'svelte';
  import type { AccountView } from '@family-chat/core';
  import Page from '../../components/Page.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { errorText, joinProblem } from '../../lib/errors.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { t } from '../../lib/strings.ts';

  // "Вас пригласили в «Семья»" → name → the chat with the person who invited
  // (docs/PLAN.md 8.1). The server check runs silently and shows only on failure.
  const invite = app.invite;
  let family = $state<string | null>(null);
  let checking = $state(true);
  let unreachable = $state<string | null>(null);
  let name = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let fatal = $state<'used' | 'expired' | 'invalid' | 'already' | null>(null);

  async function check(): Promise<void> {
    if (!invite) return;
    checking = true;
    unreachable = null;
    try {
      family = (await app.core.serverInfo(invite.serverUrl)).familyName;
    } catch (e) {
      unreachable = errorText(e);
      app.log('warn', 'join', 'server check before joining failed', e);
    } finally {
      checking = false;
    }
  }

  onMount(() => {
    if (!invite) nav.reset({ name: 'welcome' });
    else void check();
  });

  /** The chat to open first: the only other member, or the only administrator. */
  async function firstChat(acc: AccountView): Promise<string | null> {
    const users = await app.core.db.users.where('accountId').equals(acc.id).toArray();
    const others = users.filter((u) => u.userId !== acc.userId && !u.removed);
    const peer = others.length === 1 ? others[0] : others.filter((u) => u.admin).length === 1 ? others.find((u) => u.admin) : undefined;
    if (!peer) return null;
    return app.core.openChat(acc.id, peer.userId).catch(() => null);
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!invite || busy) return;
    busy = true;
    error = null;
    try {
      const acc = await app.core.join({ serverUrl: invite.serverUrl, code: { invite: invite.code }, name: name.trim() });
      app.invite = null;
      void navigator.storage?.persist?.().catch(() => false);
      const chatId = await firstChat(acc);
      nav.reset({ name: 'list' });
      if (chatId) nav.openChat(acc.id, chatId, true);
    } catch (err) {
      const p = joinProblem(err);
      if (p === 'used' || p === 'expired' || p === 'invalid' || p === 'already') {
        fatal = p;
        app.invite = null;
      } else error = errorText(err);
      app.log('warn', 'join', 'joining by invitation failed', err);
    } finally {
      busy = false;
    }
  }

  const back = nav.stack.length > 1 ? () => nav.back() : undefined;
</script>

<Page title={family ? t.join.title(family) : t.join.titleUnknown} onback={back} narrow>
  {#if fatal}
    <div class="stack">
      <p class="notice warn" role="alert">
        {fatal === 'used' ? t.join.used : fatal === 'expired' ? t.join.expired : fatal === 'invalid' ? t.join.invalid : t.join.already}
      </p>
      {#if fatal === 'already'}
        <button class="btn block" type="button" onclick={() => nav.reset({ name: 'list' })}>{t.join.toChats}</button>
      {:else}
        <button class="btn secondary block" type="button" onclick={() => nav.reset({ name: 'welcome' })}>{t.common.back}</button>
      {/if}
    </div>
  {:else if checking}
    <p class="muted" role="status">{t.join.checking}</p>
  {:else if unreachable}
    <div class="stack">
      <p class="notice error" role="alert">{unreachable}</p>
      <button class="btn block" type="button" onclick={check}>{t.common.retry}</button>
    </div>
  {:else}
    <form class="stack" onsubmit={submit} novalidate>
      <div class="field">
        <label for="join-name">{t.join.nameLabel}</label>
        <input
          id="join-name"
          class="input"
          type="text"
          maxlength="64"
          autocomplete="given-name"
          aria-describedby="join-name-hint"
          bind:value={name}
        />
        <span id="join-name-hint" class="hint">{t.join.nameHint}</span>
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || name.trim().length === 0}>
        {busy ? t.join.joining : t.join.submit}
      </button>
    </form>
  {/if}
</Page>
