//! File tools: sending a file (inside the call, or handed in through a
//! one-time link), taking one, and setting the avatar.

use serde_json::{Value, json};

use super::write::{live, post, sent};
use super::{Args, Ctx, ToolError, ToolResult};
use crate::client::payload::{Attachment, AttachmentKind, MAX_IMAGE_SIDE, Msg};
use crate::error::io_error;
use crate::mcp::files::{LINK_TTL, MAX_INLINE_BYTES, decode_inline, max_file_bytes, read_blob, store_blob};
use crate::mcp::media;

/// Largest picture cleaned of metadata in memory; a larger one goes with `original: true`.
const MAX_CLEANED_IMAGE_BYTES: usize = 64 * 1024 * 1024;

pub async fn file_upload_start(ctx: &Ctx) -> ToolResult {
    let base = ctx.base.as_deref().ok_or_else(|| {
        ToolError::new(
            "no_address",
            "the server could not tell its own address from the request",
        )
    })?;
    let code = ctx.st.mcp_links.new_upload(&ctx.conn.file.id).ok_or_else(|| {
        ToolError::new(
            "too_many_uploads",
            "this connection already holds four unused upload links; use one or wait ten minutes",
        )
    })?;
    let url = format!("{base}/mcp/files/{code}");
    Ok(json!({
        "upload": code,
        "url": url,
        "method": "PUT",
        "maxBytes": max_file_bytes(&ctx.st),
        "expiresInS": LINK_TTL.as_secs(),
        "example": format!("curl -T photo.jpg '{url}'"),
        "then": "Call file_send (or profile_avatar_set) with this upload value. The link works once.",
    }))
}

/// The bytes a call brings: `data` (base64) or `upload` (a finished one-time upload).
async fn incoming(ctx: &Ctx, a: &Args<'_>) -> Result<Vec<u8>, ToolError> {
    match (a.opt_str("data"), a.opt_str("upload")) {
        (Some(data), None) => decode_inline(data).map_err(|code| match code {
            "too_large" => ToolError::new(
                "too_large",
                format!(
                    "a file inside a call is at most {MAX_INLINE_BYTES} bytes; larger ones go through file_upload_start"
                ),
            ),
            _ => ToolError::invalid("data must be base64"),
        }),
        (None, Some(code)) => {
            let up = ctx.st.mcp_links.take_uploaded(&ctx.conn.file.id, code).ok_or_else(|| {
                ToolError::new(
                    "no_upload",
                    "no file was handed in through this upload (PUT it to the url first; a link works once, for ten minutes)",
                )
            })?;
            let bytes = tokio::fs::read(&up.path).await;
            let _ = tokio::fs::remove_file(&up.path).await;
            bytes.map_err(|e| io_error("reading an uploaded file", e).into())
        }
        _ => Err(ToolError::invalid("give exactly one of data and upload")),
    }
}

struct Prepared {
    bytes: Vec<u8>,
    name: String,
    mime: String,
    kind: AttachmentKind,
    dims: Option<(u32, u32)>,
}

fn mime_ok(m: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 63
            && p.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_.+-".contains(&c))
    };
    m.split_once('/').is_some_and(|(a, b)| part(a) && part(b))
}

/// What goes out: a picture is recognised by its bytes and, unless the
/// caller asks for the original, loses its metadata.
fn prepare(bytes: Vec<u8>, name: &str, declared: Option<&str>, original: bool) -> Result<Prepared, ToolError> {
    // Only the file's own name: a path would tell where it lay on someone's disk.
    let name = name.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(ToolError::invalid("name must be a file name"));
    }
    let Some(image) = media::sniff(&bytes) else {
        let guessed = mime_guess::from_path(&name)
            .first_raw()
            .unwrap_or("application/octet-stream");
        let mime = declared.map(str::to_ascii_lowercase).filter(|m| mime_ok(m));
        let mime = mime.unwrap_or_else(|| guessed.to_string());
        // Never claimed to be a picture when the bytes are not one.
        let mime = if mime.starts_with("image/") {
            "application/octet-stream".to_string()
        } else {
            mime
        };
        return Ok(Prepared {
            bytes,
            name,
            mime,
            kind: AttachmentKind::File,
            dims: None,
        });
    };
    let bytes = if original {
        bytes
    } else {
        if bytes.len() > MAX_CLEANED_IMAGE_BYTES {
            return Err(ToolError::new(
                "too_large",
                "this picture is too large to clean of metadata here; send it with original = true",
            ));
        }
        media::strip_metadata(&bytes).ok_or_else(|| {
            ToolError::new(
                "bad_image",
                "this picture is damaged, so its metadata cannot be removed; send it with original = true to send it as it is",
            )
        })?
    };
    let dims = media::dimensions(&bytes).filter(|(w, h)| u64::from(*w.max(h)) <= MAX_IMAGE_SIDE);
    Ok(Prepared {
        bytes,
        name,
        mime: image.mime().to_string(),
        // A picture whose size cannot be read is still sent, as a file.
        kind: if dims.is_some() {
            AttachmentKind::Image
        } else {
            AttachmentKind::File
        },
        dims,
    })
}

