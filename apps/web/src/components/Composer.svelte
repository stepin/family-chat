<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { t } from '../lib/strings.ts';

  // The message field: pinned to the keyboard (the app follows the visual
  // viewport), safe-area insets, drafts saved as you type, Enter sends and
  // Shift+Enter breaks the line on devices with a real keyboard.
  let {
    accountId,
    chatId,
    autofocus = false,
    onsend,
    onfiles,
  }: {
    accountId: string;
    chatId: string;
    autofocus?: boolean;
    onsend: (text: string) => Promise<boolean>;
    /** Files picked, pasted or taken with the camera; the current text goes along as the caption. */
    onfiles?: ((files: File[], text: string) => void) | undefined;
  } = $props();

  const MAX_BYTES = 16 * 1024;
  let text = $state('');
  let field: HTMLTextAreaElement | undefined = $state();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sends go out one after another, in the order they were typed (a quick second Enter is not lost). */
  let chain: Promise<void> = Promise.resolve();
  // Phones and tablets: Enter inserts a new line, the button sends.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const tooLong = $derived(new TextEncoder().encode(text).length > MAX_BYTES);
  let menuOpen = $state(false);
  let attachBtn: HTMLButtonElement | undefined = $state();
  let photoInput: HTMLInputElement | undefined = $state();
  let cameraInput: HTMLInputElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  /** Clears the text and the draft (after the text went out as a caption). */
  export function clear(): void {
    text = '';
    clearTimeout(saveTimer);
    saveDraft();
    queueMicrotask(resize);
  }

  function pick(input: HTMLInputElement | undefined): void {
    menuOpen = false;
    input?.click();
  }

  function onPicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length > 0) onfiles?.(files, text);
  }

  /** Pasted pictures and files (desktop): the clipboard's files go to the preview. */
  function onPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0 || !onfiles) return;
    e.preventDefault();
    onfiles(files, text);
  }

  function onMenuKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      menuOpen = false;
      attachBtn?.focus();
    }
  }

  function saveDraft(): void {
    clearTimeout(saveTimer);
    void app.core.setDraft(accountId, chatId, text).catch(() => undefined);
  }

  function onInput(): void {
    resize();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 400);
  }

  function resize(): void {
    if (!field) return;
    field.style.setProperty('height', 'auto');
    field.style.setProperty('height', `${Math.min(field.scrollHeight, 160)}px`);
  }

  function send(): Promise<void> {
    const value = text.trim();
    if (value.length === 0 || tooLong) return chain;
    clearTimeout(saveTimer);
    const before = text;
    text = '';
    queueMicrotask(resize);
    field?.focus();
    chain = chain.then(async () => {
      const ok = await onsend(value).catch(() => false);
      // On failure the text comes back, unless something new was typed meanwhile.
      if (!ok && text === '') {
        text = before;
        queueMicrotask(resize);
      }
    });
    return chain;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  onMount(() => {
    void app.core.getDraft(accountId, chatId).then((d) => {
      if (d && text === '') {
        text = d;
        queueMicrotask(resize);
      }
    });
    if (autofocus || !coarse) field?.focus();
    const flush = () => {
      if (saveTimer !== undefined) saveDraft();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  });
</script>

{#if menuOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="attach-menu" role="group" aria-label={t.attach.menu} onkeydown={onMenuKey}>
    <button class="btn secondary small" type="button" onclick={() => pick(photoInput)}><Icon name="image" />{t.attach.photo}</button>
    {#if coarse}
      <button class="btn secondary small" type="button" onclick={() => pick(cameraInput)}><Icon name="camera" />{t.attach.camera}</button>
    {/if}
    <button class="btn secondary small" type="button" onclick={() => pick(fileInput)}><Icon name="file" />{t.attach.file}</button>
  </div>
{/if}
<input bind:this={photoInput} class="visually-hidden" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" onchange={onPicked} data-testid="photo-input" />
<input bind:this={cameraInput} class="visually-hidden" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" onchange={onPicked} />
<input bind:this={fileInput} class="visually-hidden" type="file" multiple tabindex="-1" aria-hidden="true" onchange={onPicked} data-testid="file-input" />
<div class="composer">
  {#if onfiles}
    <button
      bind:this={attachBtn}
      class="attach"
      type="button"
      aria-label={t.attach.button}
      aria-expanded={menuOpen}
      onclick={() => (menuOpen = !menuOpen)}
    >
      <Icon name="clip" />
    </button>
  {/if}
  <label for="composer-{chatId}" class="visually-hidden">{t.chat.composerLabel}</label>
  <textarea
    id="composer-{chatId}"
    bind:this={field}
    bind:value={text}
    class="field"
    rows="1"
    placeholder={t.chat.composerPlaceholder}
    enterkeyhint={coarse ? 'enter' : 'send'}
    aria-describedby={coarse ? undefined : `composer-hint-${chatId}`}
    aria-invalid={tooLong ? 'true' : undefined}
    oninput={onInput}
    onkeydown={onKeydown}
    onpaste={onPaste}
    onblur={saveDraft}
  ></textarea>
  {#if !coarse}<span id="composer-hint-{chatId}" class="visually-hidden">{t.chat.sendHintDesktop}</span>{/if}
  <button
    class="send"
    type="button"
    aria-label={t.chat.send}
    disabled={text.trim().length === 0 || tooLong}
    onclick={send}
  >
    <Icon name="send" />
  </button>
</div>
{#if tooLong}<p class="too-long error-text" role="alert">{t.chat.tooLong}</p>{/if}

<style>
  .composer {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    padding-left: max(var(--sp-3), env(safe-area-inset-left));
    padding-right: max(var(--sp-3), env(safe-area-inset-right));
    padding-bottom: max(var(--sp-2), env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  .field {
    flex: 1 1 auto;
    min-height: var(--touch);
    max-height: 160px;
    padding: 10px var(--sp-3);
    border: 1px solid var(--line);
    border-radius: 22px;
    background: var(--bg);
    font-size: var(--text-m);
    line-height: 1.35;
    resize: none;
  }

  .field:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 0;
    border-color: transparent;
  }

  .attach {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: var(--touch);
    height: var(--touch);
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }

  .attach:hover,
  .attach[aria-expanded='true'] {
    background: var(--surface-2);
    color: var(--text);
  }

  .attach-menu {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  .send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: var(--touch);
    height: var(--touch);
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }

  .send:disabled {
    background: var(--surface-2);
    color: var(--muted);
    cursor: default;
  }

  .too-long {
    padding: 0 var(--sp-4) var(--sp-2);
    background: var(--surface);
    font-size: var(--text-s);
  }
</style>
