<script lang="ts">
  import { onMount } from 'svelte';
  import { isApiError, isCoreError, type AccountView } from '@family-chat/core';
  import GenderPicker from '../components/GenderPicker.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { inviteLinkFor, parseInviteInput, sameServer, type ParsedInvite } from '../lib/invite.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t, type Gender } from '../lib/strings.ts';

  // Adding a family (each has its own address: a server, or `…/f/<id>` on
  // a server with several families), without losing the families already
  // here: by invitation link, as an existing member (this device's identity,
  // or the recovery phrase of another one), or as an administrator with the
  // server admin code (a new family on that server). The identity is a choice: the
  // same one (one phrase for all families; the same userId and fingerprint
  // everywhere, because the userId comes from the key) or a new one. Nothing
  // of one family is ever sent to another family's server.
  type Mode = 'invite' | 'member' | 'admin';
  let mode = $state<Mode>('invite');
  let link = $state('');
  let serverUrl = $state('');
  let adminCode = $state('');
  let familyName = $state('');
  let phrase = $state('');
  let name = $state('');
  // The gender in the family open now, as a starting point.
  let gender = $state<Gender>(app.myGender);
  let invite = $state.raw<ParsedInvite | null>(null);
  let invited = $state<{ family: string; by: string | null } | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  /** Identities on this device, each with a family it is used in (for the label). */
  const identities = $derived.by(() => {
    const out = new Map<string, AccountView>();
    for (const a of app.accounts) if (!out.has(a.userId)) out.set(a.userId, a);
    return [...out.values()];
  });
  // svelte-ignore state_referenced_locally
  let identity = $state<string>(app.account?.userId ?? 'new');
  const myName = $derived(app.members.find((m) => m.isMe)?.name ?? '');

  onMount(() => {
    name = myName;
    if (app.invite) {
      link = inviteLinkFor(app.invite);
      app.invite = null;
      void check();
    }
  });

  function setMode(m: Mode): void {
    mode = m;
    error = null;
    if (m === 'member' && identity === 'new') identity = identities[0]?.userId ?? 'phrase';
    if (m !== 'member' && identity === 'phrase') identity = identities[0]?.userId ?? 'new';
  }

  async function check(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    error = null;
    invited = null;
    const parsed = parseInviteInput(link, '');
    if (!parsed || !/^https?:\/\//.test(parsed.serverUrl)) {
      error = t.addFamily.badInvite;
      return;
    }
    if (app.accounts.some((a) => sameServer(a.serverUrl, parsed.serverUrl))) {
      error = t.addFamily.exists;
      return;
    }
    const at = parsed.serverUrl;
    busy = true;
    try {
      const c = await app.core.checkInvite(parsed.serverUrl, parsed.code);
      if (c.status === 'invalid') error = t.join.invalid;
      else if (c.status === 'used') error = t.join.used;
      else if (c.status === 'expired') error = t.join.expired;
      else {
        invite = parsed;
        invited = { family: c.familyName, by: c.createdBy.name };
      }
    } catch (err) {
      error = familyError(err, at);
      app.log('warn', 'join', 'invitation check for another family failed', err);
    } finally {
      busy = false;
    }
  }

  /** A `/f/…` address that answers 404 is a family that does not exist (not "not a server"). */
  function familyError(err: unknown, url: string): string {
    if (isApiError(err) && err.status === 404 && /\/f\/[^/]+\/?$/.test(url.trim())) return t.addFamily.notFound;
    if (isCoreError(err, 'account-exists')) return t.addFamily.exists;
    if (isCoreError(err, 'unknown-user')) return t.addFamily.notMember;
    return errorText(err);
  }

  async function done(acc: AccountView): Promise<void> {
    await app.switchAccount(acc.id);
    nav.reset({ name: 'list' });
    app.notify(t.addFamily.added(acc.familyName));
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    const who = identity === 'new' || identity === 'phrase' ? {} : { userId: identity };
    try {
      if (mode === 'invite') {
        if (!invite) return;
        const acc = await app.core.join({ serverUrl: invite.serverUrl, code: { invite: invite.code }, name: name.trim(), gender, ...who });
        await done(acc);
      } else if (mode === 'admin') {
        // The family is created first: its new address is not on this device yet.
        const acc = await app.core.setUpFamily({
          serverUrl,
          serverCode: adminCode.trim(),
          familyName: familyName.trim(),
          name: name.trim(),
          gender,
          ...who,
        });
        adminCode = '';
        await done(acc);
      } else if (identity === 'phrase') {
        const acc = await app.core.restore({ serverUrl, phrase: phrase.trim() });
        phrase = '';
        await done(acc);
      } else {
        await done(await app.core.addDevice(serverUrl, identity));
      }
    } catch (err) {
      error = familyError(err, mode === 'invite' && invite ? invite.serverUrl : serverUrl);
      app.log('warn', 'join', 'adding a family failed', err);
    } finally {
      busy = false;
    }
  }

  const needsName = $derived(mode !== 'member');
  const ready = $derived(
    (mode === 'invite' ? !!invited : serverUrl.trim().length > 0) &&
      (!needsName || name.trim().length > 0) &&
      (mode !== 'admin' || (adminCode.trim().length > 0 && familyName.trim().length > 0)) &&
      (mode !== 'member' || identity !== 'phrase' || phrase.trim().split(/\s+/).length === 24),
  );
