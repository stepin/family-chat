//! Log segments `log/<YYYY-MM-DD>.seg` (docs/PLAN-v2.md, section 6).
//!
//! Record layout, all integers big-endian:
//!
//! ```text
//! len u32 | gseq u64 | time u64 (ms) | chatId [16] | senderId [16] | devId [10]
//!         | epoch u32 | msgId [16] | body [..] | crc32 u32
//! ```
//!
//! `len` counts the bytes after itself, crc32 included. The CRC covers
//! everything before it, `len` included. `msgId` (the `Idempotency-Key`)
//! is stored so a repeat after a restart still returns the same `gseq`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::ids::{ChatId, DevId, MsgId, UserId, crc32};

pub const MAX_BODY: usize = 256 * 1024;
/// Bytes after `len` that are not the body: header fields and crc32.
pub const FIXED: usize = 8 + 8 + 16 + 16 + 10 + 4 + 16 + 4;
const MIN_LEN: usize = FIXED;
const MAX_LEN: usize = FIXED + MAX_BODY;

/// Everything about an event except the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub gseq: u64,
    pub time: u64,
    pub chat: ChatId,
    pub sender: UserId,
    pub dev: DevId,
    pub epoch: u32,
    pub msg: MsgId,
}

pub fn encode(h: &Header, body: &[u8]) -> Vec<u8> {
    assert!(body.len() <= MAX_BODY, "body checked by the caller");
    let len = FIXED + body.len();
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_be_bytes());
    out.extend_from_slice(&h.gseq.to_be_bytes());
    out.extend_from_slice(&h.time.to_be_bytes());
    out.extend_from_slice(&h.chat.0);
    out.extend_from_slice(&h.sender.0);
    out.extend_from_slice(&h.dev.0);
    out.extend_from_slice(&h.epoch.to_be_bytes());
    out.extend_from_slice(&h.msg.0);
    out.extend_from_slice(body);
    let crc = crc32(&out);
    out.extend_from_slice(&crc.to_be_bytes());
    out
}

fn arr<const N: usize>(b: &[u8], at: usize) -> [u8; N] {
    b[at..at + N].try_into().expect("length checked")
}

/// Decodes one complete record (`len` field included). `None` when the
/// length or the CRC does not match.
pub fn decode(rec: &[u8]) -> Option<(Header, &[u8])> {
    if rec.len() < 4 + MIN_LEN {
        return None;
    }
    let len = u32::from_be_bytes(arr(rec, 0)) as usize;
    if len != rec.len() - 4 || len > MAX_LEN {
        return None;
    }
    let crc_at = rec.len() - 4;
    if crc32(&rec[..crc_at]) != u32::from_be_bytes(arr(rec, crc_at)) {
        return None;
    }
    let h = Header {
        gseq: u64::from_be_bytes(arr(rec, 4)),
        time: u64::from_be_bytes(arr(rec, 12)),
        chat: ChatId(arr(rec, 20)),
        sender: UserId(arr(rec, 36)),
        dev: DevId(arr(rec, 52)),
        epoch: u32::from_be_bytes(arr(rec, 62)),
        msg: MsgId(arr(rec, 66)),
    };
    Some((h, &rec[82..crc_at]))
}

/// One valid record found by [`scan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Found {
    pub header: Header,
    /// Offset of the record (its `len` field) in the segment.
    pub offset: u64,
    /// Whole record size, `len` field included.
    pub size: u32,
}

/// Reads records from the start of a segment until the end or the first
/// record that is incomplete, fails its CRC or does not increase `gseq`.
/// Returns the records and the length of the valid prefix.
pub fn scan(bytes: &[u8]) -> (Vec<Found>, usize) {
    let mut out: Vec<Found> = Vec::new();
    let mut pos = 0usize;
    while bytes.len() - pos >= 4 {
        let len = u32::from_be_bytes(arr(bytes, pos)) as usize;
        if !(MIN_LEN..=MAX_LEN).contains(&len) || bytes.len() - pos - 4 < len {
            break;
        }
        let rec = &bytes[pos..pos + 4 + len];
        let Some((header, _)) = decode(rec) else { break };
        if out.last().is_some_and(|l| header.gseq <= l.header.gseq) {
            break;
        }
        out.push(Found {
            header,
            offset: pos as u64,
            size: (4 + len) as u32,
        });
        pos += 4 + len;
    }
    (out, pos)
}

