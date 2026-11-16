<script lang="ts">
  import type { MessageView, ReactionView } from '@family-chat/core';
  import AttachmentItem from './AttachmentItem.svelte';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import LocationCard from './LocationCard.svelte';
  import { formatTime } from '../lib/format.ts';
  import { lazy } from '../lib/lazy.ts';
  import { linkify } from '../lib/linkify.ts';
  import { isSingleEmoji } from '../lib/single-emoji.ts';
  import { sendStatus } from '../lib/status.ts';
  import { t } from '../lib/strings.ts';

  // One message. The text is plain text: rendered as text nodes, links only
  // for http, https, mailto and tel (lib/linkify.ts). Never {@html}. In
  // groups others' messages carry the author's name and avatar on the first
  // message of a run. M4: the quoted original of a reply, "Переслано",
  // "изменено", the quiet line of a deleted message, reaction chips, and the
  // message menu (long press, right click, the "⋯" button).
  let {
    message,
    continued = false,
    fresh = false,
    author = null,
    now = Date.now(),
    onretry,
    oncancel,
    onopen,
    nameOf = () => '',
    onmenu,
    onreact,
    onquote,
    onwho,
    highlight = false,
  }: {
    message: MessageView;
    continued?: boolean;
    /** Arrived while the chat was open: the one intended animation. */
    fresh?: boolean;
    /** Group chats, others' messages: who wrote it. */
    author?: { readonly userId: string; readonly name: string; readonly hasAvatar: boolean } | null;
    now?: number;
    onretry: (m: MessageView) => void;
    oncancel: (m: MessageView) => void;
    onopen?: ((blobId: string) => void) | undefined;
    /** Display name of a user (quotes and reaction lists). */
    nameOf?: (userId: string) => string;
    /** Opens the message menu; `anchor` is where it was opened. */
    onmenu?: ((m: MessageView, anchor: DOMRect) => void) | undefined;
    /** A tap on a reaction chip: toggle my reaction. */
    onreact?: ((m: MessageView, emoji: string, on: boolean) => void) | undefined;
    /** A tap on the quote: jump to the original. */
    onquote?: ((m: MessageView) => void) | undefined;
    /** Long press or right click on a chip: who placed it. */
    onwho?: ((m: MessageView, r: ReactionView, anchor: DOMRect) => void) | undefined;
    /** Briefly marked (a search hit or the target of a quote). */
    highlight?: boolean;
  } = $props();

  // M5: stickers are drawn by their own chunk (WebP or the light Lottie player).
  const loadSticker = lazy(() => import('./StickerView.svelte'));

  const LONG_PRESS_MS = 480;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressStart: { x: number; y: number } | null = null;
  /** A long press just opened something: the click that follows is swallowed. */
  let swallowClick = false;
  let bubbleEl: HTMLElement | undefined = $state();

  const deleted = $derived(message.kind === 'deleted');
  const sticker = $derived(!deleted && message.kind === 'msg' ? (message.sticker ?? null) : null);
  const reactions = $derived(message.reactions ?? []);
  const quote = $derived(message.replyTo ?? null);
  // M8: a text that is one emoji is twice as large; without a quote or
  // "forwarded" it also loses the bubble background, like a sticker.
  const emojiOnly = $derived(
    !deleted &&
      message.kind === 'msg' &&
      sticker === null &&
      (message.attachments?.length ?? 0) === 0 &&
      !message.location &&
      isSingleEmoji(message.body),
  );
  const bare = $derived(emojiOnly && quote === null && !message.fwd);
  const quoteText = $derived.by(() => {
    if (!quote || !quote.available) return t.msg.unavailable;
    const body = quote.body.replace(/\s+/g, ' ').trim();
    if (body) return body.length > 120 ? `${body.slice(0, 120)}…` : body;
    if (quote.media === 'image') return t.msg.photo;
    if (quote.media === 'voice') return t.msg.voice;
    if (quote.media === 'location') return t.msg.place;
    if (quote.media === 'sticker') return t.msg.sticker;
    return quote.fileName ?? t.msg.file;
  });
  const menuEnabled = $derived(!!onmenu && message.kind !== 'service' && message.kind !== 'update-required' && message.status !== 'on-device');

  function openMenu(anchor?: DOMRect): void {
    if (!menuEnabled) return;
    onmenu?.(message, anchor ?? bubbleEl?.getBoundingClientRect() ?? new DOMRect());
  }

  function cancelPress(): void {
    clearTimeout(pressTimer);
    pressTimer = undefined;
    pressStart = null;
  }

  function longPress(e: PointerEvent, run: () => void): void {
    if (e.pointerType === 'mouse') return;
    cancelPress();
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 600);
      navigator.vibrate?.(10);
      run();
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: PointerEvent): void {
    if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  }

  function onClickCapture(e: MouseEvent): void {
    if (swallowClick) {
      e.preventDefault();
      e.stopPropagation();
      swallowClick = false;
    }
  }

  function onContextMenu(e: MouseEvent): void {
    // Links keep the browser's own menu (copy link); everything else opens ours.
    if ((e.target as HTMLElement | null)?.closest('a') || !menuEnabled) return;
    e.preventDefault();
    if (swallowClick) return; // the long press already opened it
    openMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
  }

  function chipLabel(r: ReactionView): string {
    return t.msg.chip(r.emoji, r.count, r.users.map(nameOf).join(', '), r.mine);
  }

  function onChipContext(e: MouseEvent, r: ReactionView): void {
    e.preventDefault();
    e.stopPropagation();
    if (swallowClick) return;
    onwho?.(message, r, (e.currentTarget as HTMLElement).getBoundingClientRect());
  }

  const segments = $derived(message.kind === 'msg' ? linkify(message.body) : []);
  const status = $derived(message.outgoing ? sendStatus(message.status) : null);
  const attachments = $derived(message.attachments ?? []);
  const uploadPercent = $derived(
    message.upload && message.status === 'on-device' && message.upload.total > 0
      ? Math.floor((message.upload.done / message.upload.total) * 100)
      : null,
  );
  const uploading = $derived(uploadPercent !== null && message.upload !== null && message.upload !== undefined && message.upload.done < message.upload.total);
