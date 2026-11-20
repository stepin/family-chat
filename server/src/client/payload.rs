//! Event payloads (docs/PROTOCOL.md, section 7) and attachment descriptors
//! (section 16.3): UTF-8 JSON with the common fields `v, t, id, dev, seq`.
//! Implemented kinds (version 1): `msg`, `edit`, `delete`, `react`.

use serde_json::Value;

use super::error::{Code, ProtoError, Result, err, invalid, malformed};
use super::json::{Obj, Writer, b32, b64, js_trim, list, name_problem, number, parse_object, quote, safe_uint};
use crate::ids::{BlobId, DevId, FileHash, MsgId, PackId, UserId, b64_decode, b64_encode};

pub const MAX_BODY_BYTES: usize = 16384;
pub const MAX_ATTACHMENTS: usize = 10;
pub const MAX_EMOJI_CHARS: usize = 16;
pub const MAX_EMOJI_BYTES: usize = 64;
pub const BLOB_PART_SIZE: u64 = 4 * 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_THUMB_BYTES: usize = 4096;
pub const VOICE_PEAKS: usize = 64;
pub const MAX_FILE_NAME_CHARS: usize = 128;
pub const MAX_FILE_NAME_BYTES: usize = 255;
pub const MAX_VOICE_DURATION_MS: u64 = 86_400_000;
pub const MAX_IMAGE_SIDE: u64 = 65535;
pub const MAX_STICKER_SIDE: u64 = 1024;
pub const IMAGE_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/gif"];
pub const VOICE_TYPES: [&str; 3] = ["audio/mp4", "audio/webm", "audio/ogg"];

/// Reference to a message: the pair (author, message id).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MsgRef {
    pub author: UserId,
    pub id: MsgId,
}

/// A point on the map: degrees (WGS 84) and the accuracy radius in metres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
    pub accuracy: f64,
}

/// Where an attachment's bytes are and how to decrypt them. Holds the file key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    pub id: BlobId,
    pub key: [u8; 32],
    pub parts: u32,
    pub part_size: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    Image,
    Voice,
    File,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AttachmentKind::Image => "image",
            AttachmentKind::Voice => "voice",
            AttachmentKind::File => "file",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub blob: BlobRef,
    pub name: String,
    pub mime: String,
    pub kind: AttachmentKind,
    pub w: Option<u32>,
    pub h: Option<u32>,
    /// Inline JPEG thumbnail.
    pub thumb: Option<Vec<u8>>,
    /// Voice: duration in milliseconds and exactly 64 peaks.
    pub dur: Option<u64>,
    pub peaks: Option<Vec<u8>>,
}

/// A sticker of a family pack (section 18).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StickerRef {
    pub pack: PackId,
    pub file: FileHash,
    /// `webp` or `tgs`.
    pub kind: String,
    pub w: u32,
    pub h: u32,
}

/// Fields of every implemented kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Common {
    pub id: MsgId,
    pub dev: DevId,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    pub common: Common,
    pub body: Option<String>,
    pub reply: Option<MsgRef>,
    pub fwd: bool,
    pub attachments: Vec<Attachment>,
    pub location: Option<Location>,
    pub sticker: Option<StickerRef>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    Msg(Msg),
    Edit {
        common: Common,
        target: MsgRef,
        body: String,
    },
    Delete {
        common: Common,
        target: MsgRef,
        target_dev: DevId,
        target_seq: u64,
    },
    React {
        common: Common,
        target: MsgRef,
        emoji: String,
        on: bool,
    },
    /// An unknown kind or version. `critical`: show "update the app to see
    /// this message"; otherwise the event is skipped.
    Unknown {
        critical: bool,
        t: String,
        id: MsgId,
        dev: Option<DevId>,
        seq: Option<u64>,
    },
}

impl Payload {
    pub fn id(&self) -> MsgId {
        match self {
            Payload::Msg(m) => m.common.id,
            Payload::Edit { common, .. } | Payload::Delete { common, .. } | Payload::React { common, .. } => common.id,
            Payload::Unknown { id, .. } => *id,
        }
    }

