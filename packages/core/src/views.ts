// View types of the M2 facade and the queries that build them from the
// local database (used inside Dexie live queries, so they only read).

import { compareGroupMembers, fingerprint, type AvatarRef, type Location, type MsgRef } from '@family-chat/protocol';
import { Dexie } from 'dexie';
import type {
  BlobRow,
  ChatKind,
  CoreDb,
  GroupRow,
  LastMedia,
  MessageKind,
  MessageRow,
  OutboxRow,
  ServiceEntry,
  UserRow,
} from './db/schema.ts';
import { SERVICE_SENDER } from './groups.ts';

/** State of one attachment as the UI shows it. */
export type AttachmentStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'ready'
  | 'failed'
  /** Deleted on the server (by the sender or by retention) before it was downloaded. */
  | 'gone'
  | 'uploading'
  | 'cancelled';

export interface AttachmentView {
  readonly blobId: string;
  readonly name: string;
  readonly mime: string;
  readonly kind: 'image' | 'voice' | 'file';
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  /** base64url of an inline JPEG thumbnail (`data:image/jpeg;base64,…` after converting the alphabet). */
  readonly thumb: string | null;
  readonly durationMs: number | null;
  readonly peaks: readonly number[] | null;
  /** Voice: listened to on this device (always true for own uploads). */
  readonly heard: boolean;
  readonly status: AttachmentStatus;
  /** 0..1 while downloading or uploading, 1 when ready. */
  readonly progress: number;
  readonly error: string | null;
}

/** "on-device": in the outbox; "on-server": accepted by the server; "failed": needs retry or cancel. */
export type MessageStatus = 'on-device' | 'on-server' | 'failed';

export interface MessageView {
  /** Stable key for lists: `${senderId}/${msgId}`. */
  readonly key: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly msgId: string;
  /** '' for service entries. */
  readonly senderId: string;
  readonly outgoing: boolean;
  /** `update-required`: show "update the app to see this message"; `service`: see `service`. */
  readonly kind: MessageKind;
  readonly body: string;
  readonly reply: MsgRef | null;
  /** Server order and time; null while the message is still on the device. */
  readonly gseq: number | null;
  readonly time: number | null;
  readonly status: MessageStatus;
  /** Last error code for failed or retrying outbox messages. */
  readonly error: string | null;
  /** Attachments (empty list when none). */
  readonly attachments?: readonly AttachmentView[];
  readonly location?: Location | null;
  readonly fwd?: boolean;
  /** For kind 'service': what happened in the group. */
  readonly service?: ServiceEntry | null;
  /** Upload progress of an outgoing message with attachments (bytes), while it is on the device. */
  readonly upload?: { readonly done: number; readonly total: number } | null;
}

export interface ChatSummary {
  readonly accountId: string;
  readonly chatId: string;
  readonly kind: ChatKind;
  /** Group name, the peer's name, or null (chat with myself: the UI shows "Избранное"; unknown name). */
  readonly title: string | null;
  /** The other member of a direct chat; null for groups and the chat with myself. */
  readonly peerId: string | null;
  readonly peerRemoved: boolean;
  readonly peerRevoked: boolean;
  readonly familyName: string;
  /** The chat with myself is pinned first. */
  readonly pinned: boolean;
  /** Groups: I am a member (false: read-only archive, "you are no longer a member"). Always true otherwise. */
  readonly member: boolean;
  readonly lastMessage: {
    readonly senderId: string;
    readonly outgoing: boolean;
    readonly kind: MessageKind;
    readonly body: string;
    readonly time: number;
    /** Attachment kind or 'location' when the message carries one (null for plain text). */
    readonly media: LastMedia | null;
  } | null;
  readonly lastTime: number | null;
  readonly unread: number;
  readonly pending: number;
  readonly draft: string | null;
}

export interface GroupMemberView {
  readonly userId: string;
  readonly name: string | null;
  readonly isMe: boolean;
  readonly isOwner: boolean;
  readonly removed: boolean;
  readonly revoked: boolean;
  readonly avatar: AvatarRef | null;
  /** The keys in the signed state differ from the member's known identity. */
  readonly keyMismatch: boolean;
}

export interface GroupView {
  readonly accountId: string;
  readonly chatId: string;
  /** From the verified state; null until the first state is accepted. */
  readonly name: string | null;
  readonly owner: string | null;
  readonly isOwner: boolean;
  readonly version: number | null;
  readonly epoch: number | null;
  /** Members of the signed state (the source of truth). */
  readonly members: readonly GroupMemberView[];
  /** I am a member; false: sending is disabled and the history stays readable. */
  readonly member: boolean;
  readonly left: { readonly reason: 'left' | 'removed'; readonly at: number } | null;
  /** Can send now (member, state and epoch key present). */
  readonly canSend: boolean;
  /** Waiting for the sealed key of a state. */
  readonly needKey: boolean;
  /** A state failed verification (protocol error code); the group does not advance. */
  readonly broken: string | null;
  /**
   * The server's delivery list differs from the signed state (only when both
   * are at the same version): `missingOnServer` left or are being removed,
   * `extraOnServer` receive ciphertext without a key.
   */
  readonly mismatch: { readonly missingOnServer: readonly string[]; readonly extraOnServer: readonly string[] } | null;
  /** A change written on this device that the server has not confirmed yet. */
  readonly pendingChange: { readonly type: string; readonly error: string | null } | null;
  /** The owner was removed from the family or revoked: the members cannot be changed any more. */
  readonly frozen: boolean;
}

