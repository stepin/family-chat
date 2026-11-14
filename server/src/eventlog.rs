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
//!
//! ## Deleted ("delete for everyone") records
//!
//! A deleted record keeps its frame: the same `len` and header, the body
//! overwritten with zero bytes of the same length and the crc32 computed
//! again over the new bytes ([`erase`]). Offsets of later records do not
//! move and a scan reads it like any other record. A real event body never
//! consists of zeros only (it starts with `FC1`), so an all-zero body also
//! marks a record as deleted ([`is_erased`]).
//!
//! The day file `log/<YYYY-MM-DD>.del` lists the deleted records of that
//! day, one fixed entry each ([`DelEntry`]):
//!
//! ```text
//! gseq u64 | offset u64 | size u32 | crc32 u32 (over the 20 bytes before it)
//! ```
//!
//! The entry is written and fsynced before the segment is touched, so it is
//! an intent record: at start the server applies every entry again
//! ([`repair`]). An overwrite cut short by a crash (body half zeroed, old
//! CRC) is finished then instead of being taken for a torn record. Erasing
//! only rewrites the body and the CRC; `len` and `gseq`, which the repair
//! checks, are never changed.

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

/// Offset of the body inside a record (`len` field included).
pub const BODY_AT: usize = 82;

/// Whether a stored body is the zeroed body of a deleted record.
pub fn is_erased(body: &[u8]) -> bool {
    !body.is_empty() && body.iter().all(|b| *b == 0)
}

/// Overwrites the body of a complete record with zeros and stores a fresh
/// crc32. The `len` field and the header stay as they are.
pub fn erase(rec: &mut [u8]) {
    let crc_at = rec.len() - 4;
    rec[BODY_AT..crc_at].fill(0);
    let crc = crc32(&rec[..crc_at]);
    rec[crc_at..].copy_from_slice(&crc.to_be_bytes());
}

/// Checks the two header fields a deletion relies on without the CRC (which
/// a torn overwrite breaks): the `len` field and `gseq`.
pub fn frame_matches(rec: &[u8], gseq: u64) -> bool {
    rec.len() >= 4 + MIN_LEN
        && u32::from_be_bytes(arr(rec, 0)) as usize == rec.len() - 4
        && u64::from_be_bytes(arr(rec, 4)) == gseq
}

/// One entry of a `.del` file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelEntry {
    pub gseq: u64,
    pub offset: u64,
    pub size: u32,
}

pub const DEL_ENTRY: usize = 8 + 8 + 4 + 4;

impl DelEntry {
    pub fn encode(&self) -> [u8; DEL_ENTRY] {
        let mut out = [0u8; DEL_ENTRY];
        out[0..8].copy_from_slice(&self.gseq.to_be_bytes());
        out[8..16].copy_from_slice(&self.offset.to_be_bytes());
        out[16..20].copy_from_slice(&self.size.to_be_bytes());
        let crc = crc32(&out[..20]);
        out[20..].copy_from_slice(&crc.to_be_bytes());
        out
    }
}

/// Reads a `.del` file up to its end or the first damaged entry (a torn
/// append). Returns the entries and the length of the valid prefix.
pub fn scan_del(bytes: &[u8]) -> (Vec<DelEntry>, usize) {
    let mut out = Vec::new();
    let mut pos = 0;
    while bytes.len() - pos >= DEL_ENTRY {
        let e = &bytes[pos..pos + DEL_ENTRY];
        if crc32(&e[..20]) != u32::from_be_bytes(arr(e, 20)) {
            break;
        }
        out.push(DelEntry {
            gseq: u64::from_be_bytes(arr(e, 0)),
            offset: u64::from_be_bytes(arr(e, 8)),
            size: u32::from_be_bytes(arr(e, 16)),
        });
        pos += DEL_ENTRY;
    }
    (out, pos)
}