    /// Device and counter, when the payload carries well-formed ones.
    pub fn dev_seq(&self) -> Option<(DevId, u64)> {
        match self {
            Payload::Msg(m) => Some((m.common.dev, m.common.seq)),
            Payload::Edit { common, .. } | Payload::Delete { common, .. } | Payload::React { common, .. } => {
                Some((common.dev, common.seq))
            }
            Payload::Unknown { dev, seq, .. } => dev.zip(*seq),
        }
    }
}

// ---- parsing ----

fn msg_ref(v: Option<&Value>, what: &str) -> Result<MsgRef> {
    let o = v
        .and_then(Value::as_object)
        .ok_or_else(|| malformed(format!("{what} must be an object")))?;
    let author = b32::<16>(o.get("author")).ok_or_else(|| malformed(format!("{what}.author must be a userId")))?;
    let id = b32::<16>(o.get("id")).ok_or_else(|| malformed(format!("{what}.id must be a message id")))?;
    Ok(MsgRef {
        author: UserId(author),
        id: MsgId(id),
    })
}

fn location(v: &Value) -> Result<Location> {
    let o = v.as_object().ok_or_else(|| malformed("location must be an object"))?;
    let num = |k: &str, lo: f64, hi: f64| -> Result<f64> {
        match o.get(k).and_then(Value::as_f64) {
            Some(n) if n.is_finite() && n >= lo && n <= hi => Ok(n),
            _ => Err(malformed(format!("location.{k} is out of range"))),
        }
    };
    Ok(Location {
        lat: num("lat", -90.0, 90.0)?,
        lon: num("lon", -180.0, 180.0)?,
        accuracy: num("accuracy", 0.0, 1e7)?,
    })
}

/// Problem with a reaction or sticker emoji, or `None`.
pub fn emoji_problem(e: &str) -> Option<String> {
    if let Some(p) = name_problem(e, MAX_EMOJI_CHARS) {
        return Some(format!("emoji: {p}"));
    }
    if e.len() > MAX_EMOJI_BYTES {
        return Some(format!("emoji must be at most {MAX_EMOJI_BYTES} bytes"));
    }
    if js_trim(e) != e {
        return Some("emoji must not contain surrounding spaces".into());
    }
    None
}

fn body(o: &Obj, kind: &str) -> Result<String> {
    let b = o
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed(format!("{kind}: body must be a string")))?;
    if b.len() > MAX_BODY_BYTES {
        return Err(malformed(format!("{kind}: body exceeds {MAX_BODY_BYTES} bytes")));
    }
    Ok(b.to_string())
}

fn common(o: &Obj, id: MsgId, kind: &str) -> Result<Common> {
    let dev = b32::<10>(o.get("dev")).ok_or_else(|| malformed(format!("{kind}: dev must be a devId")))?;
    let seq =
        safe_uint(o.get("seq")).ok_or_else(|| malformed(format!("{kind}: seq must be a non-negative integer")))?;
    Ok(Common {
        id,
        dev: DevId(dev),
        seq,
    })
}

fn mime_ok(m: &str) -> bool {
    let part = |p: &str| {
        let b = p.as_bytes();
        !b.is_empty()
            && b.len() <= 63
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_.+-".contains(c))
    };
    match m.split_once('/') {
        Some((a, b)) => part(a) && part(b),
        None => false,
    }
}

fn file_name_problem(name: &str) -> Option<String> {
    if let Some(p) = name_problem(name, MAX_FILE_NAME_CHARS) {
        return Some(p);
    }
    if js_trim(name) != name {
        return Some("name must not start or end with spaces".into());
    }
    if name.len() > MAX_FILE_NAME_BYTES {
        return Some(format!("name must be at most {MAX_FILE_NAME_BYTES} bytes"));
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return Some("name must not contain path separators".into());
    }
    None
}