/// Reads one record's body from a segment file, checking its CRC and `gseq`.
pub fn read_body(path: &Path, offset: u64, size: u32, gseq: u64) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut rec = vec![0u8; size as usize];
    f.read_exact(&mut rec)?;
    match decode(&rec) {
        Some((h, body)) if h.gseq == gseq => Ok(body.to_vec()),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "log record does not match the index",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(gseq: u64) -> Header {
        Header {
            gseq,
            time: 1_700_000_000_000 + gseq,
            chat: ChatId([1; 16]),
            sender: UserId([2; 16]),
            dev: DevId([3; 10]),
            epoch: 7,
            msg: MsgId([gseq as u8; 16]),
        }
    }

    #[test]
    fn codec_round_trip() {
        for body in [&b""[..], b"x", &[0xAB; 1000][..], &vec![5u8; MAX_BODY][..]] {
            let h = header(42);
            let rec = encode(&h, body);
            assert_eq!(rec.len(), 4 + FIXED + body.len());
            let (h2, b2) = decode(&rec).unwrap();
            assert_eq!(h2, h);
            assert_eq!(b2, body);
        }
    }

    #[test]
    fn decode_rejects_damage() {
        let rec = encode(&header(1), b"hello");
        for i in 0..rec.len() {
            let mut bad = rec.clone();
            bad[i] ^= 0x01;
            assert!(decode(&bad).is_none(), "flip at byte {i}");
        }
        assert!(decode(&rec[..rec.len() - 1]).is_none());
    }

    #[test]
    fn scan_reads_all_and_stops_at_garbage() {
        let mut seg = Vec::new();
        for g in 1..=5 {
            seg.extend(encode(&header(g), format!("body {g}").as_bytes()));
        }
        let (found, valid) = scan(&seg);
        assert_eq!(found.len(), 5);
        assert_eq!(valid, seg.len());
        assert_eq!(found[2].header.gseq, 3);
        let r = &found[2];
        let (h, body) = decode(&seg[r.offset as usize..(r.offset + r.size as u64) as usize]).unwrap();
        assert_eq!(h.gseq, 3);
        assert_eq!(body, b"body 3");

        // gseq must increase.
        let mut dup = seg.clone();
        dup.extend(encode(&header(5), b"again"));
        assert_eq!(scan(&dup).0.len(), 5);
        assert_eq!(scan(&dup).1, seg.len());
    }

    /// Truncating the segment at any byte of the last record loses only
    /// that record; garbage instead of the tail loses only the tail.
    #[test]
    fn torn_last_record_loses_only_that_record() {
        let mut seg = Vec::new();
        let mut ends = Vec::new();
        for g in 1..=4u64 {
            let body: Vec<u8> = (0..(g * 37) as usize).map(|i| (i * 7 + g as usize) as u8).collect();
            seg.extend(encode(&header(g), &body));
            ends.push(seg.len());
        }
        let last_start = ends[2];
        for cut in last_start..seg.len() {
            let (found, valid) = scan(&seg[..cut]);
            assert_eq!(found.len(), 3, "cut at {cut}");
            assert_eq!(valid, last_start, "cut at {cut}");
            assert_eq!(found.last().unwrap().header.gseq, 3);
        }
        // A cut that also damages a byte inside the remaining part of the last record.
        for cut in (last_start + 1)..seg.len() {
            let mut torn = seg[..cut].to_vec();
            let i = last_start + (cut - last_start) / 2;
            torn[i] ^= 0xFF;
            let (found, valid) = scan(&torn);
            assert_eq!((found.len(), valid), (3, last_start), "cut at {cut}");
        }
        // The complete segment keeps everything.
        assert_eq!(scan(&seg).0.len(), 4);
    }
}