/// Applies the deletions in `dels` to a segment held in memory. Returns the
/// entries whose record had to be changed (the caller writes those back).
/// An entry that does not point at a record frame with its `gseq` is left
/// alone.
pub fn repair(seg: &mut [u8], dels: &[DelEntry]) -> Vec<DelEntry> {
    let mut changed = Vec::new();
    for d in dels {
        let (start, size) = (d.offset as usize, d.size as usize);
        if size < 4 + MIN_LEN || start.checked_add(size).is_none_or(|end| end > seg.len()) {
            continue;
        }
        let rec = &mut seg[start..start + size];
        if !frame_matches(rec, d.gseq) {
            continue;
        }
        let before = rec.to_vec();
        erase(rec);
        if *rec != before[..] {
            changed.push(*d);
        }
    }
    changed
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

    fn segment(n: u64) -> (Vec<u8>, Vec<Found>) {
        let mut seg = Vec::new();
        for g in 1..=n {
            seg.extend(encode(&header(g), format!("FC1 body {g}").as_bytes()));
        }
        let found = scan(&seg).0;
        (seg, found)
    }

    #[test]
    fn erased_record_keeps_its_frame() {
        let (mut seg, found) = segment(3);
        let r = found[1];
        let rec = &mut seg[r.offset as usize..(r.offset + r.size as u64) as usize];
        erase(rec);
        let (h, body) = decode(rec).expect("still a valid record");
        assert_eq!(h, header(2));
        assert!(is_erased(body));
        assert_eq!(body.len(), "FC1 body 2".len());
        let (again, valid) = scan(&seg);
        assert_eq!((again.len(), valid), (3, seg.len()));
        assert_eq!(again, found, "offsets do not move");
        assert!(!is_erased(b"FC1"));
        assert!(!is_erased(b""));
    }

    #[test]
    fn del_file_codec_and_torn_tail() {
        let a = DelEntry {
            gseq: 7,
            offset: 1234,
            size: 99,
        };
        let b = DelEntry {
            gseq: 9,
            offset: 5678,
            size: 101,
        };
        let mut bytes = a.encode().to_vec();
        bytes.extend(b.encode());
        assert_eq!(scan_del(&bytes), (vec![a, b], 2 * DEL_ENTRY));
        for cut in DEL_ENTRY..bytes.len() {
            assert_eq!(scan_del(&bytes[..cut]), (vec![a], DEL_ENTRY), "cut at {cut}");
        }
        let mut bad = bytes.clone();
        bad[DEL_ENTRY + 3] ^= 1;
        assert_eq!(scan_del(&bad).0, vec![a]);
    }

    /// An overwrite cut short at any byte (body partly zeroed, CRC old or
    /// partly written) is finished by `repair`; without it the scan would
    /// stop at that record.
    #[test]
    fn repair_finishes_a_torn_overwrite() {
        let (seg, found) = segment(3);
        let r = found[1];
        let (start, end) = (r.offset as usize, (r.offset + r.size as u64) as usize);
        let mut done = seg.clone();
        erase(&mut done[start..end]);
        let del = DelEntry {
            gseq: 2,
            offset: r.offset,
            size: r.size,
        };
        for cut in start + BODY_AT..=end {
            // The first bytes of the overwrite reached the disk, the rest did not.
            let mut torn = seg.clone();
            torn[start + BODY_AT..cut].copy_from_slice(&done[start + BODY_AT..cut]);
            let changed = repair(&mut torn, &[del]);
            assert_eq!(torn, done, "cut at {cut}");
            assert_eq!(changed.len(), usize::from(cut != end), "cut at {cut}");
            assert_eq!(scan(&torn).0.len(), 3);
        }
        // Applying it again changes nothing.
        let mut twice = done.clone();
        assert!(repair(&mut twice, &[del]).is_empty());
        // An entry that points elsewhere is ignored.
        let mut other = seg.clone();
        let wrong = DelEntry { gseq: 3, ..del };
        assert!(repair(&mut other, &[wrong]).is_empty());
        assert_eq!(other, seg);
        let past = DelEntry {
            offset: seg.len() as u64,
            ..del
        };
        assert!(repair(&mut other, &[past]).is_empty());
    }
}