/// Number of parts of a file: `ceil(size / partSize)`, 1 for an empty file.
pub fn blob_part_count(size: u64, part_size: u64) -> u64 {
    if size == 0 { 1 } else { size.div_ceil(part_size) }
}

fn blob_ref(v: Option<&Value>, max_size: u64) -> std::result::Result<BlobRef, String> {
    let o = v.and_then(Value::as_object).ok_or("blob must be an object")?;
    let id = b32::<16>(o.get("id")).ok_or("blob.id must be base32 of 16 bytes")?;
    let key = b64::<32>(o.get("key")).ok_or("blob.key must be base64url of 32 bytes")?;
    let part_size = safe_uint(o.get("partSize")).filter(|p| *p == BLOB_PART_SIZE);
    let part_size = part_size.ok_or("blob.partSize is not allowed")?;
    let size = safe_uint(o.get("size")).ok_or("blob.size must be a non-negative integer")?;
    if size > max_size {
        return Err("blob.size exceeds the limit".into());
    }
    let parts = safe_uint(o.get("parts")).filter(|p| *p == blob_part_count(size, part_size));
    let parts = parts.ok_or("blob.parts must be ceil(size / partSize)")?;
    Ok(BlobRef {
        id: BlobId(id),
        key,
        parts: parts as u32,
        part_size,
        size,
    })
}

fn attachment_checked(v: &Value, max_size: u64) -> std::result::Result<Attachment, String> {
    let a = v.as_object().ok_or("attachment must be an object")?;
    let blob = blob_ref(a.get("blob"), max_size)?;
    let name = a
        .get("name")
        .and_then(Value::as_str)
        .ok_or("name: name must be a string")?;
    if let Some(p) = file_name_problem(name) {
        return Err(format!("name: {p}"));
    }
    let mime = a.get("mime").and_then(Value::as_str).filter(|m| mime_ok(m));
    let mime = mime.ok_or("mime must be a lowercase type/subtype without parameters")?;
    let kind = match a.get("kind").and_then(Value::as_str) {
        Some("image") => AttachmentKind::Image,
        Some("voice") => AttachmentKind::Voice,
        Some("file") => AttachmentKind::File,
        _ => return Err("kind must be image, voice or file".into()),
    };
    if kind == AttachmentKind::Image && !IMAGE_TYPES.contains(&mime) {
        return Err("image mime type is not allowed".into());
    }
    if kind == AttachmentKind::Voice && !VOICE_TYPES.contains(&mime) {
        return Err("voice mime type is not allowed".into());
    }

    let has_dims = a.contains_key("w") || a.contains_key("h");
    if kind == AttachmentKind::Image && !has_dims {
        return Err("image needs w and h".into());
    }
    if kind == AttachmentKind::Voice && has_dims {
        return Err("voice must not have w or h".into());
    }
    let dim = |k: &str| safe_uint(a.get(k)).filter(|n| (1..=MAX_IMAGE_SIDE).contains(n));
    let (w, h) = if has_dims {
        match (dim("w"), dim("h")) {
            (Some(w), Some(h)) => (Some(w as u32), Some(h as u32)),
            _ => return Err(format!("w and h must be integers 1..{MAX_IMAGE_SIDE}")),
        }
    } else {
        (None, None)
    };

    let thumb = match a.get("thumb") {
        None => None,
        Some(_) if kind == AttachmentKind::Voice => return Err("voice must not have a thumbnail".into()),
        Some(t) => {
            let text = t.as_str().ok_or("thumb must be base64url")?;
            let bytes = b64_decode(text).ok_or("thumb must be base64url")?;
            if bytes.len() > MAX_THUMB_BYTES {
                return Err(format!("thumb must be at most {MAX_THUMB_BYTES} bytes"));
            }
            if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
                return Err("thumb must be a JPEG".into());
            }
            Some(bytes)
        }
    };

    let (dur, peaks) = if kind == AttachmentKind::Voice {
        let dur = safe_uint(a.get("dur")).filter(|d| *d <= MAX_VOICE_DURATION_MS);
        let dur = dur.ok_or("voice needs dur in milliseconds")?;
        let list = a
            .get("peaks")
            .and_then(Value::as_array)
            .filter(|p| p.len() == VOICE_PEAKS);
        let list = list.ok_or(format!("voice needs exactly {VOICE_PEAKS} peaks"))?;
        let peaks: Option<Vec<u8>> = list
            .iter()
            .map(|p| safe_uint(Some(p)).and_then(|n| u8::try_from(n).ok()))
            .collect();
        (Some(dur), Some(peaks.ok_or("peaks must be integers 0..255")?))
    } else if a.contains_key("dur") || a.contains_key("peaks") {
        return Err("only voice has dur and peaks".into());
    } else {
        (None, None)
    };

    Ok(Attachment {
        blob,
        name: name.to_string(),
        mime: mime.to_string(),
        kind,
        w,
        h,
        thumb,
        dur,
        peaks,
    })
}

