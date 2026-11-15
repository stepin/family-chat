// Independent check of docs/vectors/*.json using only Node's built-in modules.
// It does not import @family-chat/protocol, @noble/* or @scure/*: every primitive comes from
// node:crypto (OpenSSL) and the formats are re-implemented here from docs/PROTOCOL.md.
//
// Run: pnpm --filter @family-chat/protocol run vectors:verify

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/vectors');
const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

let checks = 0;
let failures = 0;
function check(cond, what) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}
const eq = (a, b, what) => check(a === b, `${what}: expected ${b}, got ${a}`);

// ---- bytes and codecs ----
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Buffer.from(h, 'hex');
const utf8 = (s) => Buffer.from(s, 'utf8');
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const lp = (b) => Buffer.concat([u32(b.length), Buffer.from(typeof b === 'string' ? utf8(b) : b)]);
const lps = (s) => lp(utf8(s));
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function b32enc(bytes) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('base32 char');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new Error('base32 trailing bits');
  return Buffer.from(out);
}
const b64enc = (b) => Buffer.from(b).toString('base64url');
function b64dec(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('base64url');
  const b = Buffer.from(s, 'base64url');
  if (b64enc(b) !== s) throw new Error('base64url not canonical');
  return b;
}

// ---- primitives from node:crypto ----
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hkdf = (ikm, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
const PKCS8_ED = unhex('302e020100300506032b657004220420');
const PKCS8_X = unhex('302e020100300506032b656e04220420');
const SPKI_ED = unhex('302a300506032b6570032100');
const SPKI_X = unhex('302a300506032b656e032100');
const edPriv = (seed) => crypto.createPrivateKey({ key: cat(PKCS8_ED, seed), format: 'der', type: 'pkcs8' });
const xPriv = (sk) => crypto.createPrivateKey({ key: cat(PKCS8_X, sk), format: 'der', type: 'pkcs8' });
const edPub = (pub) => crypto.createPublicKey({ key: cat(SPKI_ED, pub), format: 'der', type: 'spki' });
const xPub = (pub) => crypto.createPublicKey({ key: cat(SPKI_X, pub), format: 'der', type: 'spki' });
const rawPub = (priv) => crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
const edSign = (seed, msg) => crypto.sign(null, msg, edPriv(seed));
const edVerify = (pub, msg, sig) => {
  try {
    return crypto.verify(null, msg, edPub(pub), sig);
  } catch {
    return false;
  }
};
function x25519(sk, pub) {
  const out = crypto.diffieHellman({ privateKey: xPriv(sk), publicKey: xPub(pub) });
  if (out.every((b) => b === 0)) throw new Error('all-zero shared secret');
  return out;
}
function gcmEncrypt(key, nonce, aad, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return cat(c.update(plain), c.final(), c.getAuthTag());
}
function gcmDecrypt(key, nonce, aad, data) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(data.subarray(data.length - 16));
  return cat(d.update(data.subarray(0, data.length - 16)), d.final());
}

// ---- BIP39 (256-bit entropy, 8-bit checksum, no stretching) ----
const wordText = readFileSync(join(dir, 'bip39-english.txt'), 'utf8');
const WORDS = wordText.trim().split('\n');
function seedToPhrase(seed) {
  const bits = [...cat(seed, sha256(seed).subarray(0, 1))].map((b) => b.toString(2).padStart(8, '0')).join('');
  const words = [];
  for (let i = 0; i < 24; i++) words.push(WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  return words.join(' ');
}
function phraseToSeed(phrase) {
  const words = phrase.normalize('NFKD').toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length !== 24) throw Object.assign(new Error(), { code: 'phrase-word-count' });
  const unknown = words.map((w, i) => (WORDS.includes(w) ? 0 : i + 1)).filter(Boolean);
  if (unknown.length) throw Object.assign(new Error(), { code: 'phrase-unknown-word', positions: unknown });
  const bits = words.map((w) => WORDS.indexOf(w).toString(2).padStart(11, '0')).join('');
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  if (parseInt(bits.slice(256), 2) !== sha256(seed)[0]) throw Object.assign(new Error(), { code: 'phrase-checksum' });
  return seed;
}

// ---- identity.json ----
const idv = load('identity.json');
eq(sha256(utf8(wordText)).toString('hex'), idv.bip39Wordlist.sha256, 'BIP39 English word list SHA-256');
eq(WORDS.length, 2048, 'word count');
for (const p of idv.phrases) {
  eq(seedToPhrase(unhex(p.seedHex)), p.phrase, `phrase of ${p.seedHex.slice(0, 8)}…`);
  eq(hex(phraseToSeed(p.phrase)), p.seedHex, `seed of phrase ${p.phrase.slice(0, 12)}…`);
}
// Official BIP39 known answers (trezor/python-mnemonic vectors).
eq(seedToPhrase(Buffer.alloc(32)), 'abandon '.repeat(23) + 'art', 'BIP39 known answer, zero entropy');
eq(seedToPhrase(Buffer.alloc(32, 0xff)), 'zoo '.repeat(23) + 'vote', 'BIP39 known answer, ff entropy');

