<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isCoreError, type GroupView, type MessageView, type ReactionView } from '@family-chat/core';
  import type { MessageAction } from '../components/MessageMenu.svelte';
  import { lazy } from '../lib/lazy.ts';
  import { copyText } from '../lib/clipboard.ts';
  import Avatar from '../components/Avatar.svelte';
  import Composer from '../components/Composer.svelte';
  import Icon from '../components/Icon.svelte';
  import type { ViewerImage } from '../components/ImageViewer.svelte';
  import type { Place } from '../lib/location.ts';
  import type { VoiceRecording } from '../lib/recorder.ts';
  import { voiceFileName } from '../lib/voice.ts';
  import MessageBubble from '../components/MessageBubble.svelte';
  import { app, follow } from '../lib/app.svelte.ts';
  import { isDisplayableImage } from '../lib/attachment-state.ts';
  import { errorText } from '../lib/errors.ts';
  import { formatBytes, formatMegabytes } from '../lib/format.ts';
  import { groupByDay } from '../lib/group.ts';
  import { prepareAttachment } from '../lib/media.ts';
  import { displayNames, joinNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { serviceText } from '../lib/service.ts';
  import { activeLang, t } from '../lib/strings.ts';
  import { loadEmoji } from '../lib/emoji-data.ts';

  // A chat: direct, group or "Избранное". Messages
  // grouped by day, own messages on the right, in groups the author's name
  // and avatar on others' messages; service lines of groups; send statuses
  // with retry and cancel; attachments with preview, upload progress and the
  // image viewer; older messages on scrolling up; the composer at the bottom.
  let {
    accountId,
    chatId,
    focus = false,
    jump = null,
  }: {
    accountId: string;
    chatId: string;
    focus?: boolean;
    /** Open at this message (a search result) and mark it briefly. */
    jump?: { readonly senderId: string; readonly msgId: string; readonly gseq: number } | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const view = app.core.chat(accountId, chatId);
  let messages = $state.raw<MessageView[]>([]);
  let loaded = $state(false);
  let older = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
  let feedEl: HTMLDivElement | undefined = $state();
  let sentinel: HTMLDivElement | undefined = $state();
  let now = $state(Date.now());
  let announce = $state('');
  let offerPhrase = $state(false);
  /** Keys present when the chat opened; later ones animate in. */
  let initialKeys = $state.raw(new Set<string>());
  let stickToBottom = true;
  let group = $state.raw<GroupView | null>(null);
  let groupLoaded = $state(false);
  let composer: Composer | undefined = $state();
  // Attachments waiting in the preview.
  let pending = $state<File[]>([]);
  let caption = $state('');
  let sendingFiles = $state(false);
  let dragging = $state(false);
  // Image viewer.
  let viewerIndex = $state<number | null>(null);
  // "Место" sheet.
  let locating = $state(false);
  // Rarely used parts load on first use (code splitting): the preview, the viewer, the place sheet.
  const loadPreview = () => import('../components/AttachPreview.svelte');
  const loadViewer = () => import('../components/ImageViewer.svelte');
  const loadLocation = () => import('../components/LocationSheet.svelte');
  // The emoji picker (with its data), forwarding and the delete and "who reacted" dialogs.
  // The picker and the emoji names in the interface language, both on first use.
  const loadPicker = () => Promise.all([import('../components/EmojiPicker.svelte'), loadEmoji(activeLang())]);
  const loadForward = () => import('../components/ForwardSheet.svelte');
  const loadDialogs = () => import('../components/MessageDialogs.svelte');
  const loadMenu = lazy(() => import('../components/MessageMenu.svelte'));
  const loadSearch = lazy(() => import('../components/ChatSearchBar.svelte'));
  // The message menu and what it leads to.
  let menuFor = $state.raw<{ message: MessageView; anchor: DOMRect } | null>(null);
  /** The message of the open menu (kept after the menu closes, for the chosen action). */
  let menuTarget: MessageView | null = null;
  let replyTo = $state.raw<MessageView | null>(null);
  let editing = $state.raw<MessageView | null>(null);
  let pickerFor = $state.raw<{ kind: 'composer' } | { kind: 'react'; key: string } | null>(null);
  let forwardKey = $state<string | null>(null);
  let dialogFor = $state.raw<{ kind: 'delete'; key: string } | { kind: 'who'; key: string; emoji: string } | null>(null);
  let highlightKey = $state<string | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  // Text shared into the app, put into the composer once it exists.
  let sharedText = $state<string | null>(null);
  // Search inside this chat.
  let searchOpen = $state(false);
  let searchButton: HTMLButtonElement | undefined = $state();

  const account = $derived(app.accounts.find((a) => a.id === accountId) ?? null);
  const summary = $derived(app.chatList.find((c) => c.accountId === accountId && c.chatId === chatId) ?? null);
  const kind = $derived(summary?.kind ?? (account?.selfChatId === chatId ? 'self' : 'dm'));
  const peer = $derived(summary?.peerId ? app.members.find((m) => m.userId === summary.peerId) : undefined);
  const names = $derived(displayNames(app.members, t.common.unknownName));
  const memberById = $derived(new Map(app.members.map((m) => [m.userId, m])));
  const nameOf = (id: string): string => names.get(id) ?? group?.members.find((m) => m.userId === id)?.name ?? t.common.unknownName;
  const title = $derived(
    kind === 'self'
      ? t.list.selfChat
      : kind === 'group'
        ? (group?.name ?? summary?.title ?? t.group.title(null))
        : peer
          ? (names.get(peer.userId) ?? t.common.unknownName)
          : (summary?.title ?? t.common.unknownName),
  );
  const removed = $derived(account?.status === 'removed' || app.connection[accountId]?.kind === 'removed');
  const peerRemoved = $derived(peer?.removed ?? summary?.peerRemoved ?? false);
  const peerRevoked = $derived(peer?.revoked ?? summary?.peerRevoked ?? false);
  const feed = $derived(groupByDay(messages, now));
  const images = $derived<ViewerImage[]>(
    messages.flatMap((m) =>
      (m.attachments ?? [])
        .filter((a) => isDisplayableImage(a))
        .map((a) => ({ blobId: a.blobId, name: a.name, mime: a.mime, status: a.status, thumb: a.thumb })),
    ),
  );
  /** Why the composer is replaced by a line, or null when one can write. */
  const blocked = $derived.by((): string | null => {
    if (removed) return t.chat.removedComposer;
    if (kind === 'dm' && peerRevoked) return t.chat.peerRevokedComposer(peer?.gender ?? 'm');
    if (kind === 'dm' && peerRemoved) return t.chat.peerRemovedComposer(peer?.gender ?? 'm');
    if (kind === 'group') {
      if (!groupLoaded || !group) return null;
      if (!group.member) return t.group.notMember;
      if (group.broken) return t.group.broken;
      if (!group.canSend) return t.group.needKey;
    }
    return null;
  });
  const showComposer = $derived(kind !== 'group' || (groupLoaded && group !== null));
  const byKey = $derived(new Map(messages.map((m) => [m.key, m])));
  const forwardMessage = $derived(forwardKey ? (byKey.get(forwardKey) ?? null) : null);
  const isOwner = $derived(kind === 'group' && !!group?.isOwner);

  function canDeleteForAll(m: MessageView): boolean {
    if (m.kind !== 'msg' && m.kind !== 'update-required') return false;
    if (removed) return false;
    if (kind === 'group' && !group?.member) return false;
    return m.outgoing || isOwner;
  }

  function menuActions(m: MessageView): MessageAction[] {
    if (m.kind === 'deleted') return ['delete'];
    const out: MessageAction[] = [];
    if (!blocked && showComposer) out.push('reply');
    if (m.body.trim().length > 0 && !m.sticker) out.push('copy');
    if (!removed) out.push('forward');
    if (m.outgoing && m.kind === 'msg' && !blocked && !m.sticker) out.push('edit');
    out.push('delete');
    return out;
  }

  function quoteFor(m: MessageView): { name: string; text: string } {
    const first = m.attachments?.[0];
    const body = m.body.replace(/\s+/g, ' ').trim();
    const text =
      (m.sticker ? `${t.msg.sticker} ${body}` : body) ||
      (m.location ? t.msg.place : first?.kind === 'image' ? t.msg.photo : first?.kind === 'voice' ? t.msg.voice : (first?.name ?? t.msg.file));
    return { name: m.outgoing ? t.msg.youName : nameOf(m.senderId), text };
  }

  function nameOrYou(id: string): string {
    return id === account?.userId ? t.msg.youName : nameOf(id);
  }

  function openMenu(m: MessageView, anchor: DOMRect): void {
    menuTarget = m;
    menuFor = { message: m, anchor };
  }

  async function onAction(m: MessageView, a: MessageAction): Promise<void> {
    if (a === 'reply') {
      editing = null;
      replyTo = m;
      await tick();
      composer?.focus();
    } else if (a === 'copy') {
      app.notify((await copyText(m.body)) ? t.msg.copied : t.common.copyFailed);
    } else if (a === 'forward') {
      forwardKey = m.key;
    } else if (a === 'edit') {
      replyTo = null;
      editing = m;
    } else if (a === 'delete') {
      dialogFor = { kind: 'delete', key: m.key };
    }
  }

  async function react(m: MessageView, emoji: string, on: boolean): Promise<void> {
    try {
      await app.core.react(accountId, chatId, m.senderId, m.msgId, emoji, on);
    } catch (e) {
      app.notify(t.msg.failed);
      app.log('warn', 'chat', 'reaction failed', e);
    }
  }

  function toggleReaction(m: MessageView, emoji: string): void {
    const mine = m.reactions?.some((r) => r.emoji === emoji && r.mine) ?? false;
    void react(m, emoji, !mine);
  }

  async function saveEdit(text: string): Promise<boolean> {
    const m = editing;
    if (!m) return false;
    try {
      await app.core.editMessage(accountId, chatId, m.msgId, text);
      editing = null;
      return true;
    } catch (e) {
      app.notify(isCoreError(e, 'invalid-input') ? t.msg.editEmpty : t.msg.failed);
      app.log('warn', 'chat', 'edit failed', e);
      return false;
    }
  }

  async function deleteMessage(m: MessageView, forAll: boolean): Promise<void> {
    try {
      if (forAll) await app.core.deleteForEveryone(accountId, chatId, m.senderId, m.msgId);
      else await app.core.deleteForMe(accountId, chatId, m.senderId, m.msgId);
      if (replyTo?.key === m.key) replyTo = null;
      if (editing?.key === m.key) editing = null;
    } catch (e) {
      app.notify(t.msg.failed);
      app.log('warn', 'chat', 'delete failed', e);
    }
  }

  function showWho(m: MessageView, r: ReactionView): void {
    dialogFor = { kind: 'who', key: m.key, emoji: r.emoji };
  }

  function mark(key: string): void {
    clearTimeout(highlightTimer);
    highlightKey = key;
    highlightTimer = setTimeout(() => (highlightKey = null), 2500);
  }

  /** Scrolls to a message (loading older ones from this device if needed) and marks it. */
  async function jumpTo(senderId: string, msgId: string, gseq: number | null): Promise<boolean> {
    const key = `${senderId}/${msgId}`;
    if (!byKey.has(key)) {
      if (gseq === null || !(await view.reveal(gseq))) {
        app.notify(t.search.notLoaded);
        return false;
      }
      for (let i = 0; i < 40 && !byKey.has(key); i++) await new Promise((r) => setTimeout(r, 25));
    }
    await tick();
    const el = feedEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    mark(key);
    return true;
  }

  function onQuote(m: MessageView): void {
    const q = m.replyTo;
    if (q?.available) void jumpTo(q.author, q.id, q.gseq);
  }

  const bigUpload = $derived(
    messages.some((m) => m.outgoing && m.status === 'on-device' && m.upload && m.upload.total > 4 * 1024 * 1024 && m.upload.done < m.upload.total),
  );

  // The chat list's counter may update after the messages: clear it whenever it rises while the chat is open.
  $effect(() => {
    if ((summary?.unread ?? 0) > 0 && loaded) markReadIfVisible();
  });

  function nearBottom(): boolean {
    if (!feedEl) return true;
    return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
  }

  function scrollToBottom(): void {
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }

  function markReadIfVisible(): void {
    if (document.visibilityState === 'visible' && (summary?.unread ?? 0) > 0) void view.markRead();
  }

  function authorOf(m: MessageView): { userId: string; name: string; hasAvatar: boolean } | null {
    if (kind !== 'group' || m.outgoing || m.kind === 'service' || !m.senderId) return null;
    const member = memberById.get(m.senderId);
    return { userId: m.senderId, name: nameOf(m.senderId), hasAvatar: !!member?.avatar };
  }

  async function onMessages(list: MessageView[]): Promise<void> {
    const wasLoaded = loaded;
    const stick = nearBottom() || stickToBottom;
    if (wasLoaded) {
      const prev = new Set(messages.map((m) => m.key));
      const incoming = list.filter((m) => !prev.has(m.key) && !m.outgoing && (m.kind === 'msg' || m.kind === 'service'));
      // Only new messages are announced (not older ones loaded on scrolling).
      const newest = incoming.at(-1);
      if (newest && newest.key === list.at(-1)?.key) {
        if (newest.kind === 'service' && newest.service) announce = serviceText(newest.service, { me: account?.userId ?? '', nameOf, genderOf: (id) => app.genderOf(id) });
        else {
          const who = kind === 'group' ? nameOf(newest.senderId) : title;
          const first = newest.attachments?.[0];
          const text =
            newest.body.slice(0, 200) ||
            (newest.location ? t.list.location : first?.kind === 'voice' ? t.list.voice : t.list.attachment((newest.attachments ?? []).length));
          announce = `${t.chat.incoming(who)}: ${text}`;
        }
      }
    } else {
      initialKeys = new Set(list.map((m) => m.key));
    }
    messages = list;
    loaded = true;
    await tick();
    if (!wasLoaded || stick) scrollToBottom();
    stickToBottom = false;
    markReadIfVisible();
    if (!wasLoaded) {
      if (jump) void jumpTo(jump.senderId, jump.msgId, jump.gseq);
      else checkTop();
    }
  }

  async function closeSearch(): Promise<void> {
    searchOpen = false;
    await tick();
    searchButton?.focus();
  }

  /** The observer does not fire again while the top stays visible: short chats are checked here. */
  function checkTop(): void {
    if (feedEl && feedEl.scrollTop < 200) void loadOlder();
  }

  async function loadOlder(): Promise<void> {
    if (older === 'loading' || older === 'done' || !feedEl) return;
    older = 'loading';
    const fromBottom = feedEl.scrollHeight - feedEl.scrollTop;
    try {
      const more = await view.loadOlder();
      await tick();
      if (feedEl) feedEl.scrollTop = feedEl.scrollHeight - fromBottom;
      older = more ? 'idle' : 'done';
      if (more) checkTop();
    } catch (e) {
      older = 'error';
      app.log('warn', 'chat', 'loading older messages failed', e);
    }
  }

  function onPopState(e: PopStateEvent): void {
    // "Back" closes the viewer first.
    if (viewerIndex !== null && !(e.state as { fcViewer?: boolean } | null)?.fcViewer) viewerIndex = null;
  }

  onMount(() => {
    const unsub = follow(view.messages, (list) => void onMessages(list));
    const groupUnsub = app.core.group(accountId, chatId).subscribe((g) => {
      group = g;
      if (g) groupLoaded = true;
    });
    // A group view can legitimately stay null for a moment; the list's summary says whether this is a group.
    const groupTimer = setTimeout(() => (groupLoaded = true), 1500);
    const timer = setInterval(() => (now = Date.now()), 60_000);
    const onVisible = () => markReadIfVisible();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('popstate', onPopState);
    let io: IntersectionObserver | undefined;
    if (sentinel && feedEl && 'IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (entries) => {
          if (loaded && entries.some((e) => e.isIntersecting)) void loadOlder();
        },
        { root: feedEl, rootMargin: '200px 0px 0px 0px' },
      );
      io.observe(sentinel);
    }
    if (!app.hello) void app.refreshHello();
    // Content shared into the app (Web Share Target) for this chat: files go to the preview, text to the field.
    const share = app.pendingShare;
    if (share && share.accountId === accountId && share.chatId === chatId) {
      app.pendingShare = null;
      if (share.content.files.length > 0) {
        pending = [...share.content.files];
        caption = share.content.text;
      } else sharedText = share.content.text;
      app.notify(t.share.ready);
    }
    return () => {
      clearTimeout(highlightTimer);
      unsub();
      groupUnsub();
      clearTimeout(groupTimer);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('popstate', onPopState);
      io?.disconnect();
    };
  });

  $effect(() => {
    if (sharedText !== null && composer) {
      composer.insert(sharedText);
      sharedText = null;
    }
  });

  async function sendSticker(packId: string, file: string): Promise<void> {
    if (blocked) return;
    try {
      stickToBottom = true;
      const reply = takeReply();
      await app.core.sendSticker(accountId, chatId, packId, file, reply);
      afterFirstSend();
    } catch (e) {
      app.notify(isCoreError(e, 'gone') ? t.stickers.unavailable : errorText(e));
      app.log('warn', 'chat', 'sending a sticker failed', e);
    }
  }

  function afterFirstSend(): void {
    // Invited relatives are offered the recovery phrase after the first sent message.
    if (account && !account.admin && app.flagsLoaded && !app.flags.phraseOffered && !app.flags.phraseConfirmed) {
      offerPhrase = true;
    }
  }

  /** The reply of the next message (and it is used up). */
  function takeReply(): { author: string; id: string } | undefined {
    const r = replyTo;
    replyTo = null;
    return r ? { author: r.senderId, id: r.msgId } : undefined;
  }

  async function send(text: string): Promise<boolean> {
    const reply = replyTo;
    try {
      stickToBottom = true;
      const r = takeReply();
      if (r) await app.core.sendMessage(accountId, chatId, { text, reply: r });
      else await app.core.send(accountId, chatId, text);
      afterFirstSend();
      return true;
    } catch (e) {
      replyTo = reply;
      app.notify(errorText(e));
      app.log('warn', 'chat', 'queueing a message failed', e);
      return false;
    }
  }

  function onFiles(files: File[], text: string): void {
    if (blocked) return;
    pending = [...pending, ...files];
    if (caption === '') caption = text;
  }

  function closePreview(): void {
    pending = [];
    caption = '';
  }

  async function sendFiles(original: boolean): Promise<void> {
    sendingFiles = true;
    try {
      const attachments = [];
      for (const f of pending) attachments.push(await prepareAttachment(f, { original }));
      stickToBottom = true;
      const reply = takeReply();
      await app.core.sendMessage(accountId, chatId, { text: caption.trim(), attachments, ...(reply ? { reply } : {}) });
      composer?.clear();
      closePreview();
      afterFirstSend();
    } catch (e) {
      if (isCoreError(e, 'too-large')) app.notify(t.attach.tooLargeAny(app.hello ? formatMegabytes(app.hello.maxFileMb) : formatBytes(0)));
      else if (isCoreError(e, 'no-space')) app.notify(t.attach.noSpace);
      else app.notify(isCoreError(e, 'invalid-input') ? t.attach.failed : errorText(e));
      app.log('warn', 'chat', 'sending attachments failed', e);
    } finally {
      sendingFiles = false;
    }
  }

  async function sendVoice(rec: VoiceRecording): Promise<boolean> {
    if (blocked) return false;
    try {
      stickToBottom = true;
      const reply = takeReply();
      await app.core.sendMessage(accountId, chatId, {
        ...(reply ? { reply } : {}),
        attachments: [
          { data: rec.blob, name: voiceFileName(rec.mime, Date.now()), mime: rec.mime, kind: 'voice', durationMs: rec.durationMs, peaks: rec.peaks },
        ],
      });
      afterFirstSend();
      return true;
    } catch (e) {
      if (isCoreError(e, 'no-space')) app.notify(t.attach.noSpace);
      else if (isCoreError(e, 'too-large')) app.notify(t.attach.tooLargeAny(app.hello ? formatMegabytes(app.hello.maxFileMb) : ''));
      else app.notify(errorText(e));
      app.log('warn', 'chat', 'sending a voice message failed', e);
      return true; // the reason was already shown
    }
  }

  async function sendPlace(place: Place): Promise<boolean> {
    try {
      stickToBottom = true;
      const reply = takeReply();
      await app.core.sendMessage(accountId, chatId, { location: place, ...(reply ? { reply } : {}) });
      afterFirstSend();
      return true;
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'chat', 'sending a place failed', e);
      return false;
    }
  }

  function retry(m: MessageView): void {
    void app.core.retry(accountId, m.msgId).catch((e: unknown) => app.log('warn', 'chat', 'retry failed', e));
  }

  function cancel(m: MessageView): void {
    void app.core.cancel(accountId, m.msgId).catch((e: unknown) => app.log('warn', 'chat', 'cancel failed', e));
  }

  function openViewer(blobId: string): void {
    const i = images.findIndex((x) => x.blobId === blobId);
    if (i < 0) return;
    viewerIndex = i;
    history.pushState({ fcDepth: nav.stack.length - 1, fcViewer: true }, '');
  }

  function closeViewer(): void {
    if (viewerIndex === null) return;
    viewerIndex = null;
    if ((history.state as { fcViewer?: boolean } | null)?.fcViewer) history.back();
  }

  async function phraseNow(): Promise<void> {
    offerPhrase = false;
    await app.setFlag('phraseOffered');
    nav.push({ name: 'phrase' });
  }

  async function phraseLater(): Promise<void> {
    offerPhrase = false;
    await app.setFlag('phraseOffered');
  }

  function openInfo(): void {
    if (kind === 'group') nav.push({ name: 'chat-info', accountId, chatId });
    else if (kind === 'dm' && peer) nav.push({ name: 'contact', accountId, userId: peer.userId });
  }

  function newGroupFromFrozen(): void {
    if (!group) return;
    const members = group.members.filter((m) => !m.isMe && !m.removed && !m.revoked).map((m) => m.userId);
    nav.push({ name: 'new-group', members, ...(group.name ? { title: group.name } : {}) });
  }

  function onKeydown(e: KeyboardEvent): void {
    const overlay = viewerIndex !== null || pending.length > 0 || locating || menuFor || pickerFor || forwardKey || dialogFor || searchOpen;
    if (e.key === 'Escape' && !e.defaultPrevented && !app.wide && !overlay) nav.back();
  }

  // Drag and drop of files onto the chat (desktop).
  function hasFiles(e: DragEvent): boolean {
    return [...(e.dataTransfer?.types ?? [])].includes('Files');
  }

  function onDragOver(e: DragEvent): void {
    if (!hasFiles(e) || blocked || !showComposer) return;
    e.preventDefault();
    dragging = true;
  }

  function onDragLeave(e: DragEvent): void {
    if (e.currentTarget === e.target || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false;
  }

  function onDrop(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0) onFiles(files, '');
  }

  const subtitle = $derived.by((): string | null => {
    if (kind === 'group' && group) return t.group.members(group.members.length);
    if (kind === 'dm' && peer?.verified) return t.contact.verifiedMark;
    return null;
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="screen chat chat-scaled"
  aria-labelledby="chat-title-{chatId}"
  onkeydown={onKeydown}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <header class="screen-header">
    {#if !app.wide}
      <button class="icon-btn" type="button" aria-label={t.chat.back} onclick={() => nav.back()}>
        <Icon name="back" />
      </button>
    {/if}
    <span class="who">
      {#if kind === 'self'}
        <Avatar {accountId} kind="self" size={36} />
      {:else}
        <button
          class="avatar-btn"
          type="button"
          aria-label={kind === 'group' ? t.group.openInfo : t.contact.openProfile}
          onclick={openInfo}
        >
          <Avatar {accountId} userId={peer?.userId ?? null} name={title} kind={kind === 'group' ? 'group' : 'person'} hasAvatar={!!peer?.avatar} size={36} />
        </button>
      {/if}
      <span class="titles">
        <h1 id="chat-title-{chatId}">{title}</h1>
        {#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
      </span>
    </span>
    <button bind:this={searchButton} class="icon-btn" type="button" aria-label={t.search.inChat} aria-expanded={searchOpen} onclick={() => (searchOpen ? closeSearch() : (searchOpen = true))} data-testid="chat-search-button">
      <Icon name="search" />
    </button>
  </header>

  {#if searchOpen}
    {#await loadSearch() then { default: ChatSearchBar }}
      <ChatSearchBar {accountId} {chatId} onjump={(sender, id, gseq) => void jumpTo(sender, id, gseq)} onclose={closeSearch} />
    {/await}
  {/if}

  {#if kind === 'group' && group}
    {#if group.frozen}
      <div class="notice warn banner" role="status">
        <p>{t.group.frozen(app.genderOf(group.members.find((x) => x.isOwner)?.userId))}</p>
        <button class="btn small" type="button" onclick={newGroupFromFrozen}>{t.group.frozenAction}</button>
      </div>
    {/if}
    {#if group.mismatch && (group.mismatch.extraOnServer.length > 0 || group.mismatch.missingOnServer.length > 0)}
      <div class="notice warn banner" role="status" data-testid="group-mismatch">
        <p>{t.group.mismatch}</p>
        {#if group.mismatch.extraOnServer.length > 0}<p class="small">{t.group.mismatchExtra(joinNames(group.mismatch.extraOnServer.map(nameOf)))}</p>{/if}
        {#if group.mismatch.missingOnServer.length > 0}<p class="small">{t.group.mismatchMissing(joinNames(group.mismatch.missingOnServer.map(nameOf)))}</p>{/if}
      </div>
    {/if}
    {#if group.pendingChange}
      <p class="notice banner small" role="status">{group.pendingChange.error ? t.group.pendingFailed : t.group.pending}</p>
    {/if}
  {/if}
  {#if kind === 'dm' && peer?.keyChanged && !peerRevoked}
    <div class="notice warn banner" role="status">
      <p>{t.chat.keyChanged(title)}</p>
      <button class="btn small secondary" type="button" onclick={openInfo}>{t.chat.keyChangedAction}</button>
    </div>
  {/if}

  <div class="feed chat-bg" bind:this={feedEl} data-testid="feed">
    <div class="top" bind:this={sentinel}>
      {#if loaded && messages.length > 0}
        {#if older === 'loading'}
          <p class="muted small" role="status">{t.chat.loadingOlder}</p>
        {:else if older === 'done'}
          {#if account?.historyTrimmed || account?.retentionGap}
            <div class="notice small gap" data-testid="retention-gap">
              <p>{t.chat.gap(account.oldestTime ?? account.retentionGap?.firstTime ?? null)}</p>
              <button class="link-btn small" type="button" onclick={() => nav.push({ name: 'storage' })}>{t.chat.importArchive}</button>
            </div>
          {:else}
            <p class="muted small">{t.chat.beginning}</p>
          {/if}
        {:else}
          {#if older === 'error'}<p class="error-text small">{t.chat.olderFailed}</p>{/if}
          <button class="btn secondary small" type="button" onclick={loadOlder}>{t.chat.loadOlder}</button>
        {/if}
      {/if}
    </div>

    {#if loaded && messages.length === 0}
      <p class="empty muted">{kind === 'self' ? t.chat.selfEmpty : t.chat.empty(app.myGender)}</p>
    {/if}

    <ol class="messages" aria-label={title}>
      {#each feed as entry (entry.key)}
        {#if entry.kind === 'day'}
          <li class="day"><span>{entry.label}</span></li>
        {:else if entry.message.kind === 'service' && entry.message.service}
          <li class="service" data-testid="service-line">
            <span>{serviceText(entry.message.service, { me: account?.userId ?? '', nameOf, genderOf: (id) => app.genderOf(id) })}</span>
          </li>
        {:else}
          {@const author = authorOf(entry.message)}
          <li data-key={entry.key}>
            <span class="visually-hidden">
              {entry.message.outgoing ? t.chat.outgoing : t.chat.incoming(kind === 'group' ? nameOf(entry.message.senderId) : title)}:
            </span>
            <MessageBubble
              message={entry.message}
              continued={entry.continued}
              fresh={!initialKeys.has(entry.key)}
              {author}
              {now}
              onretry={retry}
              oncancel={cancel}
              onopen={openViewer}
              nameOf={nameOrYou}
              onmenu={openMenu}
              onreact={removed || (kind === 'group' && group !== null && !group.member) ? undefined : (m, emoji, on) => void react(m, emoji, on)}
              onquote={onQuote}
              onwho={showWho}
              highlight={highlightKey === entry.key}
            />
          </li>
        {/if}
      {/each}
    </ol>
  </div>

  <div class="visually-hidden" aria-live="polite" aria-atomic="true">{announce}</div>

  {#if offerPhrase}
    <section class="offer" aria-labelledby="offer-title-{chatId}">
      <h2 id="offer-title-{chatId}">{t.phrase.offerTitle}</h2>
      <p>{t.phrase.offerText}</p>
      <div class="row">
        <button class="btn small" type="button" onclick={phraseNow}>{t.phrase.offerShow}</button>
        <button class="btn secondary small" type="button" onclick={phraseLater}>{t.common.later}</button>
      </div>
    </section>
  {/if}

  {#if bigUpload && app.platform.os === 'ios'}
    <p class="keep-open small" role="status">{t.attach.keepOpen}</p>
  {/if}

  {#if blocked}
    <p class="blocked" role="status" data-testid="composer-blocked">{blocked}</p>
  {:else if showComposer}
    <Composer
      bind:this={composer}
      {accountId}
      {chatId}
      autofocus={focus}
      onsend={send}
      onfiles={onFiles}
      onvoice={sendVoice}
      onlocation={() => (locating = true)}
      reply={replyTo ? quoteFor(replyTo) : null}
      oncancelreply={() => (replyTo = null)}
      editing={editing ? { key: editing.key, body: editing.body, allowEmpty: (editing.attachments?.length ?? 0) > 0 || !!editing.location } : null}
      onedit={saveEdit}
      oncanceledit={() => (editing = null)}
      onemoji={() => (pickerFor = { kind: 'composer' })}
    />
  {/if}

  {#if dragging}
    <div class="drop" aria-hidden="true"><p>{t.attach.dropHere}</p></div>
  {/if}
</section>

{#if pending.length > 0}
  {#await loadPreview() then { default: AttachPreview }}
    <AttachPreview
      bind:files={pending}
      bind:caption
      maxBytes={app.hello?.maxBlobBytes ?? null}
      limitText={app.hello ? formatMegabytes(app.hello.maxFileMb) : ''}
      busy={sendingFiles}
      onsend={sendFiles}
      oncancel={closePreview}
    />
  {/await}
{/if}

{#if viewerIndex !== null && images.length > 0}
  {#await loadViewer() then { default: ImageViewer }}
    <ImageViewer {accountId} {images} bind:index={viewerIndex} onclose={closeViewer} />
  {/await}
{/if}

{#if locating}
  {#await loadLocation() then { default: LocationSheet }}
    <LocationSheet onsend={sendPlace} oncancel={() => (locating = false)} />
  {/await}
{/if}

{#if menuFor}
  {#await loadMenu() then { default: MessageMenu }}
    {@const m = menuFor?.message}
    <MessageMenu
      actions={m ? menuActions(m) : []}
      reactions={m?.kind === 'msg' && !removed && !(kind === 'group' && group !== null && !group.member)}
      mine={(m?.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji)}
      anchor={menuFor?.anchor ?? null}
      onaction={(a) => {
        if (menuTarget) void onAction(menuTarget, a);
      }}
      onreact={(emoji) => {
        if (menuTarget) toggleReaction(menuTarget, emoji);
      }}
      onmore={() => {
        if (menuTarget) pickerFor = { kind: 'react', key: menuTarget.key };
      }}
      onclose={() => (menuFor = null)}
    />
  {/await}
{/if}

{#if pickerFor}
  {@const target = pickerFor}
  {#await loadPicker()}
    <p class="visually-hidden" role="status">{t.emoji.loading}</p>
  {:then [{ default: EmojiPicker }, emojiSet]}
    <EmojiPicker
      emoji={emojiSet}
      title={target.kind === 'react' ? t.msg.reactions : t.emoji.titleWithStickers}
      stickers={target.kind === 'composer' ? accountId : null}
      onsticker={(packId, file) => void sendSticker(packId, file)}
      onpick={(emoji) => {
        if (target.kind === 'composer') composer?.pickEmoji(emoji);
        else {
          const m = byKey.get(target.key);
          if (m) toggleReaction(m, emoji);
        }
      }}
      onclose={() => (pickerFor = null)}
    />
  {/await}
{/if}

{#if forwardMessage}
  {#await loadForward() then { default: ForwardSheet }}
    <ForwardSheet {accountId} {chatId} message={forwardMessage} onclose={() => (forwardKey = null)} />
  {/await}
{/if}

{#if dialogFor}
  {@const d = dialogFor}
  {@const target = d ? byKey.get(d.key) : undefined}
  {#if d && target}
    {#await loadDialogs() then { default: MessageDialogs }}
      {#if d.kind === 'delete'}
        <MessageDialogs
          kind="delete"
          forAll={canDeleteForAll(target)}
          onconfirm={(forAll) => void deleteMessage(target, forAll)}
          onclose={() => (dialogFor = null)}
        />
      {:else}
        <MessageDialogs
          kind="who"
          emoji={d.emoji}
          names={(target.reactions ?? []).find((r) => r.emoji === d.emoji)?.users.map(nameOrYou) ?? []}
          onclose={() => (dialogFor = null)}
        />
      {/if}
    {/await}
  {/if}
{/if}

<style>
  .chat {
    position: relative;
    background: var(--bg);
  }

  .who {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1 1 auto;
    min-width: 0;
    margin-left: var(--sp-1);
  }

  .avatar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--touch);
    height: var(--touch);
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }

  .avatar-btn:hover {
    background: var(--surface-2);
  }

  .titles {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .titles h1 {
    font-size: var(--text-l);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtitle {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .banner {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: var(--sp-2) var(--sp-3) 0;
  }

  .banner .btn {
    align-self: flex-start;
  }

  .feed {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: var(--sp-3);
  }

  .top {
    display: flex;
    justify-content: center;
    padding: var(--sp-3) var(--sp-4) 0;
    text-align: center;
  }

  .gap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
  }

  .empty {
    padding: var(--sp-8) var(--sp-4);
    text-align: center;
  }

  .messages {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .day,
  .service {
    display: flex;
    justify-content: center;
    margin: var(--sp-4) var(--sp-4) var(--sp-2);
    text-align: center;
  }

  .day span {
    padding: 2px var(--sp-3);
    border-radius: var(--r-l);
    background: var(--surface-2);
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .service {
    margin: var(--sp-2) var(--sp-4);
  }

  .service span {
    max-width: 36rem;
    padding: 2px var(--sp-3);
    border-radius: var(--r-l);
    background: var(--surface-2);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .offer {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0 var(--sp-3) var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--warn-soft);
  }

  .offer h2 {
    font-size: var(--text-m);
  }

  .keep-open {
    padding: var(--sp-2) var(--sp-4);
    background: var(--warn-soft);
    text-align: center;
  }

  .blocked {
    padding: var(--sp-4);
    padding-bottom: max(var(--sp-4), env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    text-align: center;
  }

  .drop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 3px dashed var(--accent);
    background: var(--scrim);
    color: var(--on-accent);
    font-weight: 700;
    font-size: var(--text-l);
    pointer-events: none;
  }

  .drop p {
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--accent);
  }
</style>