pub async fn file_send(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let bytes = incoming(ctx, a).await?;
    if bytes.is_empty() {
        return Err(ToolError::invalid("the file is empty"));
    }
    if bytes.len() as u64 > max_file_bytes(&ctx.st) {
        return Err(ToolError::new(
            "too_large",
            format!("this server takes files up to {} MB", ctx.st.settings.max_file_mb),
        ));
    }
    let p = prepare(bytes, a.str("name"), a.opt_str("type"), a.bool_or("original", false))?;
    let (mut view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let reply = match a.opt_u64("reply_to")? {
        None => None,
        Some(g) => Some(live(ctx, &view, &chat, g)?.msg_ref()),
    };
    let size = p.bytes.len();
    let blob = store_blob(&ctx.st, ctx.me(), p.bytes).await?;
    let attachment = Attachment {
        blob,
        name: p.name.clone(),
        mime: p.mime.clone(),
        kind: p.kind,
        w: p.dims.map(|d| d.0),
        h: p.dims.map(|d| d.1),
        thumb: None,
        dur: None,
        peaks: None,
    };
    let text = a.opt_str("text").filter(|t| !t.trim().is_empty());
    let appended = post(ctx, &mut view, &dir, &chat, false, |common| {
        crate::client::payload::encode_msg(&Msg {
            common: *common,
            body: text.map(str::to_string),
            reply,
            fwd: false,
            attachments: vec![attachment],
            location: None,
            sticker: None,
        })
    })
    .await?;
    let mut v = sent(&appended);
    v["file"] = json!({ "name": p.name, "type": p.mime, "kind": p.kind.as_str(), "size": size });
    Ok(v)
}

pub async fn file_get(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let m = live(ctx, &view, &chat, a.u64("message")?)?;
    let index = a.opt_u64("index")?.unwrap_or(0) as usize;
    let att = m.attachments.get(index).ok_or_else(|| {
        ToolError::new(
            "file_not_found",
            format!("this message has {} file(s); index counts from 0", m.attachments.len()),
        )
    })?;
    let mut v = json!({ "name": att.name, "type": att.mime, "kind": att.kind.as_str(), "size": att.blob.size });
    drop(dir);
    if a.bool_or("as_link", false) || att.blob.size > MAX_INLINE_BYTES as u64 {
        let base = ctx.base.as_deref().ok_or_else(|| {
            ToolError::new(
                "no_address",
                "the server could not tell its own address from the request",
            )
        })?;
        let code =
            ctx.st
                .mcp_links
                .new_download(&ctx.conn.file.id, att.blob.clone(), att.name.clone(), att.mime.clone());
        v["url"] = json!(format!("{base}/mcp/files/{code}"));
        v["expiresInS"] = json!(LINK_TTL.as_secs());
        v["note"] = json!("GET the url once to download the file; it needs no token.");
        return Ok(v);
    }
    let blob = att.blob.clone();
    drop(view);
    let bytes = read_blob(&ctx.st, blob).await?;
    use base64::Engine;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    match media::sniff(&bytes) {
        // A picture goes to the model as a picture.
        Some(t) => v["_content"] = json!([{ "type": "image", "data": b64(&bytes), "mimeType": t.mime() }]),
        None => match String::from_utf8(bytes) {
            Ok(text) => v["text"] = Value::String(text),
            Err(e) => v["data"] = json!(b64(e.as_bytes())),
        },
    }
    Ok(v)
}

/// The avatar bytes of a call, cleaned: a JPEG or WebP within the server's limit.
pub(super) async fn avatar_bytes(ctx: &Ctx, a: &Args<'_>) -> Result<(Vec<u8>, crate::envelope::ImageKind), ToolError> {
    let bytes = incoming(ctx, a).await?;
    let clean = media::strip_metadata(&bytes)
        .ok_or_else(|| ToolError::new("bad_image", "the avatar must be a JPEG or WebP image"))?;
    let kind = crate::envelope::ImageKind::sniff(&clean)
        .ok_or_else(|| ToolError::new("bad_image", "the avatar must be a JPEG or WebP image"))?;
    if clean.len() > crate::api::MAX_AVATAR_BYTES {
        return Err(ToolError::new(
            "too_large",
            format!(
                "an avatar is at most {} bytes; make the picture smaller first",
                crate::api::MAX_AVATAR_BYTES
            ),
        ));
    }
    Ok((clean, kind))
}
