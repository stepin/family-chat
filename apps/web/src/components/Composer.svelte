<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import type { VoiceRecording } from '../lib/recorder.ts';
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
    onvoice,
    onlocation,
    reply = null,
    oncancelreply,
    editing = null,
    onedit,
    oncanceledit,
    onemoji,
  }: {
    accountId: string;
    chatId: string;
    autofocus?: boolean;
    onsend: (text: string) => Promise<boolean>;
    /** Files picked, pasted or taken with the camera; the current text goes along as the caption. */
    onfiles?: ((files: File[], text: string) => void) | undefined;
    /** A finished voice recording; false when it could not be queued. */
    onvoice?: ((rec: VoiceRecording) => Promise<boolean>) | undefined;
    /** "Место" in the attachment menu. */
    onlocation?: (() => void) | undefined;
    /** Replying to a message: the quote bar above the field (M4). */
    reply?: { readonly name: string; readonly text: string } | null;
    oncancelreply?: (() => void) | undefined;
    /** Editing my message (M4): the field holds its text; sending saves the change. */
    editing?: { readonly key: string; readonly body: string; readonly allowEmpty: boolean } | null;
    onedit?: ((text: string) => Promise<boolean>) | undefined;
    oncanceledit?: (() => void) | undefined;
    /** The emoji button: opens the picker (the chosen emoji comes back through `pickEmoji`). */
    onemoji?: (() => void) | undefined;
  } = $props();
  /** The text typed before editing started; it comes back afterwards. */
  let stash: string | null = null;
  let editingKey: string | null = null;
  let caret: { start: number; end: number } | null = null;
  let recording = $state(false);

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
    caret = null;
    clearTimeout(saveTimer);
    saveDraft();
    queueMicrotask(resize);
  }

  /**
   * Inserts text at the caret, replacing a selection, and puts the focus
   * back into the field with the caret after it (the emoji picker, shared
   * text). The caret was remembered when the field lost the focus, which on
   * phones happens as soon as the emoji button is touched.
   */
  export function insert(value: string): void {
    const len = text.length;
    const start = Math.min(caret?.start ?? len, len);
    const end = Math.min(Math.max(caret?.end ?? len, start), len);
    text = text.slice(0, start) + value + text.slice(end);
    const pos = start + value.length;
    caret = { start: pos, end: pos };
    if (field) {
      field.value = text;
      field.focus({ preventScroll: true });
      field.setSelectionRange(pos, pos);
    }
    queueMicrotask(resize);
    if (!editing) onInput();
  }

  /**
   * An emoji from the picker, as in Telegram: into an empty field (not
   * editing) it goes out at once as a message of its own (as the reply, if
   * one is being written); otherwise it is inserted at the caret.
   */
  export function pickEmoji(emoji: string): void {
    if (!editing && text.trim().length === 0) {
      if (text !== '') {
        text = '';
        saveDraft();
      }
      caret = null;
      void sendText(emoji);
      if (!coarse) field?.focus({ preventScroll: true });
      return;
    }
    insert(emoji);
  }

  /** Puts the focus into the field (after choosing "Ответить"). */
  export function focus(): void {
    field?.focus();
  }

  function rememberCaret(): void {
    if (field) caret = { start: field.selectionStart ?? text.length, end: field.selectionEnd ?? text.length };
  }

  // Entering and leaving edit mode.
  $effect(() => {
    const e = editing;
    if (e && editingKey !== e.key) {
      if (editingKey === null) stash = text;
      editingKey = e.key;
      text = e.body;
      caret = null;
      queueMicrotask(() => {
        resize();
        field?.focus();
        field?.setSelectionRange(text.length, text.length);
      });
    } else if (!e && editingKey !== null) {
      editingKey = null;
      text = stash ?? '';
      stash = null;
      caret = null;
      queueMicrotask(resize);
    }
  });

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
    // While editing, the field holds the old message, not a draft.
    if (editingKey !== null) return;
    void app.core.setDraft(accountId, chatId, text).catch(() => undefined);
  }

  function onInput(): void {
    resize();
    rememberCaret();
    clearTimeout(saveTimer);
    if (editingKey === null) saveTimer = setTimeout(saveDraft, 400);
  }

  function resize(): void {
    if (!field) return;
    field.style.setProperty('height', 'auto');
    field.style.setProperty('height', `${Math.min(field.scrollHeight, 160)}px`);
  }

  function send(): Promise<void> {
    const value = text.trim();
    if (editing && onedit) {
      if ((value.length === 0 && !editing.allowEmpty) || tooLong) return chain;
      const edited = value;
      chain = chain.then(async () => {
        await onedit(edited).catch(() => false);
      });
      return chain;
    }
    if (value.length === 0 || tooLong) return chain;
    clearTimeout(saveTimer);
    const before = text;
    text = '';
    caret = null;
    queueMicrotask(resize);
    field?.focus();
    return sendText(value, before);
  }

  /** Queues `value` after earlier sends; on failure `before` comes back into the empty field. */
  function sendText(value: string, before = ''): Promise<void> {
    chain = chain.then(async () => {
      const ok = await onsend(value).catch(() => false);
      // On failure the text comes back, unless something new was typed meanwhile.
      if (!ok && text === '' && before !== '') {
        text = before;
        queueMicrotask(resize);
      }
    });
    return chain;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && (editing || reply)) {
      // Leaves edit mode or the reply first (and does not close the chat).
      e.preventDefault();
      e.stopPropagation();
      if (editing) oncanceledit?.();
      else oncancelreply?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  onMount(() => {
    void app.core.getDraft(accountId, chatId).then((d) => {
      if (d && text === '') {
        text = d;
        caret = null;
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
    {#if onlocation}
      <button
        class="btn secondary small"
        type="button"
        onclick={() => {
          menuOpen = false;
          onlocation?.();
        }}><Icon name="pin" />{t.location.button}</button
      >
    {/if}
  </div>
{/if}
<input bind:this={photoInput} class="visually-hidden" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" onchange={onPicked} data-testid="photo-input" />
<input bind:this={cameraInput} class="visually-hidden" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" onchange={onPicked} />
<input bind:this={fileInput} class="visually-hidden" type="file" multiple tabindex="-1" aria-hidden="true" onchange={onPicked} data-testid="file-input" />
{#if editing}
  <div class="bar" role="status" data-testid="edit-bar">
    <span class="bar-icon"><Icon name="edit" size={18} /></span>
    <span class="bar-text"><strong>{t.msg.editBar}</strong></span>
    <button class="icon-btn" type="button" aria-label={t.msg.cancelEdit} onclick={() => oncanceledit?.()}><Icon name="close" size={20} /></button>
  </div>
{:else if reply}
  <div class="bar" data-testid="reply-bar">
    <span class="bar-icon"><Icon name="reply" size={18} /></span>
    <span class="bar-text"><strong>{t.msg.replyBar(reply.name)}</strong><span class="bar-quote">{reply.text}</span></span>
    <button class="icon-btn" type="button" aria-label={t.msg.cancelReply} onclick={() => oncancelreply?.()}><Icon name="close" size={20} /></button>
  </div>
{/if}
<div class="composer">
  {#if onfiles && !editing}
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
    onkeyup={rememberCaret}
    onclick={rememberCaret}
    onselect={rememberCaret}
    onpaste={onPaste}
    onblur={() => {
      rememberCaret();
      saveDraft();
    }}
  ></textarea>
  {#if onemoji}
    <button class="emoji-btn" type="button" aria-label={t.emoji.button} aria-haspopup="dialog" onclick={() => onemoji?.()} data-testid="emoji-button">
      <Icon name="smile" />
    </button>
  {/if}
  {#if !coarse}<span id="composer-hint-{chatId}" class="visually-hidden">{t.chat.sendHintDesktop}</span>{/if}
  {#if editing}
    <button
      class="send"
      type="button"
      aria-label={t.msg.saveEdit}
      disabled={(text.trim().length === 0 && !editing.allowEmpty) || tooLong}
      onclick={send}
      data-testid="save-edit"
    >
      <Icon name="check" />
    </button>
  {:else if onvoice && (text.trim().length === 0 || recording)}
    <VoiceRecorder onrecorded={onvoice} onactive={(a) => (recording = a)} />
  {:else}
    <button
      class="send"
      type="button"
      aria-label={t.chat.send}
      disabled={text.trim().length === 0 || tooLong}
      onclick={send}
    >
      <Icon name="send" />
    </button>
  {/if}
</div>
{#if tooLong}<p class="too-long error-text" role="alert">{t.chat.tooLong}</p>{/if}

<style>
  .composer {
    position: relative;
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

  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-4);
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  .bar-icon {
    display: inline-flex;
    color: var(--accent);
  }

  .bar-text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    padding-left: var(--sp-2);
    border-left: 3px solid var(--accent);
    font-size: var(--text-s);
  }

  .bar-quote {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }

  .emoji-btn {
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

  .emoji-btn:hover {
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
