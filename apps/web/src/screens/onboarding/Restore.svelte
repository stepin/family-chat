<script lang="ts">
  import { isCoreError, type AccountView } from '@family-chat/core';
  import Page from '../../components/Page.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { errorText } from '../../lib/errors.ts';
  import { pageServerUrl, parseInviteInput, type ParsedInvite } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { countWords, normalizePhrase } from '../../lib/phrase.ts';
  import { t } from '../../lib/strings.ts';

  // Restore route (docs/PLAN.md 8.1): invitation link or server address →
  // the 24 words in one field → "Доступ восстановлен".
  let step = $state<'where' | 'phrase' | 'name' | 'done'>('where');
  let where = $state(app.invite ? `${app.invite.serverUrl}/#invite=${app.invite.code}` : pageServerUrl(location));
  let phrase = $state('');
  let name = $state('');
  let family = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let invite = $state<ParsedInvite | null>(null);
  let serverUrl = $state('');
  let account = $state<AccountView | null>(null);
  const words = $derived(countWords(phrase));

  async function checkWhere(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      invite = parseInviteInput(where, pageServerUrl(location)) ?? null;
      serverUrl = invite ? invite.serverUrl : where.trim();
      family = (await app.core.serverInfo(serverUrl)).familyName;
      step = 'phrase';
    } catch (err) {
      error = errorText(err);
      app.log('warn', 'restore', 'server check failed', err);
    } finally {
      busy = false;
    }
  }

  async function restore(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      account = await app.core.restore({ serverUrl, phrase: normalizePhrase(phrase) });
      phrase = '';
      await app.setFlag('phraseConfirmed', true);
      void navigator.storage?.persist?.().catch(() => false);
      step = 'done';
    } catch (err) {
      if (isCoreError(err, 'unknown-user')) {
        if (invite) step = 'name';
        else error = t.restore.notMember(family);
      } else if (isCoreError(err, 'account-exists')) {
        error = t.restore.already;
      } else error = errorText(err);
      app.log('warn', 'restore', 'restore by phrase failed', err);
    } finally {
      busy = false;
    }
  }

  async function joinWithPhrase(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!invite) return;
    error = null;
    busy = true;
    try {
      account = await app.core.join({
        serverUrl,
        code: { invite: invite.code },
        name: name.trim(),
        phrase: normalizePhrase(phrase),
      });
      phrase = '';
      app.invite = null;
      await app.setFlag('phraseConfirmed', true);
      step = 'done';
    } catch (err) {
      error = errorText(err);
      app.log('warn', 'restore', 'joining with a restored identity failed', err);
    } finally {
      busy = false;
    }
  }

  const back = $derived(
    step === 'where' ? () => nav.back() : step === 'phrase' ? () => (step = 'where') : step === 'name' ? () => (step = 'phrase') : undefined,
  );
</script>

<Page title={step === 'done' ? t.restore.doneTitle : t.restore.title} onback={back} narrow>
  {#if step === 'where'}
    <form class="stack" onsubmit={checkWhere} novalidate>
      <div class="field">
        <label for="restore-where">{t.restore.whereLabel}</label>
        <span id="restore-where-hint" class="hint">{t.restore.whereLead}</span>
        <input
          id="restore-where"
          class="input"
          type="text"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-describedby="restore-where-hint"
          bind:value={where}
        />
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || where.trim() === ''}>{t.common.next}</button>
    </form>
  {:else if step === 'phrase'}
    <form class="stack" onsubmit={restore} novalidate>
      <div class="field">
        <label for="restore-phrase">{t.restore.phraseLabel}</label>
        <span id="restore-phrase-hint" class="hint">{t.restore.phraseLead}</span>
        <textarea
          id="restore-phrase"
          class="input mono"
          rows="5"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-describedby="restore-phrase-hint restore-phrase-count"
          bind:value={phrase}
        ></textarea>
        <span id="restore-phrase-count" class="hint tabular" aria-live="polite">{t.restore.wordsCount(words)}</span>
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || words !== 24}>
        {busy ? t.restore.restoring : t.restore.submit}
      </button>
    </form>
  {:else if step === 'name'}
    <form class="stack" onsubmit={joinWithPhrase} novalidate>
      <p>{t.restore.needName}</p>
      <div class="field">
        <label for="restore-name">{t.join.nameLabel}</label>
        <input id="restore-name" class="input" type="text" maxlength="64" autocomplete="given-name" bind:value={name} />
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn block" type="submit" disabled={busy || name.trim() === ''}>{t.join.submit}</button>
    </form>
  {:else}
    <div class="stack">
      <p>{t.restore.doneText(account?.retentionDays ?? 90)}</p>
      <button class="btn block" type="button" onclick={() => nav.reset({ name: 'list' })}>{t.join.toChats}</button>
    </div>
  {/if}
</Page>