/// Strict check of a received attachment descriptor (`malformed`).
pub fn validate_attachment(v: &Value, max_size: Option<u64>) -> Result<Attachment> {
    let max = max_size.unwrap_or(MAX_ATTACHMENT_BYTES).min(MAX_ATTACHMENT_BYTES);
    attachment_checked(v, max).map_err(|p| malformed(format!("attachment: {p}")))
}

fn sticker_ref(v: &Value) -> std::result::Result<StickerRef, String> {
    let s = v.as_object().ok_or("sticker must be an object")?;
    let pack = b32::<16>(s.get("pack")).ok_or("sticker.pack must be a packId")?;
    let file = b32::<20>(s.get("file")).ok_or("sticker.file must be a hash32")?;
    let kind = s
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| matches!(*t, "webp" | "tgs"));
    let kind = kind.ok_or("sticker.type must be webp or tgs")?;
    let side = |k: &str| {
        safe_uint(s.get(k))
            .filter(|n| (1..=MAX_STICKER_SIDE).contains(n))
            .ok_or(format!("sticker.{k} must be an integer 1..{MAX_STICKER_SIDE}"))
    };
    Ok(StickerRef {
        pack: PackId(pack),
        file: FileHash(file),
        kind: kind.to_string(),
        w: side("w")? as u32,
        h: side("h")? as u32,
    })
}

fn decode_msg(o: &Obj, id: MsgId) -> Result<Msg> {
    let common = common(o, id, "msg")?;
    let body = if o.contains_key("body") {
        Some(body(o, "msg")?)
    } else {
        None
    };
    let reply = match o.get("reply") {
        Some(r) => Some(msg_ref(Some(r), "reply").map_err(|e| malformed(format!("msg: {}", e.message)))?),
        None => None,
    };
    let fwd = match o.get("fwd") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err(malformed("msg: fwd must be true when present")),
    };
    let attachments = match o.get("attachments") {
        None => Vec::new(),
        Some(v) => {
            let list = v.as_array().filter(|l| !l.is_empty() && l.len() <= MAX_ATTACHMENTS);
            let list =
                list.ok_or_else(|| malformed(format!("msg: attachments must be a list of 1..{MAX_ATTACHMENTS}")))?;
            list.iter()
                .map(|a| validate_attachment(a, None))
                .collect::<Result<_>>()?
        }
    };
    let location = o.get("location").map(location).transpose()?;
    let sticker = match o.get("sticker") {
        None => None,
        Some(v) => {
            let s = sticker_ref(v).map_err(|p| malformed(format!("msg: {p}")))?;
            let emoji = body
                .as_deref()
                .ok_or_else(|| malformed("msg: a sticker needs its emoji as the body"))?;
            if let Some(p) = emoji_problem(emoji) {
                return Err(malformed(format!("msg: {p}")));
            }
            if !attachments.is_empty() || location.is_some() {
                return Err(malformed("msg: a sticker message has no attachments or location"));
            }
            Some(s)
        }
    };
    Ok(Msg {
        common,
        body,
        reply,
        fwd,
        attachments,
        location,
        sticker,
    })
}

