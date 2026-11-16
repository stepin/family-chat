<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import AvatarCrop from '../components/AvatarCrop.svelte';
  import GenderPicker from '../components/GenderPicker.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { fingerprintLines } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t, type Gender } from '../lib/strings.ts';

  // My profile: avatar (pick, square crop, 256 px),
  // name, gender (for the wording of messages about me), and my
  // fingerprint for relatives to compare.
  const account = $derived(app.account!);
  const me = $derived(app.members.find((m) => m.isMe));
  const removed = $derived(account.status === 'removed');
  let name = $state('');
  let nameTouched = $state(false);
  let saving = $state(false);
  let nameError = $state<string | null>(null);
  let picked = $state<File | null>(null);
  let input: HTMLInputElement | undefined = $state();
  let avatarBusy = $state(false);

  $effect(() => {
    if (!nameTouched && me?.name) name = me.name;
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

  let genderBusy = $state(false);

  /** A new gender is signed into the profile at once (no separate save button). */
  async function saveGender(g: Gender): Promise<void> {
    genderBusy = true;
    try {
      await app.core.updateProfile(account.id, { gender: g });
      app.notify(t.gender.saved);
    } catch (err) {
      app.notify(errorText(err));
      app.log('warn', 'profile', 'gender update failed', err);
    } finally {
      genderBusy = false;
    }
  }

  function onPicked(): void {
    const f = input?.files?.[0];
    if (input) input.value = '';
    if (f) picked = f;
  }

  async function saveAvatar(blob: Blob): Promise<void> {
    await app.core.setAvatar(account.id, blob);
    picked = null;
    app.notify(t.profile.avatarSaved);
  }

  async function removeAvatar(): Promise<void> {
    avatarBusy = true;
    try {
      await app.core.removeAvatar(account.id);
      app.notify(t.profile.avatarRemoved);
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'profile', 'removing the avatar failed', e);
    } finally {
      avatarBusy = false;
    }
  }
</script>

<Page title={t.profile.title} onback={() => nav.back()}>
  <section class="section head" aria-labelledby="profile-avatar">
    <h2 id="profile-avatar" class="visually-hidden">{t.profile.avatar}</h2>
    <Avatar accountId={account.id} userId={account.userId} name={me?.name ?? null} hasAvatar={!!me?.avatar} size={112} />
    {#if !removed}
      <div class="row center">
        <button class="btn secondary small" type="button" onclick={() => input?.click()}>
          {me?.avatar ? t.profile.changeAvatar : t.profile.pickAvatar}
        </button>
        {#if me?.avatar}
          <button class="btn secondary small" type="button" disabled={avatarBusy} onclick={removeAvatar}>{t.profile.removeAvatar}</button>
        {/if}
      </div>
      <input
        bind:this={input}
        class="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        tabindex="-1"
        aria-hidden="true"
        data-testid="avatar-input"
        onchange={onPicked}
      />
    {/if}
  </section>

  <section class="section" aria-labelledby="profile-name">
    <h2 id="profile-name">{t.settings.nameLabel}</h2>
    <form class="stack" onsubmit={saveName} novalidate>
      <div class="field">
        <label for="set-name" class="visually-hidden">{t.settings.nameLabel}</label>
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

  {#if me}
    <section class="section" aria-label={t.gender.label}>
      {#key me.gender}
        <GenderPicker id="profile" value={me.gender} disabled={removed || genderBusy} onchange={saveGender} />
      {/key}
    </section>

    <section class="section" aria-labelledby="profile-fp">
      <h2 id="profile-fp">{t.profile.fingerprint}</h2>
      <p class="fp mono tabular" data-testid="my-fingerprint">
        {#each fingerprintLines(me.fingerprint) as line, i (i)}<span>{line}</span>{/each}
      </p>
      <p class="muted small">{t.profile.fingerprintHint}</p>
    </section>
  {/if}
</Page>

{#if picked}
  <AvatarCrop file={picked} onsave={saveAvatar} oncancel={() => (picked = null)} />
{/if}

<style>
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
  }

  .center {
    justify-content: center;
  }

  .fp {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    font-size: var(--text-l);
    letter-spacing: 0.04em;
  }
</style>
