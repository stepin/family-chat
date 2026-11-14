// Web Push: register and remove the device's subscription, and turn a received
// push payload ({chatId, gseq}, docs/API.md section 6) into what a service
// worker should show. The core never calls PushManager itself (that is DOM /
// service worker API); the UI subscribes and hands over `subscription.toJSON()`.

import type { PushSubscriptionInput } from './api/types.ts';
import { commitEvents, decodeEvents, type AccountRuntimeLike } from './apply.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';

/** Setting key: show message text in notifications (default false, docs/PLAN-v2.md 7.7). */
export const SETTING_PUSH_SHOW_TEXT = 'push.showText';

export async function registerPush(rt: AccountRuntimeLike, sub: PushSubscriptionInput): Promise<void> {
  await rt.session.call((t) => rt.session.transport.putPush(t, sub));
  await rt.ctx.db.accounts.update(rt.session.accountId, { pushRegistered: true });
  void rt.ctx.diag.info('push', 'push subscription registered', rt.session.accountId);
}

export async function unregisterPush(rt: AccountRuntimeLike): Promise<void> {
  await rt.session.call((t) => rt.session.transport.deletePush(t));
  await rt.ctx.db.accounts.update(rt.session.accountId, { pushRegistered: false });
  void rt.ctx.diag.info('push', 'push subscription removed', rt.session.accountId);
}

export type PushNotice =
  | {
      readonly kind: 'message';
      readonly accountId: string;
      readonly chatId: string;
      readonly gseq: number;
      readonly senderId: string;
      /** From the sender's verified profile; null if unknown. */
      readonly senderName: string | null;
      readonly familyName: string;
      /** Message text, only when the person enabled it (SETTING_PUSH_SHOW_TEXT). */
      readonly text: string | null;
      /** 'dm', 'self' (the chat with myself, from another own device) or 'group'. */
      readonly chatKind: 'dm' | 'self' | 'group';
      /** Group name from the verified state; the peer's name for a direct chat; null for 'self' or unknown. */
      readonly chatName: string | null;
      /** Number of attachments (the text may be empty). */
      readonly attachments: number;
    }
  /** Could not fetch or decrypt: show a generic "new message". */
  | {
      readonly kind: 'generic';
      readonly accountId: string | null;
      readonly chatId: string | null;
      readonly familyName: string | null;
      readonly chatName: string | null;
    };

function parsePayload(payload: unknown): { chatId: string; gseq: number } | undefined {
  let v = payload;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const { chatId, gseq } = v as { chatId?: unknown; gseq?: unknown };
  if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > 64) return undefined;
  if (typeof gseq !== 'number' || !Number.isSafeInteger(gseq) || gseq < 1) return undefined;
  return { chatId, gseq };
}

/**
 * Fetches, verifies and stores the event a push points to, and says what to
 * show. Never throws: on any failure the answer is `generic`.
 */
export async function handlePush(
  ctx: CoreContext,
  payload: unknown,
  runtimeFor: (accountId: string) => Promise<AccountRuntimeLike>,
): Promise<PushNotice> {
  const generic = (accountId: string | null = null, chatId: string | null = null, familyName: string | null = null, chatName: string | null = null): PushNotice => ({
    kind: 'generic',
    accountId,
    chatId,
    familyName,
    chatName,
  });
  const p = parsePayload(payload);
  if (!p) {
    void ctx.diag.warn('push', 'push payload is not {chatId, gseq}');
    return generic();
  }
  const { db } = ctx;
  try {
    const chats = await db.chats.where('chatId').equals(p.chatId).toArray();
    const accounts = chats.length > 0 ? chats.map((c) => c.accountId) : (await db.accounts.toArray()).map((a) => a.id);
    let fallback = generic(null, p.chatId);
    for (const accountId of accounts) {
      const account = await db.accounts.get(accountId);
      if (!account || account.status !== 'active') continue;
      const rt = await runtimeFor(accountId);
      const chat = chats.find((c) => c.accountId === accountId);
      const group = await db.groups.get([accountId, p.chatId]);
      const chatName = group
        ? (group.state?.name ?? null)
        : chat && chat.kind === 'dm'
          ? ((await db.users.get([accountId, chat.peerId]))?.name ?? null)
          : null;
      fallback = generic(accountId, p.chatId, account.familyName, chatName);
      try {
        let event = await db.events.where('[accountId+gseq]').equals([accountId, p.gseq]).first();
        if (!event) {
          const page = await rt.session.call((t) =>
            rt.session.transport.chatEvents(t, p.chatId, { before: p.gseq + 1, limit: 1 }),
          );
          const ev = page.events.find((e) => e.gseq === p.gseq && e.chatId === p.chatId);
          if (!ev) return fallback;
          const items = await decodeEvents(rt, [ev]);
          if (items.length === 0) return fallback;
          await commitEvents(ctx, accountId, rt.session.userId, items);
          event = await db.events.where('[accountId+gseq]').equals([accountId, p.gseq]).first();
          if (!event) return fallback;
        }
        if (event.chatId !== p.chatId) return fallback;
        const msg = await db.messages.get([accountId, event.senderId, event.msgId]);
        if (!msg || msg.kind !== 'msg') return fallback;
        const sender = await db.users.get([accountId, msg.senderId]);
        const groupNow = group ?? (await db.groups.get([accountId, p.chatId]));
        const nameNow = groupNow ? (groupNow.state?.name ?? null) : chatName;
        const showText = (await db.settings.get(SETTING_PUSH_SHOW_TEXT))?.value === true;
        return {
          kind: 'message',
          accountId,
          chatId: p.chatId,
          gseq: p.gseq,
          senderId: msg.senderId,
          senderName: sender?.name ?? null,
          familyName: account.familyName,
          text: showText ? msg.body : null,
          chatKind: groupNow ? 'group' : chat?.kind === 'self' || msg.chatId === rt.directory.selfChatId() ? 'self' : 'dm',
          chatName: nameNow,
          attachments: msg.attachments?.length ?? 0,
        };
      } catch (e) {
        void ctx.diag.warn('push', `push for chat ${p.chatId} gseq=${p.gseq} not decrypted: ${describeError(e)}`, accountId);
      }
    }
    return fallback;
  } catch (e) {
    void ctx.diag.warn('push', `push handling failed: ${describeError(e)}`);
    return generic(null, p.chatId);
  }
}