/// Parses payload bytes into the typed form. `malformed` for invalid JSON or
/// a broken implemented kind; unknown kinds and versions give `Unknown`.
pub fn parse_payload(bytes: &[u8]) -> Result<Payload> {
    let o = parse_object(bytes, "payload")?;
    let v = safe_uint(o.get("v")).filter(|v| *v >= 1);
    let v = v.ok_or_else(|| malformed("payload: v must be a positive integer"))?;
    let t = o.get("t").and_then(Value::as_str).filter(|t| !t.is_empty());
    let t = t.ok_or_else(|| malformed("payload: t must be a non-empty string"))?;
    let critical = match o.get("crit") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(malformed("payload: crit must be a boolean")),
    };
    let id = MsgId(b32::<16>(o.get("id")).ok_or_else(|| malformed("payload: id must be a message id"))?);

    if v == 1 {
        match t {
            "msg" => return Ok(Payload::Msg(decode_msg(&o, id)?)),
            "edit" => {
                return Ok(Payload::Edit {
                    common: common(&o, id, "edit")?,
                    target: msg_ref(o.get("target"), "target")?,
                    body: body(&o, "edit")?,
                });
            }
            "delete" => {
                let common = common(&o, id, "delete")?;
                let target = msg_ref(o.get("target"), "target")?;
                let target_dev = b32::<10>(o.get("targetDev"));
                let target_seq = safe_uint(o.get("targetSeq"));
                return Ok(Payload::Delete {
                    common,
                    target,
                    target_dev: DevId(target_dev.ok_or_else(|| malformed("delete: targetDev must be a devId"))?),
                    target_seq: target_seq
                        .ok_or_else(|| malformed("delete: targetSeq must be a non-negative integer"))?,
                });
            }
            "react" => {
                let common = common(&o, id, "react")?;
                let target = msg_ref(o.get("target"), "target")?;
                let emoji = o.get("emoji").and_then(Value::as_str);
                let emoji = emoji.ok_or_else(|| malformed("react: emoji must be a string"))?;
                if let Some(p) = emoji_problem(emoji) {
                    return Err(malformed(format!("react: {p}")));
                }
                let on = o.get("on").and_then(Value::as_bool);
                return Ok(Payload::React {
                    common,
                    target,
                    emoji: emoji.to_string(),
                    on: on.ok_or_else(|| malformed("react: on must be a boolean"))?,
                });
            }
            _ => {}
        }
    }
    Ok(Payload::Unknown {
        critical,
        t: t.to_string(),
        id,
        dev: b32::<10>(o.get("dev")).map(DevId),
        seq: safe_uint(o.get("seq")),
    })
}

// ---- writing ----

fn common_out(t: &str, c: &Common) -> Writer {
    Writer::new()
        .num("v", 1)
        .str("t", t)
        .str("id", &c.id.to_string())
        .str("dev", &c.dev.to_string())
        .num("seq", c.seq)
}

fn ref_out(r: &MsgRef) -> String {
    Writer::new()
        .str("author", &r.author.to_string())
        .str("id", &r.id.to_string())
        .finish()
}

/// The descriptor as it is written into a message: `blob, name, mime, kind, w, h, thumb, dur, peaks`.
pub fn attachment_json(a: &Attachment) -> String {
    let blob = Writer::new()
        .str("id", &a.blob.id.to_string())
        .str("key", &b64_encode(&a.blob.key))
        .num("parts", u64::from(a.blob.parts))
        .num("partSize", a.blob.part_size)
        .num("size", a.blob.size)
        .finish();
    let mut w = Writer::new()
        .raw("blob", &blob)
        .str("name", &a.name)
        .str("mime", &a.mime)
        .str("kind", a.kind.as_str());
    if let Some(v) = a.w {
        w = w.num("w", u64::from(v));
    }
    if let Some(v) = a.h {
        w = w.num("h", u64::from(v));
    }
    if let Some(t) = &a.thumb {
        w = w.str("thumb", &b64_encode(t));
    }
    if let Some(d) = a.dur {
        w = w.num("dur", d);
    }
    if let Some(p) = &a.peaks {
        w = w.raw("peaks", &list(&p.iter().map(|n| n.to_string()).collect::<Vec<_>>()));
    }
    w.finish()
}

