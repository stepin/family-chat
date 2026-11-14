<script lang="ts">
  import Page from '../../components/Page.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { errorText } from '../../lib/errors.ts';
  import { pageServerUrl, parseInviteInput } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { countWords, normalizePhrase } from '../../lib/phrase.ts';
  import { t } from '../../lib/strings.ts';

  // Revoking an identity with only the recovery phrase (lost phone), from the
  // restore route. The phrase is used once and never stored.
  let where = $state(pageServerUrl(location));
  let phrase = $state('');
  let understood = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let done = $state(false);
  const words = $derived(countWords(phrase));

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy || words !== 24 || !understood) return;
    busy = true;
    error = null;
    try {
      const serverUrl = parseInviteInput(where, pageServerUrl(location))?.serverUrl ?? where.trim();
      await app.core.revokeIdentityByPhrase(serverUrl, normalizePhrase(phrase));
      phrase = '';
      done = true;
    } catch (err) {
      error = errorText(err);
      app.log('warn', 'security', 'revoking by phrase failed', err);
    } finally {
      busy = false;
    }
  }
</script>

<Page title={t.security.byPhraseTitle} onback={() => nav.back()} narrow>
  {#if done}
    <div class="stack">
      <p class="notice" role="status">{t.security.byPhraseDone}</p>
      <button class="btn block" type="button" onclick={() => nav.back()}>{t.common.back}</button>
    </div>
  {:else}
    <form class="stack" onsubmit={submit} novalidate>
      <p>{t.security.byPhraseLead}</p>
      <div class="field">
        <label for="revoke-where">{t.restore.whereLabel}</label>
        <input
          id="revoke-where"
          class="input"
          type="text"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          bind:value={where}
        />
      </div>
      <div class="field">
        <label for="revoke-phrase">{t.restore.phraseLabel}</label>
        <textarea
          id="revoke-phrase"
          class="input mono"
          rows="5"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-describedby="revoke-phrase-count"
          bind:value={phrase}
        ></textarea>
        <span id="revoke-phrase-count" class="hint tabular" aria-live="polite">{t.restore.wordsCount(words)}</span>
      </div>
      <ul class="points">
        {#each t.security.confirmPoints as p, i (i)}<li>{p}</li>{/each}
      </ul>
      <label class="check">
        <input type="checkbox" bind:checked={understood} />
        <span>{t.security.confirmCheck}</span>
      </label>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn danger block" type="submit" disabled={busy || words !== 24 || !understood || where.trim() === ''}>
        {busy ? t.security.revoking : t.security.confirmButton}
      </button>
    </form>
  {/if}
</Page>

<style>
  .points {
    margin: 0;
    padding-left: var(--sp-5);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--touch);
    font-weight: 600;
    cursor: pointer;
  }

  .check input {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }
</style>
