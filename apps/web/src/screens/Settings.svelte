<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import NotificationSettings from '../components/NotificationSettings.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Settings (docs/PLAN.md 8, screen 20, M1 subset).
  const account = $derived(app.account!);
  const me = $derived(app.members.find((m) => m.isMe));
  const removed = $derived(account.status === 'removed');
  let name = $state('');
  let nameTouched = $state(false);
  let saving = $state(false);
  let nameError = $state<string | null>(null);
  let serverVersion = $state<string | null>(null);

  $effect(() => {
    if (!nameTouched && me?.name) name = me.name;
  });

  onMount(() => {
    app.core
      .serverInfo(account.serverUrl)
      .then((h) => (serverVersion = h.version))
      .catch(() => undefined);
  });

  async function saveName(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    saving = true;
    nameError = null;
    try {
      await app.core.updateProfile(account.id, name.trim());
      nameTouched = false;
      app.notify(t.settings.nameSaved);
    } catch (err) {
      nameError = errorText(err);
      app.log('warn', 'profile', 'profile update failed', err);
    } finally {
      saving = false;
    }
  }
</script>

<Page title={t.settings.title} onback={() => nav.back()}>
  <section class="section" aria-labelledby="set-profile">
    <h2 id="set-profile">{t.settings.profile}</h2>
    <form class="stack" onsubmit={saveName} novalidate>
      <div class="field">
        <label for="set-name">{t.settings.nameLabel}</label>
        <input
          id="set-name"
          class="input"
          type="text"
          maxlength="64"
          autocomplete="given-name"
          disabled={removed}
          bind:value={name}
          oninput={() => (nameTouched = true)}
        />
      </div>
      {#if nameError}<p class="error-text" role="alert">{nameError}</p>{/if}
      {#if nameTouched && name.trim() !== (me?.name ?? '')}
        <button class="btn" type="submit" disabled={saving || name.trim() === '' || removed}>{t.common.save}</button>
      {/if}
    </form>
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
