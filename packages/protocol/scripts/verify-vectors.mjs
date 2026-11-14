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

if (failures > 0) {
  console.error(`${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`all ${checks} vector checks passed (node:crypto only)`);
