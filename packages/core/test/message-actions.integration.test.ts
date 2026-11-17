// Message actions against a real fcd: edit, reactions and delete for everyone
// between two accounts (in a direct chat and in a group with the owner
// deleting someone else's message), the server's zeroed record after a
// restart, a new device that only sees the deleted record, and forwarding a
// file into a group under a new key.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type AccountView, type CoreOptions, type FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { until, type Readable } from '../src/util/readable.ts';
import type { MessageView } from '../src/views.ts';
import { Fcd } from './integration/fcd.ts';
import { eventually, FAST, memDb } from './support/helpers.ts';

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 15_000): Promise<T> {
  return Promise.race([until(store, predicate), new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

const fcd = new Fcd();
const cores: FamilyChatCore[] = [];

function core(options: Partial<CoreOptions> = {}): FamilyChatCore {
  const c = createCore({ db: memDb(), ...FAST, ...options });
  cores.push(c);
  return c;
}

function view(x: FamilyChatCore, acc: AccountView, chat: string, pred: (l: MessageView[]) => boolean): Promise<MessageView[]> {
  return waitFor(x.chat(acc.id, chat).messages, pred);
}

/** GET /v1/events with the account's own token (raw, to see what the server stores). */
async function rawEvents(x: FamilyChatCore, acc: AccountView): Promise<{ gseq: number; kind: string; deleted?: boolean; body?: string; notice?: { type: string } }[]> {
  const row = (await x.db.accounts.get(acc.id))!;
  const res = await fetch(`${fcd.url}/v1/events?after=0`, { headers: { Authorization: `Bearer ${row.token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: never[] }).events;
}

let a: FamilyChatCore;
let b: FamilyChatCore;
let accA: AccountView;
let accB: AccountView;
let chat = '';

beforeAll(async () => {
  await fcd.start();
});

afterAll(async () => {
  for (const x of cores.splice(0)) await x.close().catch(() => undefined);
  await fcd.dispose();
});

describe('message actions against fcd', () => {
  it('edit and reactions between two accounts', async () => {
    a = core();
    b = core();
    await a.start();
    await b.start();
    accA = await a.setUpFamily({ serverUrl: fcd.url, serverCode: fcd.adminCode, name: 'Мама' });
    accB = await b.join({ serverUrl: fcd.url, code: { invite: (await a.admin.createInvite(accA.id)).code }, name: 'Папа' });
    await a.refreshMembers(accA.id);
    chat = await a.openChat(accA.id, accB.userId);

    const id = await a.send(accA.id, chat, 'Встречаемся в шесть');
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === id));
    await a.editMessage(accA.id, chat, id, 'Встречаемся в семь');
    const lb = await view(b, accB, chat, (l) => l.some((m) => m.msgId === id && m.body === 'Встречаемся в семь'));
    expect(lb.find((m) => m.msgId === id)!.edited).toBe(true);

    await b.react(accB.id, chat, accA.userId, id, '👍', true);
    await a.react(accA.id, chat, accA.userId, id, '👍', true);
    await b.react(accB.id, chat, accA.userId, id, '😂', true);
    for (const [x, acc] of [
      [a, accA],
      [b, accB],
    ] as const) {
      const l = await view(x, acc, chat, (v) => {
        const r = v.find((m) => m.msgId === id)?.reactions ?? [];
        return r.length === 2 && r[0]!.count === 2;
      });
      expect(l.find((m) => m.msgId === id)!.reactions!.map((r) => [r.emoji, r.count])).toEqual([
        ['👍', 2],
        ['😂', 1],
      ]);
    }
    await b.react(accB.id, chat, accA.userId, id, '😂', false);
    await view(a, accA, chat, (v) => v.find((m) => m.msgId === id)?.reactions?.length === 1);
    // The edit is searchable, the old text is not.
    expect((await a.searchChat(accA.id, chat, 'семь')).hits.map((h) => h.msgId)).toEqual([id]);
    expect((await b.searchChat(accB.id, chat, 'шесть')).hits).toEqual([]);
  });

  it('delete for everyone: the encrypted delete, then the zeroed record and the notice; survives a restart', async () => {
    const id = await a.sendMessage(accA.id, chat, {
      text: 'с файлом, удалю',
      attachments: [{ data: new Blob([new Uint8Array([5, 6, 7])]), name: 'x.bin', mime: 'application/octet-stream' }],
    });
    await view(a, accA, chat, (l) => l.some((m) => m.msgId === id && m.status === 'on-server'));
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === id));
    const blobId = (await a.db.blobs.toArray()).find((x) => x.msgId === id)!.blobId;
    const gseq = (await a.db.messages.get([accA.id, accA.userId, id]))!.gseq;

    await a.deleteForEveryone(accA.id, chat, accA.userId, id);
    await view(b, accB, chat, (l) => l.find((m) => m.msgId === id)?.kind === 'deleted');
    await eventually(async () => (await a.db.outbox.count()) === 0, 15_000, 'server clean-up');
    // On the server: the record is zeroed, a notice went out, the upload is gone.
    const ev = await rawEvents(b, accB);
    expect(ev.find((e) => e.gseq === gseq)).toMatchObject({ kind: 'event', deleted: true, body: '' });
    expect(ev.some((e) => e.kind === 'notice' && e.notice?.type === 'event_deleted')).toBe(true);
    const row = (await a.db.accounts.get(accA.id))!;
    const blob = await fetch(`${fcd.url}/v1/blobs/${blobId}`, { headers: { Authorization: `Bearer ${row.token}` } });
    expect(blob.status).toBe(404);
    // B's local copy of the text and the file are gone too.
    expect(await b.db.events.get([accB.id, accA.userId, id])).toBeUndefined();
    expect((await b.db.blobs.toArray()).some((x) => x.msgId === id)).toBe(false);

    // After a restart of the server the record is still deleted.
    await a.stop();
    await b.stop();
    await fcd.stop();
    await fcd.start();
    await a.start();
    await b.start();
    const after = await rawEvents(a, accA);
    expect(after.find((e) => e.gseq === gseq)).toMatchObject({ deleted: true, body: '' });

    // A new device of B (restored by phrase) gets the zeroed record and the delete: a quiet line.
    const fresh = core();
    await fresh.start();
    const accF = await fresh.restore({ serverUrl: fcd.url, phrase: await b.recoveryPhrase(accB.userId) });
    const lf = await view(fresh, accF, chat, (l) => l.some((m) => m.msgId === id) && l.some((m) => m.body === 'Встречаемся в семь'));
    expect(lf.find((m) => m.msgId === id)).toMatchObject({ kind: 'deleted', body: '' });
    expect(lf.find((m) => m.body === 'Встречаемся в семь')!.edited).toBe(true);
  });

  it('a group owner deletes a member message for everyone; forwarding a file into the group', async () => {
    const g = await a.createGroup(accA.id, 'Семья', [accB.userId]);
    await waitFor(b.group(accB.id, g), (v) => !!v?.canSend);
    const fromB = await b.send(accB.id, g, 'сообщение папы');
    await view(a, accA, g, (l) => l.some((m) => m.msgId === fromB));
    // B is not the owner: he cannot delete A's messages for everyone.
    const fromA = await a.send(accA.id, g, 'сообщение мамы');
    await view(b, accB, g, (l) => l.some((m) => m.msgId === fromA));
    await expect(b.deleteForEveryone(accB.id, g, accA.userId, fromA)).rejects.toSatisfy((e) => isCoreError(e, 'not-allowed'));
    await a.deleteForEveryone(accA.id, g, accB.userId, fromB);
    await view(b, accB, g, (l) => l.find((m) => m.msgId === fromB)?.kind === 'deleted');
    await eventually(async () => (await a.db.outbox.count()) === 0, 15_000, 'server clean-up');
    const ev = await rawEvents(b, accB);
    expect(ev.filter((e) => e.deleted).length).toBe(2);

    // Forward a file from the direct chat into the group: a new blob with a new key, readable by B.
    const src = await a.sendMessage(accA.id, chat, { attachments: [{ data: new Blob([new Uint8Array([1, 2, 3, 4])]), name: 'f.bin', mime: 'application/octet-stream' }] });
    await view(a, accA, chat, (l) => l.some((m) => m.msgId === src && m.status === 'on-server'));
    const [copy] = await a.forwardMessage(accA.id, chat, accA.userId, src, [g]);
    const lg = await view(b, accB, g, (l) => l.some((m) => m.msgId === copy));
    const att = lg.find((m) => m.msgId === copy)!.attachments![0]!;
    const orig = (await a.db.messages.get([accA.id, accA.userId, src]))!.attachments![0]!;
    expect(att.blobId).not.toBe(orig.blob.id);
    await b.downloadAttachment(accB.id, att.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.status === 'done', 15_000, 'download');
    expect(new Uint8Array(await (await b.attachmentBlob(accB.id, att.blobId)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(lg.find((m) => m.msgId === copy)!.fwd).toBe(true);
  });
});
