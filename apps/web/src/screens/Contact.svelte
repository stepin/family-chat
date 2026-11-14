<script lang="ts">
  import { onMount } from 'svelte';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { displayNames, fingerprintLines } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Contact profile (docs/PLAN.md screen 18): avatar, name, fingerprint, the
  // "сверено" mark, "написать"; a changed key with a warning and an accept
  // action; revoked and removed contacts marked.
  let { accountId, userId }: { accountId: string; userId: string } = $props();

  const member = $derived(app.members.find((m) => m.accountId === accountId && m.userId === userId) ?? null);
  const names = $derived(displayNames(app.members.filter((m) => !m.isMe), t.common.unknownName));
  const name = $derived(member ? (names.get(member.userId) ?? t.common.unknownName) : t.common.unknownName);
  const canWrite = $derived(!!member && !member.isMe && !member.removed && !member.revoked);
  let busy = $state(false);

  onMount(() => {
    void app.core.refreshMembers(accountId).catch(() => undefined);
  });

  async function setVerified(on: boolean): Promise<void> {
    try {
      await app.core.setVerified(accountId, userId, on);
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'contact', 'verification mark failed', e);
    }
  }

  async function acceptKey(): Promise<void> {
    busy = true;
    try {
      await app.core.acceptKeyChange(accountId, userId);
      app.notify(t.contact.accepted);
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'contact', 'accepting a key change failed', e);
    } finally {
      busy = false;
    }
  }

  async function write(): Promise<void> {
    try {
      const chatId = await app.core.openChat(accountId, userId);
      nav.openChat(accountId, chatId, true);
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'contact', 'opening a chat failed', e);
    }
  }
</script>

<Page title={t.contact.title} onback={() => nav.back()}>
  {#if member}
    <section class="section head" aria-labelledby="contact-name">
      <Avatar {accountId} userId={member.userId} name={member.name} hasAvatar={!!member.avatar} size={96} />
      <h2 id="contact-name" class="name">
        {name}
        {#if member.verified}<span class="verified" title={t.contact.verified}><Icon name="shield" size={18} /><span class="visually-hidden">, {t.contact.verifiedMark}</span></span>{/if}
      </h2>
      {#if member.isMe}<p class="muted">{t.contact.me}</p>{/if}
      {#if canWrite}
        <button class="btn" type="button" onclick={write}>{t.contact.write}</button>
      {/if}
    </section>

    {#if member.revoked}
      <p class="notice error" role="status">{t.contact.revoked}</p>
    {:else if member.removed}
      <p class="notice" role="status">{t.contact.removed}</p>
    {/if}

    {#if member.keyChanged && !member.revoked}
      <section class="notice warn stack" aria-labelledby="key-changed">
        <h2 id="key-changed">{t.contact.keyChangedTitle}</h2>
        <p>{t.contact.keyChangedText}</p>
        <button class="btn small" type="button" disabled={busy} onclick={acceptKey}>{t.contact.acceptKey}</button>
      </section>
    {/if}

    <section class="section" aria-labelledby="contact-fp">
      <h2 id="contact-fp">{t.contact.fingerprint}</h2>
      <p class="fp mono tabular" data-testid="fingerprint">
        {#each fingerprintLines(member.fingerprint) as line, i (i)}<span>{line}</span>{/each}
      </p>
      <p class="muted small">{t.contact.fingerprintHint}</p>
      {#if !member.isMe && !member.revoked}
        <label class="switch">
          <input
            type="checkbox"
            role="switch"
            checked={member.verified}
            aria-describedby="verified-hint"
            onchange={(e) => setVerified(e.currentTarget.checked)}
          />
          <span>
            <span class="label">{t.contact.verified}</span>
            <span id="verified-hint" class="muted small">{t.contact.verifiedHint}</span>
          </span>
        </label>
      {/if}
    </section>
  {:else}
    <p class="muted" role="status">{t.common.loading}</p>
  {/if}
</Page>

<style>
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    text-align: center;
  }

  .name {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--text-xl);
    overflow-wrap: anywhere;
  }

  .verified {
    display: inline-flex;
    color: var(--ok);
  }

  .fp {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin: var(--sp-2) 0;
    font-size: var(--text-l);
    letter-spacing: 0.04em;
  }

  .switch {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    min-height: var(--touch);
    margin-top: var(--sp-3);
    cursor: pointer;
  }

  .switch input {
    width: 22px;
    height: 22px;
    margin-top: 2px;
    accent-color: var(--accent);
  }

  .switch .label {
    display: block;
    font-weight: 600;
  }

  .notice + .section,
  .section + .notice,
  .notice + .notice {
    margin-top: var(--sp-4);
  }
</style>
