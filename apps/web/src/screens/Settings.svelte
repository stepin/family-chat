<script lang="ts">
  import { onMount } from 'svelte';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';
  import NotificationSettings from '../components/NotificationSettings.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Settings (docs/PLAN.md screen 20): profile, notifications, recovery
  // phrase, storage and archive, security, family and server, diagnostics.
  const account = $derived(app.account!);
  const me = $derived(app.members.find((m) => m.isMe));
  let serverVersion = $state<string | null>(null);

  onMount(() => {
    app.core
      .serverInfo(account.serverUrl)
      .then((h) => (serverVersion = h.version))
      .catch(() => undefined);
  });
</script>

<Page title={t.settings.title} onback={() => nav.back()}>
  <section class="section links" aria-labelledby="set-profile">
    <h2 id="set-profile" class="visually-hidden">{t.settings.profile}</h2>
    <button class="item" type="button" onclick={() => nav.push({ name: 'profile' })}>
      <Avatar accountId={account.id} userId={account.userId} name={me?.name ?? null} hasAvatar={!!me?.avatar} size={44} />
      <span class="label">{t.settings.profile}<span class="sub">{me?.name ?? ''}</span></span>
      <Icon name="chevron" size={20} />
    </button>
  </section>

  <section class="section" aria-labelledby="set-notify">
    <h2 id="set-notify">{t.settings.notifications}</h2>
    <NotificationSettings />
  </section>

  <section class="section links" aria-label={t.settings.title}>
    <button class="item" type="button" onclick={() => nav.push({ name: 'phrase' })}>
      <span class="label">{t.settings.phrase}<span class="sub">{t.phrase.status(app.flags.phraseConfirmed)}</span></span>
      <Icon name="chevron" size={20} />
    </button>
    <button class="item" type="button" onclick={() => nav.push({ name: 'storage' })}>
      <span class="label">{t.settings.storage}</span>
      <Icon name="chevron" size={20} />
    </button>
    <button class="item" type="button" onclick={() => nav.push({ name: 'security' })}>
      <span class="label">{t.settings.security}</span>
      <Icon name="chevron" size={20} />
    </button>
    <button class="item" type="button" onclick={() => nav.push({ name: 'server' })}>
      <span class="label">{t.settings.family}<span class="sub">{account.familyName}</span></span>
      <Icon name="chevron" size={20} />
    </button>
    <button class="item" type="button" onclick={() => nav.push({ name: 'diagnostics' })}>
      <span class="label">{t.settings.diagnostics}</span>
      <Icon name="chevron" size={20} />
    </button>
  </section>

  <section class="section" aria-labelledby="set-about">
    <h2 id="set-about">{t.settings.about}</h2>
    <p>{t.settings.aboutText}</p>
    <p class="muted small tabular">
      {t.settings.version(__APP_VERSION__)}{#if serverVersion}<br />{t.settings.serverVersion(serverVersion)}{/if}
    </p>
  </section>
</Page>

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
    border-bottom: 1px solid var(--line);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .item:last-child {
    border-bottom: 0;
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
</style>
