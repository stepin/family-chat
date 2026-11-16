// Parsing of answers: notices in event pages, groups, keys, blobs,
// avatars, the invitation check and raw byte answers.

import { describe, expect, it } from 'vitest';
import { isApiError } from '../src/api/errors.ts';
import { Transport, type FetchFn } from '../src/api/transport.ts';

function client(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { t: new Transport({ baseUrl: 'https://fc.test', fetch }), calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const raw = (bytes: Uint8Array) => new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
const U = 'mmg42klgyqzwneiskrelxms3j4';

describe('Transport', () => {
  it('event pages carry notices; unknown notice types and kinds are skipped', async () => {
    const { t } = client(() =>
      json({
        events: [
          { kind: 'event', gseq: 1, time: 1, chatId: 'c', senderId: U, devId: 'd', epoch: 0, msgId: 'm', body: 'AAEC' },
          { kind: 'notice', gseq: 2, time: 2, chatId: 'g', notice: { type: 'member_left', userId: U, members: [], version: 3, epoch: 1 } },
          { kind: 'notice', gseq: 3, time: 3, chatId: 'g', notice: { type: 'group_state', by: U, owner: U, members: [U], version: 4, epoch: 2, added: [], removed: [U] } },
          { kind: 'notice', gseq: 4, time: 4, chatId: 'g', notice: { type: 'future_thing', x: 1 } },
          { kind: 'notice', gseq: 5, time: 5, chatId: 'g', notice: { type: 'group_created', by: U } },
          { kind: 'something', gseq: 6 },
          { kind: 'notice', gseq: 7, time: 7, chatId: 'g', notice: { type: 'member_revoked', userId: U } },
        ],
        cursor: 7,
        more: false,
        oldestGseq: 1,
        oldestTime: 123,
      }),
    );
    const p = await t.events('tok');
    expect(p.events.map((e) => e.gseq)).toEqual([1]);
    expect(p.notices.map((n) => n.gseq)).toEqual([2, 3, 7]);
    expect(p.notices[1]!.notice).toMatchObject({ type: 'group_state', removed: [U] });
    expect(p.oldestTime).toBe(123);
  });

  it('chats of both kinds, group requests and keys', async () => {
    const chat = { chatId: 'g', kind: 'group', members: [U], owner: U, version: 2, epoch: 1, createdAt: 1, lastGseq: null, lastTime: null };
    const { t, calls } = client((url, init) => {
      if (url.endsWith('/v1/chats') && init.method === 'GET') return json({ chats: [chat, { ...chat, kind: 'dm', owner: null, version: null }] });
      if (url.endsWith('/v1/chats')) return json(chat, 201);
      if (url.includes('/state/')) return raw(new Uint8Array([1, 2, 3]));
      if (url.endsWith('/state')) return json(chat);
      if (url.includes('/leave')) return new Response(null, { status: 204 });
      return json({ keys: [{ n: 1, chatId: 'g', epoch: 1, version: 2, time: 5, key: '{}' }], cursor: 1, more: false });
    });
    const list = await t.chats('tok');
    expect(list.map((c) => c.kind)).toEqual(['group', 'dm']);
    expect(list[1]!.version).toBeNull();
    await t.createGroup('tok', { chatId: 'g', state: new Uint8Array([255]), members: [U], epoch: 0, keys: [{ userId: U, key: 'k' }] });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ chatId: 'g', state: '_w', members: [U], epoch: 0, keys: [{ userId: U, key: 'k' }] });
    expect(await t.changeGroup('tok', 'g', { baseVersion: 1, state: new Uint8Array([1]), members: [U], owner: U, epoch: 1, keys: [] })).toMatchObject({ version: 2 });
    expect(await t.groupState('tok', 'g', 2)).toEqual(new Uint8Array([1, 2, 3]));
    await t.leaveGroup('tok', 'g');
    expect((await t.keys('tok', { after: 0 })).keys[0]).toMatchObject({ n: 1, version: 2 });
  });

  it('errors carry `version`; a JSON answer where bytes are expected is unexpected', async () => {
    const { t } = client((url) =>
      url.endsWith('/state') ? json({ error: 'stale_version', message: 'x', version: 7 }, 409) : json({ not: 'bytes' }),
    );
    await expect(t.changeGroup('tok', 'g', { baseVersion: 1, state: new Uint8Array([1]), members: [], owner: U, epoch: 0, keys: [] })).rejects.toSatisfy(
      (e) => isApiError(e, 'stale_version') && e.details.version === 7,
    );
    await expect(t.groupState('tok', 'g', 1)).rejects.toSatisfy((e) => isApiError(e, 'unexpected_response'));
  });

  it('blobs, avatars, revocation, invitation check', async () => {
    const { t, calls } = client((url, init) => {
      if (url.includes('/v1/blobs/') && init.method === 'PUT') return json({ blobId: 'b', part: 0, size: 3, total: 3 });
      if (/\/v1\/blobs\/b\/0$/.test(url)) return raw(new Uint8Array([9]));
      if (url.endsWith('/v1/blobs/b') && init.method === 'GET') return json({ blobId: 'b', owner: U, createdAt: 1, parts: [{ part: 0, size: 3 }], total: 3, maxBytes: 10 });
      if (url.endsWith('/v1/blobs/b')) return new Response(null, { status: 204 });
      if (url.endsWith('/v1/me/avatar')) return json({ sha256: 'h', type: 'image/webp' });
      if (url.includes('/avatar/')) return new Response(new Uint8Array([7]), { headers: { 'Content-Type': 'image/jpeg' } });
      if (url.endsWith('/v1/revoke')) return new Response(null, { status: 204 });
      return json({ status: 'expired', familyName: 'F', createdBy: { userId: U, name: null }, createdAt: 1, expiresAt: 2 });
    });
    expect(await t.putBlobPart('tok', 'b', 0, new Uint8Array(3))).toMatchObject({ total: 3 });
    expect(await t.getBlobPart('tok', 'b', 0)).toEqual(new Uint8Array([9]));
    expect((await t.blobInfo('tok', 'b')).parts).toEqual([{ part: 0, size: 3 }]);
    await t.deleteBlob('tok', 'b');
    expect(await t.putAvatar('tok', new Uint8Array([1]))).toEqual({ sha256: 'h', type: 'image/webp' });
    expect(await t.getAvatar('tok', U, 'h')).toEqual(new Uint8Array([7]));
    await t.revoke({ payload: 'p', sig: 's' });
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(await t.inviteCheck('code')).toMatchObject({ status: 'expired', createdBy: { name: null } });
  });

  it('rejects malformed answers', async () => {
    const { t } = client((url) => {
      if (url.endsWith('/v1/chats')) return json({ chats: [{ chatId: 'x', kind: 'weird', members: [], epoch: 0, createdAt: 0 }] });
      if (url.endsWith('/v1/me/avatar')) return json({ sha256: 'h', type: 'image/png' });
      return json({ status: 'maybe', familyName: 'F', createdBy: { userId: U, name: null }, createdAt: 1, expiresAt: 2 });
    });
    await expect(t.chats('tok')).rejects.toSatisfy((e) => isApiError(e, 'unexpected_response'));
    await expect(t.putAvatar('tok', new Uint8Array([1]))).rejects.toSatisfy((e) => isApiError(e, 'unexpected_response'));
    await expect(t.inviteCheck('c')).rejects.toSatisfy((e) => isApiError(e, 'unexpected_response'));
  });
});