</script>

<Page title={t.addFamily.title} onback={() => nav.back()} narrow>
  <div class="stack">
    <p>{t.addFamily.lead}</p>
    <fieldset class="modes">
      <legend class="visually-hidden">{t.addFamily.title}</legend>
      {#each [{ id: 'invite', label: t.addFamily.byInvite }, { id: 'member', label: t.addFamily.byPhrase }, { id: 'admin', label: t.addFamily.byAdmin }] as m (m.id)}
        <label class="choice">
          <input type="radio" name="add-mode" checked={mode === m.id} onchange={() => setMode(m.id as Mode)} />
          <span>{m.label}</span>
        </label>
      {/each}
    </fieldset>

    {#if mode === 'invite' && !invited}
      <form class="stack" onsubmit={check} novalidate>
        <div class="field">
          <label for="add-link">{t.addFamily.inviteLabel}</label>
          <textarea id="add-link" class="input mono" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="add-link-hint" bind:value={link}></textarea>
          <span id="add-link-hint" class="hint">{t.addFamily.inviteHint}</span>
        </div>
        {#if error}<p class="error-text" role="alert" data-testid="add-family-error">{error}</p>{/if}
        <button class="btn block" type="submit" disabled={busy || link.trim().length === 0}>{busy ? t.addFamily.checking : t.addFamily.check}</button>
      </form>
    {:else}
      <form class="stack" onsubmit={submit} novalidate>
        {#if mode === 'invite' && invited}
          <p class="notice" role="status" data-testid="add-invited">{t.addFamily.invited(invited.family, invited.by)}</p>
        {:else}
          <div class="field">
            <label for="add-server">{mode === 'admin' ? t.addFamily.adminServerLabel : t.addFamily.serverLabel}</label>
            <input id="add-server" class="input" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" aria-describedby="add-server-hint" bind:value={serverUrl} />
            <span id="add-server-hint" class="hint">{mode === 'admin' ? t.addFamily.adminServerHint : t.addFamily.serverHint}</span>
          </div>
        {/if}
        {#if mode === 'admin'}
          <div class="field">
            <label for="add-code">{t.addFamily.adminCodeLabel}</label>
            <input id="add-code" class="input mono" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" bind:value={adminCode} />
          </div>
          <div class="field">
            <label for="add-family-name">{t.addFamily.familyNameLabel}</label>
            <input id="add-family-name" class="input" type="text" maxlength="100" autocomplete="off" aria-describedby="add-family-name-hint" bind:value={familyName} />
            <span id="add-family-name-hint" class="hint">{t.admin.familyNameHint}</span>
          </div>
        {/if}

        <fieldset class="identity">
          <legend>{t.addFamily.identity}</legend>
          {#each identities as a (a.userId)}
            <label class="choice">
              <input type="radio" name="add-identity" value={a.userId} bind:group={identity} />
              <span>{t.addFamily.identitySame(a.familyName)}<span class="hint">{t.addFamily.identitySameHint}</span></span>
            </label>
          {/each}
          {#if mode === 'member'}
            <label class="choice">
              <input type="radio" name="add-identity" value="phrase" bind:group={identity} />
              <span>{t.addFamily.phraseLabel}<span class="hint">{t.addFamily.phraseHint}</span></span>
            </label>
          {:else}
            <label class="choice">
              <input type="radio" name="add-identity" value="new" bind:group={identity} />
              <span>{t.addFamily.identityNew}<span class="hint">{t.addFamily.identityNewHint}</span></span>
            </label>
          {/if}
        </fieldset>

        {#if mode === 'member' && identity === 'phrase'}
          <div class="field">
            <label for="add-phrase">{t.addFamily.phraseLabel}</label>
            <textarea id="add-phrase" class="input mono" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={phrase}></textarea>
          </div>
        {/if}
        {#if needsName}
          <div class="field">
            <label for="add-name">{t.addFamily.nameLabel}</label>
            <input id="add-name" class="input" type="text" maxlength="64" autocomplete="given-name" bind:value={name} />
          </div>
          <GenderPicker id="add" bind:value={gender} />
        {/if}
        {#if identity === 'new'}<p class="muted small">{t.addFamily.newPhraseNote}</p>{/if}
        {#if error}<p class="error-text" role="alert" data-testid="add-family-error">{error}</p>{/if}
        <button class="btn block" type="submit" disabled={busy || !ready} data-testid="add-family-submit">{busy ? t.addFamily.adding : t.addFamily.submit}</button>
      </form>
    {/if}
  </div>
</Page>

<style>
  .modes,
  .identity {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .identity legend {
    margin-bottom: var(--sp-2);
    font-weight: 600;
  }

  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    min-height: var(--touch);
    padding: var(--sp-2) 0;
    cursor: pointer;
  }

  .choice input {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    margin-top: 1px;
    accent-color: var(--accent);
  }

  .choice span {
    display: flex;
    flex-direction: column;
  }
</style>