function fingerprint(signPub, boxPub) {
  const h = sha256(cat(utf8('fc/v1/fingerprint\n'), lp(signPub), lp(boxPub)));
  const groups = [];
  for (let g = 0; g < 6; g++) groups.push(String(h.readUIntBE(g * 5, 5) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

const users = {};
for (const [name, u] of Object.entries(idv.users)) {
  const seed = unhex(u.seedHex);
  const signSecret = hkdf(seed, utf8('fc/v1/sign'));
  const boxSecret = hkdf(seed, utf8('fc/v1/box'));
  const selfKey = hkdf(seed, utf8('fc/v1/self'));
  const signPub = rawPub(edPriv(signSecret));
  const boxPub = rawPub(xPriv(boxSecret));
  eq(seedToPhrase(seed), u.phrase, `${name} phrase`);
  eq(hex(signSecret), u.signSecretHex, `${name} signSecret`);
  eq(hex(boxSecret), u.boxSecretHex, `${name} boxSecret`);
  eq(hex(selfKey), u.selfKeyHex, `${name} selfKey`);
  eq(hex(signPub), u.signPubHex, `${name} signPub`);
  eq(hex(boxPub), u.boxPubHex, `${name} boxPub`);
  const userId = b32enc(sha256(signPub).subarray(0, 16));
  eq(userId, u.userId, `${name} userId`);
  eq(userId.length, 26, `${name} userId length`);
  eq(fingerprint(signPub, boxPub), u.fingerprint, `${name} fingerprint`);
  users[name] = { signSecret, boxSecret, signPub, boxPub, userId };
}

// ---- envelopes.json ----
function openEnvelope(text, kind, signPub) {
  const env = JSON.parse(text);
  if (Object.keys(env).length !== 2 || typeof env.payload !== 'string' || typeof env.sig !== 'string') {
    return { error: 'malformed' };
  }
  const payload = b64dec(env.payload);
  const sig = b64dec(env.sig);
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  if (json.v !== 1) return { error: 'unsupported-version' };
  if (kind === 'identity') {
    const pub = b64dec(json.signPub);
    if (b32enc(sha256(pub).subarray(0, 16)) !== json.userId) return { error: 'user-id-mismatch' };
    signPub = pub;
  } else if (json.userId !== b32enc(sha256(signPub).subarray(0, 16))) {
    return { error: 'user-id-mismatch' };
  }
  const input = cat(utf8(`fc/v1/${kind}\n`), payload);
  if (!edVerify(signPub, input, sig)) return { error: 'bad-signature' };
  return { payload, sig, json, input };
}

const envv = load('envelopes.json');
for (const e of envv.envelopes) {
  const alice = users[e.signer];
  const r = openEnvelope(e.envelope, e.kind, alice.signPub);
  check(!r.error, `${e.kind} envelope verifies (${r.error ?? 'ok'})`);
  if (r.error) continue;
  eq(r.payload.toString('utf8'), e.payloadText, `${e.kind} payload text`);
  eq(hex(r.input), e.signingInputHex, `${e.kind} signing input`);
  eq(b64enc(edSign(alice.signSecret, r.input)), JSON.parse(e.envelope).sig, `${e.kind} deterministic signature`);
  eq(r.json.userId, alice.userId, `${e.kind} userId`);
  eq(e.envelope, JSON.stringify({ payload: b64enc(r.payload), sig: b64enc(r.sig) }), `${e.kind} wire form`);
  for (const [k, v] of Object.entries(e.payloadJson)) eq(r.json[k], v, `${e.kind} field ${k}`);
  if (e.kind === 'identity') {
    eq(r.json.signPub, b64enc(alice.signPub), 'identity signPub');
    eq(r.json.boxPub, b64enc(alice.boxPub), 'identity boxPub');
    eq(Object.keys(r.json).join(','), 'v,userId,signPub,boxPub,created', 'identity field order');
  }
  if (e.kind === 'profile') eq(Object.keys(r.json).join(','), 'v,userId,name,avatar,rev,updated', 'profile field order');
  if (e.kind === 'auth') eq(Object.keys(r.json).join(','), 'v,userId,serverId,nonce,devId', 'auth field order');
}
for (const [name, text] of Object.entries(envv.identities)) {
  const r = openEnvelope(text, 'identity');
  check(!r.error && r.json.userId === users[name].userId, `identity of ${name} verifies`);
}

// ---- dm.json ----
const dmv = load('dm.json');
for (const c of dmv.chats) {
  const me = users[c.me];
  const peer = users[c.peer];
  const shared = x25519(me.boxSecret, peer.boxPub);
  eq(hex(shared), c.sharedSecretHex, `dm ${c.me}-${c.peer} shared secret`);
  eq(hex(x25519(peer.boxSecret, me.boxPub)), c.sharedSecretHex, `dm ${c.me}-${c.peer} shared secret, other side`);
  const [lo, hi] = [me.userId, peer.userId].sort();
  const info = cat(utf8('fc/v1/dm'), lps(c.serverId), lps(lo), lps(hi));
  eq(hex(info), c.infoHex, `dm ${c.me}-${c.peer} info`);
  const dmKey = hkdf(shared, info);
  eq(hex(dmKey), c.dmKeyHex, `dm ${c.me}-${c.peer} dmKey`);
  eq(hex(hkdf(dmKey, utf8('fc/v1/enc'))), c.encKeyHex, `dm ${c.me}-${c.peer} encKey`);
  const chatId = b32enc(sha256(utf8(`fc/v1/dm\n${c.serverId}\n${lo}\n${hi}`)).subarray(0, 16));
  eq(chatId, c.chatId, `dm ${c.me}-${c.peer} chatId`);
}
{
  let rejected = false;
  try {
    x25519(users.alice.boxSecret, unhex(dmv.zeroPeer.peerBoxPubHex));
  } catch {
    rejected = true;
  }
  check(rejected, 'all-zero X25519 shared secret is rejected');
}

// ---- event.json ----
const serverTag = (s) => sha256(cat(utf8('fc/v1/server-tag\n'), lps(s))).subarray(0, 8);
const chatTag = (s) => sha256(cat(utf8('fc/v1/chat-tag\n'), lps(s))).subarray(0, 8);
const header = (epoch, serverId, chatId, msgId) =>
  cat(utf8('FC1'), [1], u32(epoch), serverTag(serverId), chatTag(chatId), msgId);
const aadOf = (h, serverId, chatId) => cat(h, lps(serverId), lps(chatId));
const sigInputOf = (serverId, chatId, epoch, msgId, senderId, payload) =>
  cat(utf8('fc/v1/event\n'), lps(serverId), lps(chatId), u32(epoch), lp(msgId), lp(senderId), lp(payload));

const ev = load('event.json');
{
  const i = ev.inputs;
  const author = users[i.author];
  const msgId = b32dec(i.msgId);
  const senderId = b32dec(author.userId);
  const payload = utf8(i.payloadText);
  const h = header(i.epoch, i.serverId, i.chatId, msgId);
  eq(hex(h), ev.intermediate.headerHex, 'event header');
  const aad = aadOf(h, i.serverId, i.chatId);
  eq(hex(aad), ev.intermediate.aadHex, 'event AAD');
  const sigInput = sigInputOf(i.serverId, i.chatId, i.epoch, msgId, senderId, payload);
  eq(hex(sigInput), ev.intermediate.signingInputHex, 'event signing input');
  const sig = edSign(author.signSecret, sigInput);
  eq(hex(sig), ev.intermediate.sigHex, 'event signature');
  const used = 16 + 64 + 4 + payload.length;
  const plain = Buffer.alloc(Math.ceil(used / 256) * 256);
  cat(senderId, sig, u32(payload.length), payload).copy(plain);
  eq(hex(plain), ev.intermediate.plaintextHex, 'event plaintext');
  const body = cat(h, unhex(i.nonceHex), gcmEncrypt(unhex(i.encKeyHex), unhex(i.nonceHex), aad, plain));
  eq(hex(body), ev.bodyHex, 'event body');
  eq(hex(gcmDecrypt(unhex(i.encKeyHex), unhex(i.nonceHex), aad, unhex(ev.bodyHex).subarray(52))), hex(plain), 'event decrypts');
  eq(JSON.parse(i.payloadText).id, i.msgId, 'payload id equals header id');
}

// ---- negative.json: an independent decoder with the documented check order ----
function decodeEvent(body, ctx, members) {
  if (body.length > 262144) return 'too-large';
  if (body.length < 68 + 256 || (body.length - 68) % 256 !== 0) return 'malformed';
  if (body.subarray(0, 3).toString('latin1') !== 'FC1') return 'malformed';
  if (body[3] !== 1) return 'unsupported-version';
  const h = body.subarray(0, 40);
  if (h.readUInt32BE(4) !== ctx.epoch) return 'wrong-epoch';
  if (!h.subarray(8, 16).equals(serverTag(ctx.serverId))) return 'wrong-server';
  if (!h.subarray(16, 24).equals(chatTag(ctx.chatId))) return 'wrong-chat';
  let plain;
  try {
    plain = gcmDecrypt(unhex(ctx.encKeyHex), body.subarray(40, 52), aadOf(h, ctx.serverId, ctx.chatId), body.subarray(52));
  } catch {
    return 'wrong-key';
  }
  const len = plain.readUInt32BE(80);
  if (len > plain.length - 84) return 'malformed';
  const used = 84 + len;
  if (Math.ceil(used / 256) * 256 !== plain.length) return 'malformed';
  if (!plain.subarray(used).every((b) => b === 0)) return 'malformed';
  const senderId = b32enc(plain.subarray(0, 16));
  const author = members.map((m) => users[m]).find((u) => u.userId === senderId);
  if (!author) return 'unknown-author';
  const payload = plain.subarray(84, used);
  const input = sigInputOf(ctx.serverId, ctx.chatId, ctx.epoch, h.subarray(24, 40), plain.subarray(0, 16), payload);
  if (!edVerify(author.signPub, input, plain.subarray(16, 80))) return 'bad-signature';
  if (JSON.parse(payload.toString('utf8')).id !== b32enc(h.subarray(24, 40))) return 'malformed';
  return 'ok';
}
const neg = load('negative.json');
for (const c of neg.events) eq(decodeEvent(unhex(c.bodyHex), c.context, c.members), c.expectedError, c.name);
for (const c of neg.envelopes) {
  const r = openEnvelope(c.envelope, c.kind, c.signer ? users[c.signer].signPub : undefined);
  eq(r.error ?? 'ok', c.expectedError, c.name);
}
for (const c of neg.phrases) {
  let code = 'ok';
  try {
    phraseToSeed(c.phrase);
  } catch (e) {
    code = e.code;
    if (c.positions) eq(JSON.stringify(e.positions), JSON.stringify(c.positions), `${c.name} positions`);
  }
  eq(code, c.expectedError, c.name);
}
// The positive event must decode with the same decoder.
eq(decodeEvent(unhex(ev.bodyHex), { ...ev.inputs }, ['alice', 'bob']), 'ok', 'positive event decodes');

// =====================================================================================
// M2: HPKE, groups, sealed keys, attachments, archive, revocation, avatar, payloads.
// Everything below again uses node:crypto only. What node:crypto cannot do is noted inline:
// - Ed25519 strictness: OpenSSL verification is not checked here for the small-order and
//   non-canonical rejections the package adds (covered by the package's own tests).
// - X25519 low-order rejection in HPKE: OpenSSL returns an error for an all-zero result,
//   which the code below treats like the package does.
// =====================================================================================

// ---- HPKE (RFC 9180) from HMAC-SHA-256, X25519 and AES-GCM ----
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const i2osp = (n, len) => {
  const b = Buffer.alloc(len);
  for (let i = len - 1; i >= 0 && n > 0; i--) {
    b[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return b;
};
const hkdfExtract = (salt, ikm) => hmac(salt.length ? salt : Buffer.alloc(32), ikm);
function hkdfExpand(prk, info, len) {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let c = 1; out.length < len; c++) {
    t = hmac(prk, cat(t, info, [c]));
    out = cat(out, t);
  }
  return out.subarray(0, len);
}
const KEM_SUITE = cat(utf8('KEM'), i2osp(0x20, 2));
const hpkeSuite = (aead) => cat(utf8('HPKE'), i2osp(0x20, 2), i2osp(1, 2), i2osp(aead, 2));
const lExtract = (suite, salt, label, ikm) => hkdfExtract(salt, cat(utf8('HPKE-v1'), suite, utf8(label), ikm));
const lExpand = (suite, prk, label, info, len) => hkdfExpand(prk, cat(i2osp(len, 2), utf8('HPKE-v1'), suite, utf8(label), info), len);
function deriveKeyPair(ikm) {
  const prk = lExtract(KEM_SUITE, Buffer.alloc(0), 'dkp_prk', ikm);
  const sk = lExpand(KEM_SUITE, prk, 'sk', Buffer.alloc(0), 32);
  return { sk, pk: rawPub(xPriv(sk)) };
}
const kemShared = (dh, enc, pkR) =>
  lExpand(KEM_SUITE, lExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', dh), 'shared_secret', cat(enc, pkR), 32);
function keySchedule(aead, shared, info) {
  const suite = hpkeSuite(aead);
  const ctx = cat([0], lExtract(suite, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)), lExtract(suite, Buffer.alloc(0), 'info_hash', info));
  const secret = lExtract(suite, shared, 'secret', Buffer.alloc(0));
  const nk = aead === 2 ? 32 : 16;
  const c = {
    key: lExpand(suite, secret, 'key', ctx, nk),
    nonce: lExpand(suite, secret, 'base_nonce', ctx, 12),
    exp: lExpand(suite, secret, 'exp', ctx, 32),
    seq: 0,
    aead,
  };
  const nonce = () => {
    const n = Buffer.from(c.nonce);
    const s = i2osp(c.seq, 12);
    for (let i = 0; i < 12; i++) n[i] ^= s[i];
    return n;
  };
  const algo = aead === 2 ? 'aes-256-gcm' : 'aes-128-gcm';
  c.seal = (aad, pt) => {
    const e = crypto.createCipheriv(algo, c.key, nonce());
    e.setAAD(aad);
    const out = cat(e.update(pt), e.final(), e.getAuthTag());
    c.seq++;
    return out;
  };
  c.open = (aad, ct) => {
    const d = crypto.createDecipheriv(algo, c.key, nonce());
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const out = cat(d.update(ct.subarray(0, ct.length - 16)), d.final());
    c.seq++;
    return out;
  };
  c.export = (context, len) => lExpand(suite, c.exp, 'sec', context, len);
  return c;
}
function setupSender(aead, pkR, info, ikmE) {
  const e = deriveKeyPair(ikmE);
  const shared = kemShared(x25519(e.sk, pkR), e.pk, pkR);
  return { enc: e.pk, ctx: keySchedule(aead, shared, info) };
}
const hasDecapsulate = typeof crypto.decapsulate === 'function';
function setupRecipient(aead, enc, skR, info) {
  const pkR = rawPub(xPriv(skR));
  const shared = kemShared(x25519(skR, enc), enc, pkR);
  // Cross-check DHKEM with OpenSSL's own RFC 9180 implementation where Node exposes it (>= 24.7).
  if (hasDecapsulate) eq(hex(crypto.decapsulate(xPriv(skR), enc)), hex(shared), 'DHKEM shared secret (OpenSSL decapsulate)');
  return keySchedule(aead, shared, info);
}

{
  const kat = load('hpke-rfc9180.json');
  const shake = (n) => crypto.createHash('shake128', { outputLength: n }).update(Buffer.alloc(0)).digest();
  for (const v of kat.vectors) {
    const name = `HPKE kem ${v.kem_id} kdf ${v.kdf_id} aead ${v.aead_id}`;
    const r = deriveKeyPair(unhex(v.ikmR));
    eq(hex(r.sk), v.skRm, `${name} skRm`);
    eq(hex(r.pk), v.pkRm, `${name} pkRm`);
    const s = setupSender(v.aead_id, unhex(v.pkRm), unhex(v.info), unhex(v.ikmE));
    eq(hex(s.enc), v.enc, `${name} enc`);
    const rc = setupRecipient(v.aead_id, s.enc, unhex(v.skRm), unhex(v.info));
    const src = shake(600000);
    let off = 0;
    const draw = () => {
      const n = src[off++];
      const b = src.subarray(off, off + n);
      off += n;
      return b;
    };
    const sink = crypto.createHash('shake128', { outputLength: 16 });
    let opened = true;
    for (let i = 0; i < 1000; i++) {
      const aad = draw();
      const pt = draw();
      const ct = s.ctx.seal(aad, pt);
      sink.update(ct);
      opened &&= rc.open(aad, ct).equals(pt);
    }
    check(opened, `${name} recipient opens all 1000 messages`);
    eq(sink.digest('hex'), v.encryptions_accumulated, `${name} accumulated encryptions`);
    off = 0;
    const sink2 = crypto.createHash('shake128', { outputLength: 16 });
    for (let l = 0; l < 1000; l++) {
      const value = s.ctx.export(draw(), l);
      sink2.update(value);
    }
    eq(sink2.digest('hex'), v.exports_accumulated, `${name} accumulated exports`);
  }
}

// ---- groups ----
const gv = load('group.json');
for (const [name, u] of Object.entries(gv.extraUsers)) {
  const seed = unhex(u.seedHex);
  const signSecret = hkdf(seed, utf8('fc/v1/sign'));
  const boxSecret = hkdf(seed, utf8('fc/v1/box'));
  const signPub = rawPub(edPriv(signSecret));
  users[name] = { signSecret, boxSecret, signPub, boxPub: rawPub(xPriv(boxSecret)), userId: b32enc(sha256(signPub).subarray(0, 16)) };
  eq(users[name].userId, u.userId, `${name} userId`);
}
const userIdOf = (pub) => b32enc(sha256(pub).subarray(0, 16));
const groupId = (creatorPub, nonce) => b32enc(sha256(cat(utf8('fc/v1/group-id\n'), lp(creatorPub), lp(nonce))).subarray(0, 16));
const transferInput = (serverId, chatId, version, fromPub, toPub) =>
  cat(utf8('fc/v1/group-transfer\n'), lps(serverId), lps(chatId), u32(version), lp(fromPub), lp(toPub));

/** Independent group state verification in the documented order; returns { error } or the state. */
function verifyState(envText, ctx) {
  const env = typeof envText === 'string' ? JSON.parse(envText) : envText;
  const payload = b64dec(env.payload);
  const sig = b64dec(env.sig);
  const j = JSON.parse(payload.toString('utf8'));
  if (j.v !== 1) return { error: 'unsupported-version' };
  if (j.serverId !== ctx.serverId) return { error: 'wrong-server' };
  if (j.chatId !== ctx.chatId) return { error: 'wrong-chat' };
  const hash = sha256(payload);
  if (ctx.expectedHash && !hash.equals(ctx.expectedHash)) return { error: 'state-mismatch' };
  for (const m of j.members) if (userIdOf(b64dec(m.signPub)) !== m.userId) return { error: 'user-id-mismatch' };
  const creatorPub = b64dec(j.creator.signPub);
  if (groupId(creatorPub, b64dec(j.creator.nonce)) !== j.chatId) return { error: 'bad-chain' };
  let cur = { userId: userIdOf(creatorPub), pub: creatorPub };
  let signer = cur;
  let last = 1;
  for (const t of j.transfers) {
    const toPub = b64dec(t.toSignPub);
    if (t.version <= last || t.version > j.version) return { error: 'bad-chain' };
    if (userIdOf(toPub) !== t.to || t.to === cur.userId) return { error: 'bad-chain' };
    if (!edVerify(cur.pub, transferInput(j.serverId, j.chatId, t.version, cur.pub, toPub), b64dec(t.sig))) return { error: 'bad-chain' };
    if (t.version < j.version) signer = { userId: t.to, pub: toPub };
    cur = { userId: t.to, pub: toPub };
    last = t.version;
  }
  if (j.owner !== cur.userId) return { error: 'bad-chain' };
  if (!j.members.some((m) => m.userId === j.owner)) return { error: 'malformed' };
  if (j.by !== signer.userId) return { error: 'not-owner' };
  if (!edVerify(signer.pub, cat(utf8('fc/v1/group-state\n'), payload), sig)) return { error: 'bad-signature' };
  const p = ctx.prev;
  if (p) {
    if (j.version !== p.j.version + 1) return { error: 'invalid-transition' };
    if (j.prev === null || !b64dec(j.prev).equals(p.hash)) return { error: 'invalid-transition' };
    if (j.transfers.length < p.j.transfers.length || j.transfers.length > p.j.transfers.length + 1) return { error: 'bad-chain' };
    for (let i = 0; i < p.j.transfers.length; i++) {
      if (JSON.stringify(p.j.transfers[i]) !== JSON.stringify(j.transfers[i])) return { error: 'bad-chain' };
    }
    const added = j.transfers[p.j.transfers.length];
    if (added && added.version !== j.version) return { error: 'bad-chain' };
    if (j.by !== p.j.owner) return { error: 'not-owner' };
    if (j.epoch !== p.j.epoch && j.epoch !== p.j.epoch + 1) return { error: 'invalid-transition' };
    const removed = p.j.members.some((m) => !j.members.some((n) => n.userId === m.userId));
    if (removed && j.epoch !== p.j.epoch + 1) return { error: 'invalid-transition' };
  }
  return { j, hash, payload, signer };
}

const groupKeyInfo = (serverId, chatId, epoch, recipient, version, stateHash) =>
  cat(utf8('fc/v1/group-key\n'), lps(serverId), lps(chatId), u32(epoch), lps(recipient), u32(version), lp(stateHash));

/** Open a sealed key as `me`: recipient check, then HPKE. Returns { error } or { secret, j }. */
function openKey(envText, me, serverId) {
  const env = JSON.parse(envText);
  const j = JSON.parse(b64dec(env.payload).toString('utf8'));
  if (j.v !== 1) return { error: 'unsupported-version' };
  if (j.serverId !== serverId) return { error: 'wrong-server' };
  if (j.recipient !== me.userId) return { error: 'wrong-recipient' };
  const info = groupKeyInfo(j.serverId, j.chatId, j.epoch, j.recipient, j.stateVersion, b64dec(j.stateHash));
  try {
    const rc = setupRecipient(2, b64dec(j.enc), me.boxSecret, info);
    return { secret: rc.open(Buffer.alloc(0), b64dec(j.ct)), j, env };
  } catch {
    return { error: 'wrong-key' };
  }
}

{
  const serverId = gv.serverId;
  const chatId = gv.groupId.chatId;
  const gi = gv.groupId;
  eq(hex(cat(utf8('fc/v1/group-id\n'), lp(users.alice.signPub), lp(unhex(gi.nonceHex)))), gi.hashInputHex, 'group id hash input');
  eq(groupId(users.alice.signPub, unhex(gi.nonceHex)), chatId, 'group id');
  eq(chatId.length, 26, 'group id length');
  let prev;
  for (const step of gv.steps) {
    const n = `group ${step.name.split(':')[0]}`;
    const st = verifyState(step.state.envelope, { serverId, chatId, prev });
    check(!st.error, `${n}: state verifies (${st.error ?? 'ok'})`);
    if (st.error) continue;
    // Same result from the chain alone (a newcomer's view).
    check(!verifyState(step.state.envelope, { serverId, chatId }).error, `${n}: verifies from the chain alone`);
    eq(st.payload.toString('utf8'), step.state.payloadText, `${n}: payload text`);
    eq(hex(cat(utf8('fc/v1/group-state\n'), st.payload)), step.state.signingInputHex, `${n}: signing input`);
    eq(b64enc(edSign(users[step.state.signer].signSecret, cat(utf8('fc/v1/group-state\n'), st.payload))), JSON.parse(step.state.envelope).sig, `${n}: deterministic signature`);
    eq(hex(st.hash), step.state.stateHashHex, `${n}: state hash`);
    eq(Object.keys(st.j).join(','), 'v,serverId,chatId,version,epoch,name,creator,owner,by,transfers,members,prev', `${n}: field order`);
    eq(st.j.owner, users[step.state.owner].userId, `${n}: owner`);
    for (const t of step.transfers) {
      const i = step.transfers.indexOf(t);
      const fromPub = i === 0 ? b64dec(st.j.creator.signPub) : b64dec(st.j.transfers[i - 1].toSignPub);
      const input = transferInput(serverId, chatId, t.version, fromPub, b64dec(st.j.transfers[i].toSignPub));
      eq(hex(input), t.signingInputHex, `${n}: transfer ${i} signing input`);
      check(edVerify(fromPub, input, unhex(t.sigHex)), `${n}: transfer ${i} signature`);
    }
    // Encrypted state blob.
    const encKey = hkdf(unhex(step.epochSecretHex), utf8('fc/v1/enc'));
    eq(hex(encKey), step.encKeyHex, `${n}: encKey`);
    const header = cat(utf8('FCS'), [1], u32(st.j.epoch), u32(st.j.version), serverTag(serverId), chatTag(chatId));
    eq(hex(header), step.blob.headerHex, `${n}: blob header`);
    const aad = cat(header, lps(serverId), lps(chatId));
    eq(hex(aad), step.blob.aadHex, `${n}: blob AAD`);
    const envBytes = utf8(step.state.envelope);
    const plain = Buffer.alloc(Math.ceil((4 + envBytes.length) / 256) * 256);
    cat(u32(envBytes.length), envBytes).copy(plain);
    eq(hex(plain), step.blob.plaintextHex, `${n}: blob plaintext`);
    const blob = cat(header, unhex(step.blob.nonceHex), gcmEncrypt(encKey, unhex(step.blob.nonceHex), aad, plain));
    eq(hex(blob), step.blob.blobHex, `${n}: blob`);
    // Sealed keys.
    for (const k of step.sealedKeys) {
      const me = users[k.recipient];
      const info = groupKeyInfo(serverId, chatId, st.j.epoch, me.userId, st.j.version, st.hash);
      eq(hex(info), k.infoHex, `${n}: key for ${k.recipient} info`);
      const s = setupSender(2, me.boxPub, info, unhex(k.ikmEHex));
      eq(hex(deriveKeyPair(unhex(k.ikmEHex)).sk), k.ephemeralSecretHex, `${n}: key for ${k.recipient} ephemeral secret`);
      eq(hex(s.enc), k.encHex, `${n}: key for ${k.recipient} enc`);
      eq(hex(s.ctx.seal(Buffer.alloc(0), unhex(step.epochSecretHex))), k.ctHex, `${n}: key for ${k.recipient} ct`);
      const o = openKey(k.envelope, me, serverId);
      check(!o.error && hex(o.secret) === step.epochSecretHex, `${n}: key for ${k.recipient} opens`);
      if (o.error) continue;
      eq(Object.keys(o.j).join(','), 'v,serverId,chatId,epoch,recipient,stateVersion,stateHash,by,enc,ct', `${n}: key field order`);
      eq(o.j.by, st.signer.userId, `${n}: key signed by the state signer`);
      check(edVerify(st.signer.pub, cat(utf8('fc/v1/group-key\n'), b64dec(o.env.payload)), b64dec(o.env.sig)), `${n}: key signature`);
      eq(o.j.stateHash, b64enc(st.hash), `${n}: key names the state hash`);
    }
    prev = st;
  }
}

// ---- envelopes-m2.json ----
{
  const ev = load('envelopes-m2.json');
  for (const e of ev.envelopes) {
    const r = openEnvelope(e.envelope, e.kind, users[e.signer].signPub);
    check(!r.error, `${e.kind} (M2) envelope verifies (${r.error ?? 'ok'})`);
    if (r.error) continue;
    eq(r.payload.toString('utf8'), e.payloadText, `${e.kind} (M2) payload text`);
    eq(hex(r.input), e.signingInputHex, `${e.kind} (M2) signing input`);
    if (e.kind === 'profile') {
      const a = r.json.avatar;
      check(
        a !== null && Object.keys(a).join(',') === 'sha256,type' && b64dec(a.sha256).length === 32 && ['image/jpeg', 'image/webp'].includes(a.type),
        'profile avatar shape',
      );
    }
    if (e.kind === 'revoked') eq(Object.keys(r.json).join(','), 'v,userId,revokedAt', 'revoked field order');
  }
}

// ---- attachments ----
const blobAad = (idRaw, i, parts) => cat(utf8('fc/v1/blob\n'), lp(idRaw), u32(i), u32(parts));
const counterNonce = (i) => cat(Buffer.alloc(8), u32(i));
const pattern = (n, seed) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const partCount = (size, partSize) => (size === 0 ? 1 : Math.ceil(size / partSize));
function descriptorError(a) {
  const b = a.blob;
  if (!b || typeof b.id !== 'string' || !/^[a-z2-7]{26}$/.test(b.id)) return 'malformed';
  try {
    if (b32dec(b.id).length !== 16 || b64dec(b.key).length !== 32) return 'malformed';
  } catch {
    return 'malformed';
  }
  if (b.partSize !== 4194304 || !Number.isSafeInteger(b.size) || b.size < 0 || b.parts !== partCount(b.size, b.partSize)) return 'malformed';
  if (typeof a.name !== 'string' || /[/\\\u0000-\u001f\u007f-\u009f]/.test(a.name) || a.name === '.' || a.name === '..') return 'malformed';
  if (a.kind === 'voice' && (!Array.isArray(a.peaks) || a.peaks.length !== 64 || !Number.isSafeInteger(a.dur))) return 'malformed';
  if (a.thumb !== undefined && b64dec(a.thumb).length > 4096) return 'malformed';
  return 'ok';
}
const av = load('attachment.json');
const blobParts = { single: [], twoParts: [] };
{
  const s = av.single;
  const idRaw = b32dec(s.blob.id);
  eq(hex(blobAad(idRaw, 0, 1)), s.aadHex, 'attachment single AAD');
  eq(hex(pattern(s.blob.size, s.seed)), s.plaintextHex, 'attachment single plaintext');
  const ct = gcmEncrypt(b64dec(s.blob.key), counterNonce(0), blobAad(idRaw, 0, 1), unhex(s.plaintextHex));
  eq(hex(ct), s.ciphertextHex, 'attachment single ciphertext');
  blobParts.single.push(ct);
  const t = av.twoParts;
  const plain = pattern(t.blob.size, t.seed);
  for (const p of t.parts) {
    const pt = plain.subarray(p.index * t.blob.partSize, Math.min((p.index + 1) * t.blob.partSize, t.blob.size));
    eq(pt.length, p.plaintextLength, `attachment part ${p.index} length`);
    const aad = blobAad(b32dec(t.blob.id), p.index, t.blob.parts);
    eq(hex(aad), p.aadHex, `attachment part ${p.index} AAD`);
    eq(hex(counterNonce(p.index)), p.nonceHex, `attachment part ${p.index} nonce`);
    const ct = gcmEncrypt(b64dec(t.blob.key), counterNonce(p.index), aad, pt);
    eq(sha256(ct).toString('hex'), p.ciphertextSha256, `attachment part ${p.index} ciphertext hash`);
    eq(hex(ct.subarray(ct.length - 16)), p.tagHex, `attachment part ${p.index} tag`);
    blobParts.twoParts.push(ct);
  }
  eq(descriptorError(av.descriptor), 'ok', 'attachment descriptor is valid');
}

// ---- payloads.json ----
for (const p of load('payloads.json').payloads) {
  const j = JSON.parse(p.text);
  const order = {
    msg: 'v,t,id,dev,seq,fwd,attachments,location',
    edit: 'v,t,id,dev,seq,target,body',
    delete: 'v,t,id,dev,seq,target,targetDev,targetSeq',
    react: 'v,t,id,dev,seq,target,emoji,on',
  }[j.t];
  eq(Object.keys(j).join(','), order, `payload ${j.t} field order`);
  if (j.t === 'msg') for (const a of j.attachments) eq(descriptorError(a), 'ok', `payload attachment ${a.name}`);
}

// ---- archive ----
const arv = load('archive.json');
function readArchiveIndep(file, selfKey) {
  if (file.length < 36 || file.subarray(0, 3).toString('latin1') !== 'FCA') return { error: 'malformed' };
  if (file[3] !== 1) return { error: 'unsupported-version' };
  const h = file.subarray(0, 36);
  const key = hkdf(selfKey, cat(utf8('fc/v1/archive'), h.subarray(4, 20)));
  if (!hkdf(key, utf8('fc/v1/archive-check')).subarray(0, 16).equals(h.subarray(20, 36))) return { error: 'wrong-identity' };
  const blockCt = 1024 * 1024 + 16;
  const body = file.subarray(36);
  const plains = [];
  for (let i = 0, off = 0; off < body.length || i === 0; i++) {
    const last = body.length - off <= blockCt;
    const ct = body.subarray(off, last ? body.length : off + blockCt);
    if (ct.length < 16) return { error: 'malformed' };
    try {
      plains.push(gcmDecrypt(key, counterNonce(i), cat(h, u32(i), [last ? 1 : 0]), ct));
    } catch {
      return { error: 'malformed' };
    }
    off += ct.length;
    if (last) break;
  }
  const plain = cat(...plains);
  const records = [];
  for (let off = 0; off < plain.length; ) {
    if (plain.length - off < 6) return { error: 'malformed' };
    const type = plain.readUInt16BE(off);
    const len = plain.readUInt32BE(off + 2);
    if (type === 0 || off + 6 + len > plain.length) return { error: 'malformed' };
    records.push({ type, dataHex: hex(plain.subarray(off + 6, off + 6 + len)) });
    off += 6 + len;
  }
  return { records, key, header: h };
}
const archives = {};
{
  const s = arv.small;
  const alice = hkdf(unhex(idv.users[arv.owner].seedHex), utf8('fc/v1/self'));
  eq(hex(hkdf(alice, cat(utf8('fc/v1/archive'), unhex(s.saltHex)))), s.archiveKeyHex, 'archive key');
  eq(hex(hkdf(unhex(s.archiveKeyHex), utf8('fc/v1/archive-check')).subarray(0, 16)), s.checkHex, 'archive check');
  const file = unhex(s.fileHex);
  eq(hex(file.subarray(0, 36)), hex(cat(utf8('FCA'), [1], unhex(s.saltHex), unhex(s.checkHex))), 'archive header');
  const r = readArchiveIndep(file, alice);
  check(!r.error, `small archive reads (${r.error ?? 'ok'})`);
  eq(JSON.stringify(r.records), JSON.stringify(s.records), 'small archive records');
  archives.small = file;
  // Rebuild the two-block archive from its description.
  const t = arv.twoBlocks;
  const salt = unhex(t.saltHex);
  const key = hkdf(alice, cat(utf8('fc/v1/archive'), salt));
  const header = cat(utf8('FCA'), [1], salt, hkdf(key, utf8('fc/v1/archive-check')).subarray(0, 16));
  const plain = cat(u32(t.record.length).subarray(0, 0), Buffer.from([0, t.record.type]), u32(t.record.length), pattern(t.record.length, t.record.seed));
  const blocks = [];
  for (let i = 0, off = 0; ; i++) {
    const last = plain.length - off <= 1024 * 1024;
    const chunk = plain.subarray(off, last ? plain.length : off + 1024 * 1024);
    blocks.push(gcmEncrypt(key, counterNonce(i), cat(header, u32(i), [last ? 1 : 0]), chunk));
    off += chunk.length;
    if (last) break;
  }
  const big = cat(header, ...blocks);
  eq(big.length, t.fileLength, 'two-block archive length');
  eq(sha256(big).toString('hex'), t.fileSha256, 'two-block archive hash');
  eq(JSON.stringify(blocks.map((b) => hex(b.subarray(b.length - 16)))), JSON.stringify(t.blockTagsHex), 'two-block archive tags');
  check(!readArchiveIndep(big, alice).error, 'two-block archive reads');
  archives.twoBlocks = big;
}

// ---- negative-m2.json ----
{
  const neg = load('negative-m2.json');
  const serverId = gv.serverId;
  const chatId = gv.groupId.chatId;
  const states = {};
  let prev;
  for (const step of gv.steps) {
    prev = verifyState(step.state.envelope, { serverId, chatId, prev });
    states[step.name.split(':')[0]] = prev;
  }
  for (const c of neg.groupStates) {
    const r = verifyState(c.envelope, { serverId, chatId, prev: c.prev ? states[c.prev] : undefined });
    eq(r.error ?? 'ok', c.expectedError, c.name);
  }
  for (const c of neg.sealedKeys) eq(openKey(c.envelope, users[c.openAs], serverId).error ?? 'ok', c.expectedError, c.name);
  for (const c of neg.attachmentParts) {
    const v = av[c.vector];
    let ct = blobParts[c.vector][c.present];
    if (c.truncate) ct = ct.subarray(0, ct.length - c.truncate);
    if (c.flipLastByte) {
      ct = Buffer.from(ct);
      ct[ct.length - 1] ^= 1;
    }
    const expectedLen = (c.as < v.blob.parts - 1 ? v.blob.partSize : v.blob.size - (v.blob.parts - 1) * v.blob.partSize) + 16;
    let code = 'ok';
    if (ct.length !== expectedLen) code = 'malformed';
    else {
      try {
        gcmDecrypt(b64dec(v.blob.key), counterNonce(c.as), blobAad(b32dec(v.blob.id), c.as, v.blob.parts), ct);
      } catch {
        code = 'wrong-key';
      }
    }
    eq(code, c.expectedError, c.name);
  }
  for (const c of neg.descriptors) eq(descriptorError(c.descriptor), c.expectedError, c.name);
  for (const c of neg.archives) {
    let file = archives[c.vector];
    if (c.truncateTo) file = file.subarray(0, c.truncateTo);
    if (c.flipByte !== undefined) {
      file = Buffer.from(file);
      file[c.flipByte] ^= 1;
    }
    const selfKey = hkdf(unhex((idv.users[c.openAs] ?? gv.extraUsers[c.openAs]).seedHex), utf8('fc/v1/self'));
    eq(readArchiveIndep(file, selfKey).error ?? 'ok', c.expectedError, c.name);
  }
}

// ---- stickers.json (M5) ----
{
  const sv = load('stickers.json');
  const alice = users[sv.signer];
  const isB32 = (v, n) => typeof v === 'string' && v.length === Math.ceil((n * 8) / 5) && /^[a-z2-7]+$/.test(v) && b32dec(v).length === n;
  const hash32 = (b) => b32enc(sha256(b).subarray(0, 20));
  // eslint-disable-next-line no-control-regex
  const forbidden = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;
  const emojiOk = (e) =>
    typeof e === 'string' && e.trim().length > 0 && e.trim() === e && [...e].length <= 16 && utf8(e).length <= 64 && !forbidden.test(e);
  const side = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1024;
  for (const f of sv.files) eq(hash32(unhex(f.bytesHex)), f.hash32, `hash32 of ${f.name}`);

  function verifyPack(text, signer, serverId) {
    const env = JSON.parse(text);
    if (Object.keys(env).length !== 2) return 'malformed';
    const payload = b64dec(env.payload);
    const j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (j.v !== 1) return 'unsupported-version';
    if (!isB32(j.packId, 16) || !isB32(j.author, 16) || typeof j.serverId !== 'string') return 'malformed';
    if (typeof j.name !== 'string' || j.name.trim() === '' || [...j.name].length > 64 || forbidden.test(j.name)) return 'malformed';
    if (!Number.isSafeInteger(j.created) || j.created < 0) return 'malformed';
    if (!Array.isArray(j.stickers) || j.stickers.length < 1 || j.stickers.length > 200) return 'malformed';
    const seen = new Set();
    let total = 0;
    for (const s of j.stickers) {
      const max = s.type === 'webp' ? 512 * 1024 : s.type === 'tgs' ? 128 * 1024 : 0;
      if (!isB32(s.file, 20) || max === 0 || !Number.isSafeInteger(s.size) || s.size < 1 || s.size > max) return 'malformed';
      if (!emojiOk(s.emoji) || !side(s.w) || !side(s.h) || seen.has(s.file)) return 'malformed';
      seen.add(s.file);
      total += s.size;
    }
    if (total > 50 * 1024 * 1024) return 'too-large';
    if (j.author !== signer.userId) return 'user-id-mismatch';
    if (!edVerify(signer.signPub, cat(utf8('fc/v1/sticker-pack\n'), payload), b64dec(env.sig))) return 'bad-signature';
    if (j.serverId !== serverId) return 'wrong-server';
    return { payload, j };
  }

  const r = verifyPack(sv.manifest.envelope, alice, sv.serverId);
  check(typeof r === 'object', `sticker-pack manifest verifies (${typeof r === 'string' ? r : 'ok'})`);
  if (typeof r === 'object') {
    eq(r.payload.toString('utf8'), sv.manifest.payloadText, 'sticker-pack payload text');
    eq(hex(cat(utf8('fc/v1/sticker-pack\n'), r.payload)), sv.manifest.signingInputHex, 'sticker-pack signing input');
    eq(b64enc(edSign(alice.signSecret, cat(utf8('fc/v1/sticker-pack\n'), r.payload))), JSON.parse(sv.manifest.envelope).sig, 'sticker-pack deterministic signature');
    eq(Object.keys(r.j).join(','), 'v,packId,serverId,author,name,created,stickers', 'sticker-pack field order');
    for (const s of r.j.stickers) eq(Object.keys(s).join(','), 'file,type,size,emoji,w,h', 'sticker field order');
    eq(JSON.stringify(r.j.stickers.map((s) => s.file)), JSON.stringify(sv.files.map((f) => f.hash32)), 'manifest names the files by hash32');
  }
  for (const c of sv.negativeManifests) {
    const got = verifyPack(c.envelope, alice, sv.serverId);
    eq(typeof got === 'string' ? got : 'ok', c.expectedError, c.name);
  }

  function msgError(text) {
    const m = JSON.parse(text);
    if (m.v !== 1 || m.t !== 'msg') return 'malformed';
    if (m.sticker !== undefined) {
      const s = m.sticker;
      if (typeof s !== 'object' || s === null || !isB32(s.pack, 16) || !isB32(s.file, 20) || !['webp', 'tgs'].includes(s.type)) return 'malformed';
      if (!side(s.w) || !side(s.h) || !emojiOk(m.body) || m.attachments !== undefined || m.location !== undefined) return 'malformed';
    }
    return 'ok';
  }
  eq(msgError(sv.message.text), 'ok', 'sticker message');
  eq(JSON.parse(sv.message.text).body, sv.message.fallbackBody, 'sticker message carries the emoji as body');
  eq(Object.keys(JSON.parse(sv.message.text)).join(','), 'v,t,id,dev,seq,body,sticker', 'sticker message field order');
  for (const c of sv.negativeMessages) eq(msgError(c.text), c.expectedError, c.name);
}

// ---- profile-gender.json (M7) ----
{
  const pg = load('profile-gender.json');
  /** The gender rule of docs/PROTOCOL.md 4.3, written again here: absent means "m". */
  const genderOf = (json) => (json.gender === undefined ? 'm' : json.gender === 'm' || json.gender === 'f' ? json.gender : null);
  for (const p of pg.profiles) {
    const r = openEnvelope(p.envelope, 'profile', users[p.signer].signPub);
    check(!r.error, `profile (M7) ${p.name} verifies (${r.error ?? 'ok'})`);
    if (r.error) continue;
    eq(r.payload.toString('utf8'), p.payloadText, `profile (M7) ${p.name} payload text`);
    eq(hex(r.input), p.signingInputHex, `profile (M7) ${p.name} signing input`);
    eq(genderOf(r.json), p.gender, `profile (M7) ${p.name} gender`);
    const order = r.json.gender === undefined ? 'v,userId,name,avatar,rev,updated' : 'v,userId,name,avatar,gender,rev,updated';
    eq(Object.keys(r.json).join(','), order, `profile (M7) ${p.name} field order`);
  }
  for (const c of pg.negative) {
    const r = openEnvelope(c.envelope, 'profile', users.alice.signPub);
    eq(r.error ?? (genderOf(r.json) === null ? 'malformed' : 'ok'), c.expectedError, `profile (M7) ${c.name}`);
  }
}

if (failures > 0) {
  console.error(`${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`all ${checks} vector checks passed (node:crypto only)`);
