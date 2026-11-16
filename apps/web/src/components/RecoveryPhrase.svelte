<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../lib/app.svelte.ts';
  import { pickPositions } from '../lib/phrase.ts';
  import { t } from '../lib/strings.ts';

  // Shows the 24 words, then asks for three random ones. The phrase lives only in this component's memory.
  let {
    userId,
    ondone,
    onskip,
  }: { userId: string; ondone: () => void; onskip?: (() => void) | undefined } = $props();

  let words = $state<string[]>([]);
  let step = $state<'show' | 'confirm' | 'done'>('show');
  let positions = $state<number[]>([]);
  let answers = $state<string[]>(['', '', '']);
  let wrong = $state(false);
  let failed = $state(false);

  onMount(() => {
    app.core
      .recoveryPhrase(userId)
      .then((p) => (words = p.split(' ')))
      .catch((e: unknown) => {
        failed = true;
        app.log('error', 'phrase', 'recovery phrase not available', e);
      });
    return () => {
      words = [];
      answers = ['', '', ''];
    };
  });

  function toConfirm(): void {
    positions = pickPositions(words.length, 3);
    answers = ['', '', ''];
    wrong = false;
    step = 'confirm';
  }

  async function confirm(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const ok = positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === words[p]);
    if (!ok) {
      wrong = true;
      return;
    }
    await app.setFlag('phraseConfirmed', true);
    step = 'done';
    words = [];
  }
</script>

{#if failed}
  <p class="notice error" role="alert">{t.errors.generic}</p>
{:else if step === 'show'}
  <div class="stack">
    <p>{t.phrase.lead}</p>
    <p class="notice warn">{t.phrase.why}</p>
    <ol class="words mono" aria-label={t.phrase.title}>
      {#each words as word, i (i)}
        <li><span class="n" aria-hidden="true">{i + 1}</span> <span class="w">{word}</span></li>
      {/each}
    </ol>
    <p class="muted small">{t.phrase.secret} {t.phrase.englishNote}</p>
    <button class="btn block" type="button" disabled={words.length === 0} onclick={toConfirm}>{t.phrase.written(app.myGender)}</button>
    {#if onskip}
      <button class="link-btn" type="button" onclick={onskip}>{t.common.later}</button>
    {/if}
  </div>
{:else if step === 'confirm'}
  <form class="stack" onsubmit={confirm} novalidate>
    <h2>{t.phrase.confirmTitle}</h2>
    <p>{t.phrase.confirmLead}</p>
    {#each positions as p, i (p)}
      <div class="field">
        <label for="phrase-word-{p}">{t.phrase.wordLabel(p + 1)}</label>
        <input
          id="phrase-word-{p}"
          class="input mono"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          bind:value={answers[i]}
        />
      </div>
    {/each}
    {#if wrong}<p class="error-text" role="alert">{t.phrase.confirmWrong}</p>{/if}
    <button class="btn block" type="submit">{t.phrase.confirm}</button>
    <button class="link-btn" type="button" onclick={() => (step = 'show')}>{t.phrase.showAgain}</button>
  </form>
{:else}
  <div class="stack">
    <p class="notice" role="status">{t.phrase.confirmed}</p>
    <button class="btn block" type="button" onclick={ondone}>{t.common.next}</button>
  </div>
{/if}

<style>
  .words {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-3);
    list-style: none;
    border-radius: var(--r-m);
    background: var(--surface-2);
    font-size: var(--text-m);
  }

  .words li {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
  }

  .n {
    min-width: 1.6em;
    text-align: right;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .w {
    font-weight: 600;
  }

  .link-btn {
    align-self: center;
  }
</style>
