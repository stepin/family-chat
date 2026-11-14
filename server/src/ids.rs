//! Identifiers and small encodings shared with the protocol package:
//! base32 (RFC 4648, lowercase, no padding), base64url without padding,
//! `userId`, direct chat ids, CRC-32 and UTC day names.

use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub const MS_PER_DAY: u64 = 86_400_000;

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// RFC 4648 base32, lowercase, without padding.
pub fn b32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Strict decoding: lowercase alphabet only, exact length for `N` bytes,
/// unused trailing bits must be zero (one canonical text per value).
pub fn b32_decode<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != (N * 8).div_ceil(5) {
        return None;
    }
    let mut out = [0u8; N];
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut i = 0;
    for c in s.bytes() {
        let v = match c {
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        };
        acc = (acc << 5) | v as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out[i] = (acc >> bits) as u8;
            i += 1;
        }
        acc &= (1 << bits) - 1;
    }
    (acc == 0).then_some(out)
}

pub fn b64_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// base64url without padding; padding and non-canonical trailing bits are rejected.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

macro_rules! id_type {
    ($name:ident, $n:expr, $what:expr) => {
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub [u8; $n]);

        impl $name {
            pub fn parse(s: &str) -> Option<Self> {
                b32_decode::<$n>(s).map(Self)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&b32_encode(&self.0))
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", $what, self)
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.to_string())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
                Self::parse(&s).ok_or_else(|| serde::de::Error::custom(concat!("bad ", $what)))
            }
        }
    };
}

id_type!(UserId, 16, "userId");
id_type!(ChatId, 16, "chatId");
id_type!(DevId, 10, "devId");
id_type!(MsgId, 16, "msgId");

impl UserId {
    /// `userId` = base32 of the first 16 bytes of SHA-256(signPub).
    pub fn from_sign_pub(sign_pub: &[u8; 32]) -> UserId {
        let h = Sha256::digest(sign_pub);
        let mut id = [0u8; 16];
        id.copy_from_slice(&h[..16]);
        UserId(id)
    }
}

impl ChatId {
    /// Direct chat id: first 16 bytes of
    /// SHA-256(utf8("fc/v1/dm\n" + serverId + "\n" + lo + "\n" + hi)),
    /// where `lo`/`hi` are the two `userId` strings in ascending order.
    pub fn direct(server_id: &str, a: &UserId, b: &UserId) -> ChatId {
        let (a, b) = (a.to_string(), b.to_string());
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let h = Sha256::digest(format!("fc/v1/dm\n{server_id}\n{lo}\n{hi}").as_bytes());
        let mut id = [0u8; 16];
        id.copy_from_slice(&h[..16]);
        ChatId(id)
    }
}

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32 (IEEE 802.3, as in zlib).
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in bytes {
        c = CRC_TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/// Days since 1970-01-01 (UTC) of a time in milliseconds.
pub fn day_of_ms(ms: u64) -> i64 {
    (ms / MS_PER_DAY) as i64
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `YYYY-MM-DD` of a day number.
pub fn day_name(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Day number of `YYYY-MM-DD`; `None` for anything else.
pub fn parse_day_name(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = &s[r];
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let day = days_from_civil(y as i64, m, d);
    (day_name(day) == s).then_some(day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_rfc4648_vectors() {
        // RFC 4648 section 10, lowercased, padding removed.
        for (plain, enc) in [
            ("", ""),
            ("f", "my"),
            ("fo", "mzxq"),
            ("foo", "mzxw6"),
            ("foob", "mzxw6yq"),
            ("fooba", "mzxw6ytb"),
            ("foobar", "mzxw6ytboi"),
        ] {
            assert_eq!(b32_encode(plain.as_bytes()), enc);
        }
        assert_eq!(&b32_decode::<6>("mzxw6ytboi").unwrap(), b"foobar");
        assert_eq!(b32_decode::<6>("MZXW6YTBOI"), None, "lowercase only");
        assert_eq!(b32_decode::<6>("mzxw6ytbo"), None, "length");
        // 1 byte = 2 chars with 2 unused bits: "my" is canonical, "mz" is not.
        assert_eq!(b32_decode::<1>("my"), Some(*b"f"));
        assert_eq!(b32_decode::<1>("mz"), None);
    }

    #[test]
    fn id_lengths_round_trip() {
        let u = UserId([0xAB; 16]);
        assert_eq!(u.to_string().len(), 26);
        assert_eq!(UserId::parse(&u.to_string()), Some(u));
        let d = DevId([7; 10]);
        assert_eq!(d.to_string().len(), 16);
        assert_eq!(DevId::parse(&d.to_string()), Some(d));
        assert_eq!(UserId::parse("a"), None);
    }

    #[test]
    fn user_id_from_key() {
        let pk = [1u8; 32];
        let id = UserId::from_sign_pub(&pk);
        let h = Sha256::digest(pk);
        assert_eq!(id.to_string(), b32_encode(&h[..16]));
    }

    #[test]
    fn direct_chat_id_is_symmetric() {
        let a = UserId([1; 16]);
        let b = UserId([2; 16]);
        assert_eq!(ChatId::direct("srv", &a, &b), ChatId::direct("srv", &b, &a));
        assert_ne!(ChatId::direct("srv", &a, &b), ChatId::direct("other", &a, &b));
        let lo = a.to_string().min(b.to_string());
        let hi = a.to_string().max(b.to_string());
        let h = Sha256::digest(format!("fc/v1/dm\nsrv\n{lo}\n{hi}"));
        assert_eq!(ChatId::direct("srv", &a, &b).0[..], h[..16]);
    }

    /// The example in docs/API.md.
    #[test]
    fn documented_vectors() {
        let pa: [u8; 32] = std::array::from_fn(|i| i as u8);
        let pb: [u8; 32] = std::array::from_fn(|i| 32 + i as u8);
        let a = UserId::from_sign_pub(&pa);
        let b = UserId::from_sign_pub(&pb);
        assert_eq!(b64_encode(&pa), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
        assert_eq!(a.to_string(), "mmg42klgyqzwneiskrelxms3j4");
        assert_eq!(b.to_string(), "oln3om3moz4aai7yhwsmgvps5y");
        assert_eq!(
            ChatId::direct("c2VydmVyLWlkLWV4YW1wbGU", &a, &b).to_string(),
            "lo2a5ewrojycetbvska5utmpxe"
        );
        let ten: [u8; 10] = std::array::from_fn(|i| i as u8);
        assert_eq!(DevId(ten).to_string(), "aaaqeayeaudaocaj");
    }

    #[test]
    fn crc32_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn day_names() {
        assert_eq!(day_name(0), "1970-01-01");
        assert_eq!(parse_day_name("1970-01-01"), Some(0));
        let d = day_of_ms(1_731_542_400_000); // 2024-11-14T00:00:00Z
        assert_eq!(day_name(d), "2024-11-14");
        assert_eq!(parse_day_name("2024-02-29"), Some(days_from_civil(2024, 2, 29)));
        assert_eq!(parse_day_name("2023-02-29"), None);
        assert_eq!(parse_day_name("2024-1-01"), None);
        assert_eq!(parse_day_name("2024-01-01.seg"), None);
        for day in [-1000i64, 0, 19_000, 20_000, 50_000] {
            assert_eq!(parse_day_name(&day_name(day)), Some(day));
        }
    }
}