export interface TransferView {
  readonly accountId: string;
  readonly blobId: string;
  readonly direction: 'up' | 'down';
  readonly chatId: string;
  readonly msgId: string;
  readonly name: string;
  readonly size: number;
  readonly bytesDone: number;
  readonly status: AttachmentStatus;
  readonly error: string | null;
}

export function attachmentStatus(row: BlobRow | undefined): AttachmentStatus {
  if (!row) return 'not-downloaded';
  switch (row.status) {
    case 'none':
      return 'not-downloaded';
    case 'queued':
    case 'active':
      return row.direction === 'up' ? 'uploading' : 'downloading';
    case 'done':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'gone':
      return 'gone';
    case 'cancelled':
      return 'cancelled';
  }
}

export function transferView(r: BlobRow): TransferView {
  return {
    accountId: r.accountId,
    blobId: r.blobId,
    direction: r.direction,
    chatId: r.chatId,
    msgId: r.msgId,
    name: r.name,
    size: r.size,
    bytesDone: r.bytesDone,
    status: attachmentStatus(r),
    error: r.error,
  };
}

function attachmentViews(list: MessageRow['attachments'], blobs: Map<string, BlobRow>): AttachmentView[] {
  return (list ?? []).map((a) => {
    const row = blobs.get(a.blob.id);
    const status = attachmentStatus(row);
    return {
      blobId: a.blob.id,
      name: a.name,
      mime: a.mime,
      kind: a.kind,
      size: a.blob.size,
      width: a.w ?? null,
      height: a.h ?? null,
      thumb: a.thumb ?? null,
      durationMs: a.dur ?? null,
      peaks: a.peaks ?? null,
      heard: row?.heard === true || row?.direction === 'up',
      status,
      progress: status === 'ready' ? 1 : row && a.blob.size > 0 ? Math.min(1, row.bytesDone / a.blob.size) : 0,
      error: row?.error ?? null,
    };
  });
}