/// Checks what was written the way a receiver would, so nothing leaves that a peer rejects.
fn checked(json: String, kind: &str) -> Result<Vec<u8>> {
    let bytes = json.into_bytes();
    match parse_payload(&bytes) {
        Ok(_) => Ok(bytes),
        Err(ProtoError { message, .. }) => Err(invalid(format!("{kind}: {message}"))),
    }
}

fn check_body_len(body: &str, kind: &str) -> Result<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(err(
            Code::TooLarge,
            format!("{kind}: body exceeds {MAX_BODY_BYTES} bytes"),
        ));
    }
    Ok(())
}

/// Serialises a `msg` payload. Key order: `v, t, id, dev, seq, body, reply,
/// fwd, attachments, location, sticker`. A sender gives at least one of a
/// non-empty body, attachments and a location.
pub fn encode_msg(m: &Msg) -> Result<Vec<u8>> {
    let mut w = common_out("msg", &m.common);
    if let Some(b) = &m.body {
        check_body_len(b, "msg")?;
        if b.is_empty() {
            return Err(invalid("msg: body must not be empty (omit it instead)"));
        }
        w = w.str("body", b);
    }
    if let Some(r) = &m.reply {
        w = w.raw("reply", &ref_out(r));
    }
    if m.fwd {
        w = w.bool("fwd", true);
    }
    if !m.attachments.is_empty() {
        if m.attachments.len() > MAX_ATTACHMENTS {
            return Err(invalid(format!(
                "msg: attachments must be a list of 1..{MAX_ATTACHMENTS}"
            )));
        }
        w = w.raw(
            "attachments",
            &list(&m.attachments.iter().map(attachment_json).collect::<Vec<_>>()),
        );
    }
    if let Some(l) = &m.location {
        let loc = Writer::new()
            .raw("lat", &number(l.lat))
            .raw("lon", &number(l.lon))
            .raw("accuracy", &number(l.accuracy))
            .finish();
        w = w.raw("location", &loc);
    }
    if let Some(s) = &m.sticker {
        let st = Writer::new()
            .str("pack", &s.pack.to_string())
            .str("file", &s.file.to_string())
            .str("type", &s.kind)
            .num("w", u64::from(s.w))
            .num("h", u64::from(s.h))
            .finish();
        w = w.raw("sticker", &st);
    }
    if m.body.is_none() && m.attachments.is_empty() && m.location.is_none() {
        return Err(invalid("msg: a message needs a body, attachments or a location"));
    }
    checked(w.finish(), "msg")
}

/// `v, t, id, dev, seq, target, body`.
pub fn encode_edit(common: &Common, target: &MsgRef, body: &str) -> Result<Vec<u8>> {
    check_body_len(body, "edit")?;
    checked(
        common_out("edit", common)
            .raw("target", &ref_out(target))
            .str("body", body)
            .finish(),
        "edit",
    )
}

/// `v, t, id, dev, seq, target, targetDev, targetSeq`.
pub fn encode_delete(common: &Common, target: &MsgRef, target_dev: &DevId, target_seq: u64) -> Result<Vec<u8>> {
    checked(
        common_out("delete", common)
            .raw("target", &ref_out(target))
            .str("targetDev", &target_dev.to_string())
            .num("targetSeq", target_seq)
            .finish(),
        "delete",
    )
}

/// `v, t, id, dev, seq, target, emoji, on`.
pub fn encode_react(common: &Common, target: &MsgRef, emoji: &str, on: bool) -> Result<Vec<u8>> {
    checked(
        common_out("react", common)
            .raw("target", &ref_out(target))
            .raw("emoji", &quote(emoji))
            .bool("on", on)
            .finish(),
        "react",
    )
}
