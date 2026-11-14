<script lang="ts">
  import type { AttachmentView } from '@family-chat/core';
  import Icon from './Icon.svelte';
  import VoicePlayer from './VoicePlayer.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { attachmentUi, isDisplayableImage, thumbDataUrl } from '../lib/attachment-state.ts';
  import { formatBytes } from '../lib/format.ts';
  import { saveBlob } from '../lib/storage.ts';
  import { t } from '../lib/strings.ts';

  // One attachment in a message (docs/PLAN.md 8.4, 8.6). Images: the inline
  // thumbnail first (with the final dimensions, so the feed does not jump),
  // then the downloaded picture through <img> and a blob: URL. Everything
  // else: a card with name, size and a download button; files are never
  // opened as documents of the app's origin, only saved.
  let {
    accountId,
    attachment,
    sentAt,
    now,
    onopen,
    outgoing = false,
  }: {
    accountId: string;
    attachment: AttachmentView;
    outgoing?: boolean;
    sentAt: number | null;
    now: number;
    onopen?: ((blobId: string) => void) | undefined;
  } = $props();

  const image = $derived(isDisplayableImage(attachment));
  const ui = $derived(attachmentUi(attachment, { sentAt, retentionDays: app.account?.retentionDays ?? 90, now }));
  const thumb = $derived(thumbDataUrl(attachment.thumb));
  const ratio = $derived(attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : '4 / 3');
  const shownWidth = $derived(Math.min(attachment.width ?? 280, 280));
  let url = $state<string | null>(null);
  let busy = $state(false);

  // The picture itself once it is in app storage. Only primitives are read
  // here: the attachment object is new on every database change, which must
  // not reload the picture.
  const showReady = $derived(image && attachment.status === 'ready');
  const blobId = $derived(attachment.blobId);
  const acc = $derived(accountId);
  $effect(() => {
    if (!showReady) return;
    let current: string | null = null;
    let cancelled = false;
    void app.core
      .attachmentUrl(acc, blobId)
      .then((u) => {
        if (cancelled) URL.revokeObjectURL(u);
        else url = current = u;
      })
      .catch((e: unknown) => app.log('warn', 'attachment', 'image not readable', e));
    return () => {
      cancelled = true;
      if (current) URL.revokeObjectURL(current);
      url = null;
    };
  });

  async function act(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      switch (ui.action) {
        case 'download':
        case 'retry-download':
          await app.core.downloadAttachment(accountId, attachment.blobId);
          break;
        case 'cancel-download':
          await app.core.cancelTransfer(accountId, attachment.blobId);
          break;
        case 'save':
          saveBlob(await app.core.attachmentBlob(accountId, attachment.blobId), attachment.name);
          break;
        default:
          break;
      }
    } catch (e) {
      app.notify(t.errors.generic);
      app.log('warn', 'attachment', `attachment action ${ui.action ?? 'none'} failed`, e);
    } finally {
      busy = false;
    }
  }

  const actionLabel = $derived(
    ui.action === 'download'
      ? t.attach.download
      : ui.action === 'retry-download'
        ? t.attach.retry
        : ui.action === 'cancel-download'
          ? t.attach.cancelDownload
          : ui.action === 'save'
            ? t.attach.save
            : '',
  );
</script>

{#if attachment.kind === 'voice'}
  <VoicePlayer {accountId} {attachment} {outgoing} {sentAt} {now} />
{:else if image}
  <div class="image" data-testid="attachment-image" data-status={attachment.status}>
    <button
      class="frame"
      type="button"
      style:aspect-ratio={ratio}
      style:width="{shownWidth}px"
      aria-label={t.attach.open(attachment.name)}
      onclick={() => onopen?.(attachment.blobId)}
    >
      {#if url}
        <img class="full" src={url} alt={attachment.name} />
      {:else if thumb}
        <img class="thumb" src={thumb} alt="" data-testid="attachment-thumb" />
      {:else}
        <span class="placeholder"><Icon name="image" size={32} /></span>
      {/if}
    </button>
    {#if ui.label && attachment.status !== 'uploading'}
      <div class="state" class:error={ui.tone === 'error'}>
        <span>{ui.label}</span>
        {#if ui.action && ui.action !== 'save'}
          <button class="link-btn small" type="button" disabled={busy} onclick={act}>{actionLabel}</button>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <div class="file" data-testid="attachment-file" data-status={attachment.status}>
    <span class="file-icon" aria-hidden="true"><Icon name="file" /></span>
    <span class="file-text">
      <span class="file-name">{attachment.name}</span>
      <span class="file-meta tabular">
        {formatBytes(attachment.size)}{#if ui.label && (attachment.status !== 'uploading' || ui.tone === 'error')}<span class:error-text={ui.tone === 'error'}> · {ui.label}</span>{/if}
      </span>
      {#if ui.percent !== null && attachment.status === 'downloading'}
        <progress max="100" value={ui.percent} aria-label={ui.label ?? ''}></progress>
      {/if}
    </span>
    {#if ui.action}
      <button
        class="icon-btn file-action"
        type="button"
        disabled={busy}
        aria-label="{actionLabel}: {attachment.name}"
        title={actionLabel}
        onclick={act}
      >
        <Icon name={ui.action === 'cancel-download' ? 'close' : ui.action === 'retry-download' ? 'alert' : 'download'} />
      </button>
    {/if}
  </div>
{/if}

<style>
  .image {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    max-width: 100%;
  }

  .frame {
    display: block;
    max-width: 100%;
    padding: 0;
    border: 0;
    border-radius: var(--r-m);
    overflow: hidden;
    background: var(--surface-2);
    cursor: zoom-in;
  }

  .frame img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .thumb {
    filter: blur(6px);
    transform: scale(1.05);
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--muted);
  }

  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .state.error {
    color: var(--error);
  }

  .state .link-btn {
    min-height: 32px;
    font-size: var(--text-xs);
  }

  .file {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: min(16rem, 100%);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--bg);
    color: var(--text);
  }

  .file-icon {
    display: inline-flex;
    color: var(--accent);
  }

  .file-text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .file-name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .file-meta {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  progress {
    width: 100%;
    height: 6px;
    accent-color: var(--accent);
  }
</style>