/** Messages of a chat for ChatView (newest `limit` from the database, then the outbox). */
export async function chatMessages(db: CoreDb, accountId: string, chatId: string, limit: number): Promise<MessageView[]> {
  const account = await db.accounts.get(accountId);
  const me = account?.userId ?? '';
  const rows = await db.messages
    .where('[accountId+chatId+gseq]')
    .between([accountId, chatId, Dexie.minKey], [accountId, chatId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray();
  rows.reverse();
  const pending = (await db.outbox.where('[accountId+chatId]').equals([accountId, chatId]).toArray()).sort(
    (a, b) => a.createdAt - b.createdAt || a.seq - b.seq,
  );
  const blobIds = new Set<string>();
  for (const m of rows) for (const a of m.attachments ?? []) blobIds.add(a.blob.id);
  for (const o of pending) for (const a of o.attachments ?? []) blobIds.add(a.blob.id);
  const blobs = new Map<string, BlobRow>();
  if (blobIds.size > 0) {
    const found = await db.blobs.bulkGet([...blobIds].map((id): [string, string] => [accountId, id]));
    for (const b of found) if (b) blobs.set(b.blobId, b);
  }
  const out: MessageView[] = rows.map((m) => ({
    key: `${m.senderId}/${m.msgId}`,
    accountId,
    chatId,
    msgId: m.msgId,
    senderId: m.senderId,
    outgoing: m.senderId === me && m.senderId !== SERVICE_SENDER,
    kind: m.kind,
    body: m.body,
    reply: m.reply,
    gseq: m.gseq,
    time: m.time,
    status: 'on-server',
    error: null,
    attachments: attachmentViews(m.attachments, blobs),
    location: m.location ?? null,
    fwd: m.fwd === true,
    service: m.service ?? null,
    upload: null,
  }));
  for (const o of pending) out.push(outboxView(o, me, blobs));
  return out;
}

function outboxView(o: OutboxRow, me: string, blobs: Map<string, BlobRow>): MessageView {
  const atts = attachmentViews(o.attachments, blobs);
  const total = (o.attachments ?? []).reduce((n, a) => n + a.blob.size, 0);
  const done = (o.attachments ?? []).reduce((n, a) => n + (blobs.get(a.blob.id)?.bytesDone ?? 0), 0);
  const uploadFailed = atts.some((a) => a.status === 'failed');
  // A full server disk (507) keeps the upload retrying; the message says why it waits.
  const serverFull = atts.some((a) => a.status === 'uploading' && a.error === 'storage_full');
  return {
    key: `${me}/${o.msgId}`,
    accountId: o.accountId,
    chatId: o.chatId,
    msgId: o.msgId,
    senderId: me,
    outgoing: true,
    kind: 'msg',
    body: o.body,
    reply: o.reply,
    gseq: null,
    time: null,
    status: o.status === 'failed' || uploadFailed ? 'failed' : 'on-device',
    error: o.error ?? (uploadFailed ? 'upload_failed' : serverFull ? 'storage_full' : null),
    attachments: atts,
    location: o.location ?? null,
    fwd: o.fwd === true,
    service: null,
    upload: o.attachments && o.attachments.length > 0 ? { done: Math.min(done, total), total } : null,
  };
}

/** All chats of all accounts: the chat with myself first, then the most recent. */
export async function chatSummaries(db: CoreDb): Promise<ChatSummary[]> {
  const [accounts, chats, users, drafts, outbox, groups] = await Promise.all([
    db.accounts.toArray(),
    db.chats.toArray(),
    db.users.toArray(),
    db.drafts.toArray(),
    db.outbox.toArray(),
    db.groups.toArray(),
  ]);
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const user = new Map(users.map((u) => [`${u.accountId}/${u.userId}`, u]));
  const group = new Map(groups.map((g) => [`${g.accountId}/${g.chatId}`, g]));
  const draft = new Map(drafts.map((d) => [`${d.accountId}/${d.chatId}`, d.text]));
  const pending = new Map<string, number>();
  for (const o of outbox) pending.set(`${o.accountId}/${o.chatId}`, (pending.get(`${o.accountId}/${o.chatId}`) ?? 0) + 1);
  const items: (ChatSummary & { sortKey: number })[] = [];
  for (const c of chats) {
    const a = acc.get(c.accountId);
    if (!a) continue;
    const key = `${c.accountId}/${c.chatId}`;
    const g = c.kind === 'group' ? group.get(key) : undefined;
    if (c.kind === 'group' && !g) continue;
    const peer = c.kind === 'dm' ? user.get(`${c.accountId}/${c.peerId}`) : undefined;
    items.push({
      accountId: c.accountId,
      chatId: c.chatId,
      kind: c.kind,
      title: c.kind === 'group' ? (g?.state?.name ?? null) : c.kind === 'dm' ? (peer?.name ?? null) : null,
      peerId: c.kind === 'dm' ? c.peerId : null,
      peerRemoved: peer?.removed ?? false,
      peerRevoked: !!peer?.revoked,
      familyName: a.familyName,
      pinned: c.kind === 'self',
      member: g ? g.member : true,
      lastMessage: c.last
        ? {
            senderId: c.last.senderId,
            outgoing: c.last.senderId === a.userId,
            kind: c.last.kind,
            body: c.last.body,
            time: c.last.time,
            media: c.last.media ?? null,
          }
        : null,
      lastTime: c.last?.time ?? null,
      unread: c.unread,
      pending: pending.get(key) ?? 0,
      draft: draft.get(key) ?? null,
      sortKey: c.last?.time ?? c.createdAt,
    });
  }
  items.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.sortKey - x.sortKey);
  return items.map(({ sortKey: _sortKey, ...rest }) => rest);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The group view of one chat (null when it is not a known group). */
export async function groupView(db: CoreDb, accountId: string, chatId: string): Promise<GroupView | null> {
  const g: GroupRow | undefined = await db.groups.get([accountId, chatId]);
  if (!g) return null;
  const account = await db.accounts.get(accountId);
  const me = account?.userId ?? '';
  const users = new Map((await db.users.where('accountId').equals(accountId).toArray()).map((u) => [u.userId, u]));
  const s = g.state;
  const members: GroupMemberView[] = (s?.members ?? []).map((m) => {
    const u: UserRow | undefined = users.get(m.userId);
    return {
      userId: m.userId,
      name: u?.name ?? null,
      isMe: m.userId === me,
      isOwner: m.userId === s?.owner,
      removed: u?.removed ?? false,
      revoked: !!u?.revoked,
      avatar: u?.avatar ?? null,
      keyMismatch: !!u && (!sameBytes(u.signPub, m.signPub) || !sameBytes(u.boxPub, m.boxPub)),
    };
  });
  const secret = s ? await db.epochKeys.get([accountId, chatId, s.epoch]) : undefined;
  const pending = await db.groupPending.get([accountId, chatId]);
  const ownerRow = s ? users.get(s.owner) : undefined;
  const meInState = !!s?.members.some((m) => m.userId === me);
  return {
    accountId,
    chatId,
    name: s?.name ?? null,
    owner: s?.owner ?? null,
    isOwner: s?.owner === me,
    version: s?.version ?? null,
    epoch: s?.epoch ?? null,
    members,
    member: g.member,
    left: g.left,
    canSend: g.member && meInState && !!secret && !g.broken,
    needKey: g.needKey,
    broken: g.broken,
    mismatch: s && g.server && g.server.version === s.version ? compareGroupMembers(s, g.server.members) : null,
    pendingChange: pending ? { type: pending.op.type, error: pending.error } : null,
    frozen: !!ownerRow && (ownerRow.removed || !!ownerRow.revoked),
  };
}

/** Fingerprint of a user row's current keys. */
export function userFingerprint(u: UserRow): string {
  return fingerprint(u);
}
