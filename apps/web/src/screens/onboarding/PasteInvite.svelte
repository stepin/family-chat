<script lang="ts">
  import Page from '../../components/Page.svelte';
  import { app } from '../../lib/app.svelte.ts';
  import { readClipboard } from '../../lib/clipboard.ts';
  import { pageServerUrl, parseInviteInput } from '../../lib/invite.ts';
  import { nav } from '../../lib/nav.svelte.ts';
  import { t } from '../../lib/strings.ts';

  let { installed = false, setup = true }: { installed?: boolean; setup?: boolean } = $props();

  let text = $state('');
  let error = $state<string | null>(null);

  function accept(value: string): boolean {
    const parsed = parseInviteInput(value, pageServerUrl(location));
    if (!parsed) return false;
    app.invite = parsed;
    text = '';
    nav.push({ name: 'join' });
    return true;
  }

  async function paste(): Promise<void> {
    error = null;
    const clip = await readClipboard();
    if (clip === null || !accept(clip)) error = clip === null ? t.pasteInvite.clipboardEmpty : t.pasteInvite.invalid;
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    error = null;
    if (!accept(text)) error = t.pasteInvite.invalid;
  }
</script>

<Page
  title={installed ? t.welcome.installedTitle : t.pasteInvite.title}
  onback={installed ? undefined : () => nav.back()}
  narrow
>
  <div class="stack">
    <p>{installed ? t.welcome.installedLead : t.pasteInvite.lead}</p>
    <button class="btn block" type="button" onclick={paste}>{t.pasteInvite.pasteButton}</button>
    <form class="stack" onsubmit={submit} novalidate>
      <div class="field">
        <label for="invite-text">{t.pasteInvite.fieldLabel}</label>
        <textarea
          id="invite-text"
          class="input mono"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-describedby="invite-hint"
          bind:value={text}
        ></textarea>
        <span id="invite-hint" class="hint">{t.pasteInvite.fieldHint}</span>
      </div>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn secondary block" type="submit" disabled={text.trim().length === 0}>{t.pasteInvite.continue}</button>
    </form>
    {#if installed}
      <div class="others">
        {#if setup}<button class="link-btn" type="button" onclick={() => nav.push({ name: 'admin' })}>{t.welcome.setup}</button>{/if}
        <button class="link-btn" type="button" onclick={() => nav.push({ name: 'restore' })}>{t.welcome.restore}</button>
      </div>
    {/if}
  </div>
</Page>

<style>
  .others {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: var(--sp-4);
  }
</style>