</script>

<div
  class="msg"
  class:out={message.outgoing}
  class:continued
  class:fresh
  class:with-author={author !== null}
  class:failed={message.status === 'failed'}
  class:highlight
  data-status={message.status}
  data-kind={message.kind}
  data-msg-id={message.msgId}
  data-testid="message"
>
  {#if author && !continued}
    <span class="author-avatar"><Avatar accountId={message.accountId} userId={author.userId} name={author.name} hasAvatar={author.hasAvatar} size={32} /></span>
  {/if}
  <div class="col">
    {#if author && !continued}<span class="author" data-testid="message-author">{author.name}</span>{/if}
    <div class="row" class:out-row={message.outgoing}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bubble"
      class:deleted
      class:sticker-bubble={sticker !== null || bare}
      class:emoji-only={emojiOnly}
      bind:this={bubbleEl}
      oncontextmenu={onContextMenu}
      onpointerdown={(e) => longPress(e, () => openMenu())}
      onpointermove={onPointerMove}
      onpointerup={cancelPress}
      onpointercancel={cancelPress}
      onpointerleave={cancelPress}
      onclickcapture={onClickCapture}
    >
      {#if deleted}
        <p class="text deleted-text" data-testid="message-deleted">{t.msg.deleted}</p>
      {:else}
      {#if message.fwd}
        <p class="fwd" data-testid="message-forwarded"><Icon name="share" size={14} />{t.msg.forwarded}</p>
      {/if}
      {#if quote}
        <button
          class="quote"
          class:unavailable={!quote.available}
          type="button"
          data-testid="message-quote"
          disabled={!quote.available}
          onclick={() => onquote?.(message)}
        >
          {#if quote.available}<span class="visually-hidden">{t.msg.quoteHint}</span><span class="quote-author">{nameOf(quote.author)}</span>{/if}
          <span class="quote-text">{quoteText}</span>
        </button>
      {/if}
      {#if attachments.length > 0}
        <div class="attachments">
          {#each attachments as a (a.blobId)}
            <AttachmentItem accountId={message.accountId} attachment={a} sentAt={message.time} {now} {onopen} outgoing={message.outgoing} />
          {/each}
        </div>
      {/if}
      {#if message.location}
        <div class="attachments"><LocationCard place={message.location} /></div>
      {/if}
      {#if sticker}
        {#await loadSticker()}
          <span class="sticker-wait" aria-hidden="true">{message.body}</span>
        {:then { default: StickerView }}
          <StickerView accountId={message.accountId} pack={sticker.pack} file={sticker.file} type={sticker.type} emoji={message.body} w={sticker.w} h={sticker.h} />
        {:catch}
          <span class="sticker-wait" aria-hidden="true">{message.body}</span>
        {/await}
      {:else if message.kind === 'update-required'}
        <p class="text muted">{t.chat.updateRequired}</p>
      {:else if message.body.length > 0}
        <!-- prettier-ignore -->
        <p class="text" class:emoji-text={emojiOnly}>{#each segments as s, i (i)}{#if s.kind === 'link'}<a href={s.href} target="_blank" rel="noopener noreferrer nofollow">{s.text}</a>{:else}{s.text}{/if}{/each}</p>
      {/if}
      {/if}
      <span class="meta">
        {#if message.edited && !deleted}<span class="edited" title={t.msg.editedLabel}>{t.msg.edited}</span>{/if}
        {#if uploading}
          <span class="upload tabular" data-testid="upload-progress">{t.attach.uploading(uploadPercent ?? 0)}</span>
        {/if}
        {#if message.time !== null}<time class="tabular" datetime={new Date(message.time).toISOString()}>{formatTime(message.time)}</time>{/if}
        {#if status}
          <span class="status" title={status.hint}>
            <Icon name={status.icon} size={14} />
            <span class={message.status === 'on-server' ? 'visually-hidden' : 'status-text'}>{status.label}</span>
          </span>
        {/if}
      </span>
    </div>
    {#if menuEnabled}
      <button class="more" type="button" aria-label={t.msg.actions} aria-haspopup="menu" data-testid="message-more" onclick={(e) => openMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <Icon name="more" size={20} />
      </button>
    {/if}
    </div>
    {#if reactions.length > 0 && !deleted}
      <ul class="chips" aria-label={t.msg.reactions} data-testid="reactions">
        {#each reactions as r (r.emoji)}
          <li>
            <button
              class="chip"
              class:mine={r.mine}
              type="button"
              aria-pressed={r.mine}
              aria-label={chipLabel(r)}
              title={r.users.map(nameOf).join(', ')}
              data-testid="reaction-chip"
              data-emoji={r.emoji}
              disabled={!onreact}
              onclick={(e) => {
                if (swallowClick) {
                  e.preventDefault();
                  return;
                }
                onreact?.(message, r.emoji, !r.mine);
              }}
              oncontextmenu={(e) => onChipContext(e, r)}
              onpointerdown={(e) => {
                const el = e.currentTarget as HTMLElement;
                longPress(e, () => onwho?.(message, r, el.getBoundingClientRect()));
              }}
              onpointermove={onPointerMove}
              onpointerup={cancelPress}
              onpointercancel={cancelPress}
              onpointerleave={cancelPress}
              ><span aria-hidden="true">{r.emoji}</span><span class="count tabular" aria-hidden="true">{r.count}</span></button
            >
          </li>
        {/each}
      </ul>
    {/if}
    {#if message.outgoing && message.status === 'on-device' && message.error === 'storage_full'}
      <p class="server-full small" role="status" data-testid="server-full">{t.attach.serverFull}</p>
    {/if}
    {#if status && status.actions.length > 0 && message.status === 'failed'}
      <div class="actions">
        {#if status.actions.includes('retry')}
          <button class="btn small" type="button" onclick={() => onretry(message)}>{t.chat.retry}</button>
        {/if}
        {#if status.actions.includes('cancel')}
          <button class="btn secondary small" type="button" onclick={() => oncancel(message)}>{t.chat.cancelSend}</button>
        {/if}
      </div>
    {:else if message.status === 'on-device'}
      <div class="actions">
        <button class="link-btn small" type="button" onclick={() => oncancel(message)}>
          {uploading ? t.attach.cancelUpload : t.chat.cancelSend}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .msg {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
    padding: 0 var(--sp-3);
  }

  .msg.continued {
    margin-top: 2px;
  }

  .msg.with-author.continued {
    padding-left: calc(var(--sp-3) + 32px + var(--sp-2));
  }

  .msg.out {
    justify-content: flex-end;
  }

  .col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    max-width: min(36rem, 82%);
  }

  .out .col {
    align-items: flex-end;
  }

  /* nowrap: the global .row utility (styles/app.css) wraps, which put the "⋯"
     button on a line of its own under wide bubbles, an empty gap on phones. */
  .row {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--sp-1);
    max-width: 100%;
  }

  .row.out-row {
    flex-direction: row-reverse;
  }

  .more {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--touch);
    height: var(--touch);
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
  }

  .msg:hover .more,
  .msg:focus-within .more,
  .more:focus-visible {
    opacity: 1;
  }

  .more:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  @media (pointer: coarse) {
    /* Touch: the long press opens the menu; the button stays reachable for screen readers. */
    .more {
      width: 1px;
      height: var(--touch);
      margin-left: -1px;
      overflow: hidden;
    }
    .more:focus-visible {
      width: var(--touch);
      margin-left: 0;
    }
  }

  .highlight .bubble {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }

  .bubble.deleted {
    background: transparent;
    box-shadow: none;
    border: 1px dashed var(--line);
  }

  .deleted-text {
    color: var(--muted);
    font-style: italic;
    font-size: var(--text-s);
  }

  .fwd {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    margin-bottom: 2px;
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .out .fwd {
    color: var(--on-accent-soft-muted);
  }

  .quote {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    max-width: 100%;
    margin-bottom: var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
    border: 0;
    border-left: 3px solid var(--accent);
    border-radius: var(--r-s, 6px);
    background: var(--surface-2);
    color: inherit;
    text-align: left;
    font-size: var(--text-s);
    cursor: pointer;
  }

  .quote.unavailable {
    border-left-color: var(--line);
    cursor: default;
    color: var(--muted);
    font-style: italic;
  }

  .quote-author {
    font-weight: 700;
    font-size: var(--text-xs);
    color: var(--accent);
  }

  .out .quote-author {
    color: inherit;
  }

  .quote-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .edited {
    font-style: italic;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    margin: var(--sp-1) 0 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    min-width: var(--touch);
    padding: 2px var(--sp-2);
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--surface);
    color: var(--text);
    font-size: var(--text-s);
    cursor: pointer;
    touch-action: manipulation;
  }

  .chip {
    position: relative;
  }

  /* The visible chip is 32 px tall; the touch target is 44 px (docs/PLAN.md 8.7). */
  .chip::after {
    content: '';
    position: absolute;
    inset: -6px 0;
  }

  .chip.mine {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .chip .count {
    font-weight: 600;
  }

  .author-avatar {
    display: inline-flex;
    margin-top: 2px;
  }

  .author {
    padding: 0 var(--sp-2) 2px;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--accent);
  }

  .bubble {
    max-width: 100%;
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--bubble-radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .out .bubble {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  /* A sticker is its own bubble without a background (docs/PLAN.md 8). */
  .bubble.sticker-bubble,
  .out .bubble.sticker-bubble {
    padding: 0;
    background: transparent;
    box-shadow: none;
    color: var(--text);
  }

  .sticker-bubble .meta {
    width: fit-content;
    margin-left: auto;
    padding: 1px var(--sp-2);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
  }

  /* One emoji (M8): twice the message text size, following the text size setting. */
  .text.emoji-text {
    font-size: calc(2 * var(--text-m));
    line-height: 1.2;
  }

  .bubble.emoji-only {
    min-width: 44px;
    min-height: 44px;
  }

  .sticker-wait {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 160px;
    height: 160px;
    font-size: 2.5rem;
  }

  .failed .bubble {
    outline: 1px solid var(--error);
  }

  .attachments {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-bottom: var(--sp-1);
  }

  .text {
    font-size: var(--text-m);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .text a {
    color: inherit;
    text-decoration: underline;
  }

  .meta {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--sp-1);
    margin-top: 2px;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .out .meta {
    color: var(--on-accent-soft-muted);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .failed .status {
    color: var(--error);
    font-weight: 600;
  }

  .server-full {
    max-width: 36rem;
    margin-top: var(--sp-1);
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-m);
    background: var(--warn-soft);
    color: var(--text);
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }

  .fresh .bubble {
    animation: appear 180ms ease-out;
  }

  @keyframes appear {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .fresh .bubble {
      animation: none;
    }
  }
</style>
