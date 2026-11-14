<script lang="ts">
  import type { MessageView } from '@family-chat/core';
  import Icon from './Icon.svelte';
  import { formatTime } from '../lib/format.ts';
  import { linkify } from '../lib/linkify.ts';
  import { sendStatus } from '../lib/status.ts';
  import { t } from '../lib/strings.ts';

  // One message. The text is plain text: rendered as text nodes, links only
  // for http, https, mailto and tel (lib/linkify.ts). Never {@html}.
  let {
    message,
    continued = false,
    fresh = false,
    onretry,
    oncancel,
  }: {
    message: MessageView;
    continued?: boolean;
    /** Arrived while the chat was open: the one intended animation. */
    fresh?: boolean;
    onretry: (m: MessageView) => void;
    oncancel: (m: MessageView) => void;
  } = $props();

  const segments = $derived(message.kind === 'msg' ? linkify(message.body) : []);
  const status = $derived(message.outgoing ? sendStatus(message.status) : null);
</script>

<div
  class="msg"
  class:out={message.outgoing}
  class:continued
  class:fresh
  class:failed={message.status === 'failed'}
  data-status={message.status}
  data-testid="message"
>
  <div class="bubble">
    {#if message.kind === 'update-required'}
      <p class="text muted">{t.chat.updateRequired}</p>
    {:else}
      <!-- prettier-ignore -->
      <p class="text">{#each segments as s, i (i)}{#if s.kind === 'link'}<a href={s.href} target="_blank" rel="noopener noreferrer nofollow">{s.text}</a>{:else}{s.text}{/if}{/each}</p>
    {/if}
    <span class="meta">
      {#if message.time !== null}<time class="tabular" datetime={new Date(message.time).toISOString()}>{formatTime(message.time)}</time>{/if}
      {#if status}
        <span class="status" title={status.hint}>
          <Icon name={status.icon} size={14} />
          <span class={message.status === 'on-server' ? 'visually-hidden' : 'status-text'}>{status.label}</span>
        </span>
      {/if}
    </span>
  </div>
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
      <button class="link-btn small" type="button" onclick={() => oncancel(message)}>{t.chat.cancelSend}</button>
    </div>
  {/if}
</div>

<style>
  .msg {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-top: var(--sp-2);
    padding: 0 var(--sp-3);
  }

  .msg.continued {
    margin-top: 2px;
  }

  .msg.out {
    align-items: flex-end;
  }

  .bubble {
    max-width: min(36rem, 82%);
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-l);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .out .bubble {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .failed .bubble {
    outline: 1px solid var(--error);
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
