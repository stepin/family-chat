//! Strict JSON helpers for signed payloads: parsing received bytes and
//! writing objects with a fixed key order.

use serde_json::{Map, Value};

use super::error::{Result, malformed};
use crate::ids::{b32_decode, b64_decode};

pub type Obj = Map<String, Value>;

/// Largest integer JavaScript holds exactly; the TypeScript side accepts no more.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// serverId, chatId, auth nonce: opaque strings of 1 to 256 bytes.
pub const MAX_CONTEXT_STRING_BYTES: usize = 256;

/// Parses UTF-8 bytes as a JSON object (invalid UTF-8, a BOM and non-objects are `malformed`).
pub fn parse_object(bytes: &[u8], what: &str) -> Result<Obj> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(malformed(format!("{what}: not a JSON object"))),
        Err(_) => Err(malformed(format!("{what}: invalid JSON"))),
    }
}

/// A non-negative integer JavaScript can hold exactly. `1.0` counts, as it does there.
pub fn safe_uint(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    let n = match v.as_u64() {
        Some(n) => n,
        None => {
            let f = v.as_f64()?;
            if f < 0.0 || f.fract() != 0.0 || f > MAX_SAFE_INTEGER as f64 {
                return None;
            }
            f as u64
        }
    };
    (n <= MAX_SAFE_INTEGER).then_some(n)
}

pub fn u32_of(v: Option<&Value>) -> Option<u32> {
    safe_uint(v).and_then(|n| u32::try_from(n).ok())
}

pub fn str_of<'a>(o: &'a Obj, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

pub fn context_string_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_CONTEXT_STRING_BYTES
}

/// base32 of exactly `N` bytes.
pub fn b32<const N: usize>(v: Option<&Value>) -> Option<[u8; N]> {
    b32_decode::<N>(v?.as_str()?)
}

/// base64url of exactly `N` bytes.
pub fn b64<const N: usize>(v: Option<&Value>) -> Option<[u8; N]> {
    b64_decode(v?.as_str()?)?.try_into().ok()
}

/// C0, DEL, C1 controls and bidirectional formatting characters.
fn forbidden_in_name(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{61c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

/// What JavaScript's `trim()` removes that Rust's does not.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// Problem with a display name (profile, group, file, emoji), or `None`.
pub fn name_problem(name: &str, max_chars: usize) -> Option<String> {
    if js_trim(name).is_empty() {
        return Some("name must not be empty".into());
    }
    if name.chars().count() > max_chars {
        return Some(format!("name must be at most {max_chars} characters"));
    }
    if name.chars().any(forbidden_in_name) {
        return Some("name contains control or bidirectional characters".into());
    }
    None
}

/// A JSON object written key by key in a fixed order (signed payloads have
/// one written form, section 4.1). Strings are escaped as `JSON.stringify` does.
pub struct Writer {
    out: String,
    first: bool,
}

impl Default for Writer {
    fn default() -> Self {
        Writer::new()
    }
}

impl Writer {
    pub fn new() -> Writer {
        Writer {
            out: String::from("{"),
            first: true,
        }
    }

    fn key(&mut self, key: &str) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        self.out.push_str(&quote(key));
        self.out.push(':');
    }

    pub fn str(mut self, key: &str, v: &str) -> Writer {
        self.key(key);
        self.out.push_str(&quote(v));
        self
    }

    pub fn num(mut self, key: &str, v: u64) -> Writer {
        self.key(key);
        self.out.push_str(&v.to_string());
        self
    }

    pub fn bool(mut self, key: &str, v: bool) -> Writer {
        self.key(key);
        self.out.push_str(if v { "true" } else { "false" });
        self
    }

    /// A value that is already JSON text (`null`, a nested object, a list).
    pub fn raw(mut self, key: &str, json: &str) -> Writer {
        self.key(key);
        self.out.push_str(json);
        self
    }

    pub fn finish(mut self) -> String {
        self.out.push('}');
        self.out
    }
}

/// A JSON string literal.
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serialises")
}

/// A JSON list of already serialised items.
pub fn list(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

/// A finite number as `JSON.stringify` writes the common cases: integers without a fraction.
pub fn number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}
