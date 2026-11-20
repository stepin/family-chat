//! Images sent through MCP: what a file is (by its first bytes, never by its
//! name), how large the picture is, and the same file without the metadata a
//! camera or an editor left in it (place, time, device, comments). Pixels are
//! never touched: no decoding, no resizing, no new dependency.
//!
//! - JPEG: EXIF, XMP, IPTC and comment segments go. When EXIF said the
//!   picture is rotated, a minimal EXIF with only that orientation is put
//!   back, or phones' photos would lie on their side.
//! - PNG: text, time and EXIF chunks go.
//! - WebP: EXIF and XMP chunks go, and the header stops announcing them.
//! - GIF: sent as it is (it carries no camera metadata).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageType {
    Jpeg,
    Png,
    Webp,
    Gif,
}

impl ImageType {
    pub fn mime(self) -> &'static str {
        match self {
            ImageType::Jpeg => "image/jpeg",
            ImageType::Png => "image/png",
            ImageType::Webp => "image/webp",
            ImageType::Gif => "image/gif",
        }
    }
}

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The image type the bytes begin as.
pub fn sniff(b: &[u8]) -> Option<ImageType> {
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageType::Jpeg)
    } else if b.starts_with(PNG_MAGIC) {
        Some(ImageType::Png)
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(ImageType::Webp)
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some(ImageType::Gif)
    } else {
        None
    }
}

fn be16(b: &[u8], at: usize) -> Option<usize> {
    Some(usize::from(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?)))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn le16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?)))
}

fn le24(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at + 3)?;
    Some(u32::from(s[0]) | u32::from(s[1]) << 8 | u32::from(s[2]) << 16)
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// A JPEG segment: marker, and the range of the whole segment (marker included).
struct Segment {
    marker: u8,
    start: usize,
    end: usize,
}

/// The segments before the picture data (`SOS`), and where that data starts.
fn jpeg_segments(b: &[u8]) -> Option<(Vec<Segment>, usize)> {
    let mut at = 2;
    let mut out = Vec::new();
    loop {
        if *b.get(at)? != 0xff {
            return None;
        }
        // Fill bytes before a marker.
        let mut m = at + 1;
        while *b.get(m)? == 0xff {
            m += 1;
        }
        let marker = b[m];
        let start = at;
        at = m + 1;
        match marker {
            // The picture data follows to the end of the file.
            0xda => return Some((out, start)),
            // Markers without a length.
            0xd0..=0xd9 | 0x01 => {}
            _ => {
                let len = be16(b, at)?;
                if len < 2 {
                    return None;
                }
                at = at.checked_add(len)?;
                if at > b.len() {
                    return None;
                }
            }
        }
        out.push(Segment { marker, start, end: at });
    }
}

/// EXIF orientation (1..8) of an `APP1` segment's content, if it has one.
fn exif_orientation(app1: &[u8]) -> Option<u16> {
    let t = app1.strip_prefix(b"Exif\0\0")?;
    let little = match t.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let s: [u8; 2] = t.get(at..at + 2)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(s)
        } else {
            u16::from_be_bytes(s)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let s: [u8; 4] = t.get(at..at + 4)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(s)
        } else {
            u32::from_be_bytes(s)
        })
    };
    let ifd = u32_at(4)? as usize;
    let count = usize::from(u16_at(ifd)?);
    for i in 0..count.min(512) {
        let entry = ifd + 2 + i * 12;
        if u16_at(entry)? == 0x0112 {
            let v = u16_at(entry + 8)?;
            return (1..=8).contains(&v).then_some(v);
        }
    }
    None
}

/// An `APP1` segment that says only how the picture is rotated.
fn orientation_segment(orientation: u16) -> Vec<u8> {
    let mut s = vec![0xff, 0xe1, 0x00, 0x22];
    s.extend_from_slice(b"Exif\0\0");
    s.extend_from_slice(b"MM\0*\0\0\0\x08"); // big-endian TIFF, first IFD at 8
    s.extend_from_slice(&[0x00, 0x01]); // one entry
    s.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]); // Orientation, SHORT, count 1
    s.extend_from_slice(&orientation.to_be_bytes());
    s.extend_from_slice(&[0x00, 0x00]);
    s.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // no next IFD
    s
}

fn is_sof(marker: u8) -> bool {
    matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc)
}

fn jpeg_orientation(b: &[u8], segments: &[Segment]) -> Option<u16> {
    segments
        .iter()
        .filter(|s| s.marker == 0xe1)
        .find_map(|s| exif_orientation(b.get(s.start + 4..s.end)?))
}

/// Width and height as the picture is shown (EXIF rotation applied).
pub fn dimensions(b: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = match sniff(b)? {
        ImageType::Jpeg => {
            let (segments, _) = jpeg_segments(b)?;
            let sof = segments.iter().find(|s| is_sof(s.marker))?;
            let (h, w) = (be16(b, sof.start + 5)? as u32, be16(b, sof.start + 7)? as u32);
            // Orientations 5 to 8 turn the picture by a quarter.
            if jpeg_orientation(b, &segments).is_some_and(|o| o >= 5) {
                (h, w)
            } else {
                (w, h)
            }
        }
        ImageType::Png => {
            if b.get(12..16)? != b"IHDR" {
                return None;
            }
            (be32(b, 16)?, be32(b, 20)?)
        }
        ImageType::Gif => (le16(b, 6)?, le16(b, 8)?),
        ImageType::Webp => match b.get(12..16)? {
            b"VP8X" => (le24(b, 24)? + 1, le24(b, 27)? + 1),
            b"VP8 " => {
                if b.get(23..26)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                (le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff)
            }
            b"VP8L" => {
                if *b.get(20)? != 0x2f {
                    return None;
                }
                let bits = le32(b, 21)?;
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            _ => return None,
        },
    };
    (w > 0 && h > 0).then_some((w, h))
}

fn strip_jpeg(b: &[u8]) -> Option<Vec<u8>> {
    let (segments, data) = jpeg_segments(b)?;
    let orientation = jpeg_orientation(b, &segments).filter(|o| *o != 1);
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(&b[..2]);
    let mut placed = orientation.is_none();
    for s in &segments {
        let drop = match s.marker {
            // EXIF and XMP; IPTC (Photoshop); comments.
            0xe1 | 0xed | 0xfe => true,
            // JFIF, ICC profile and Adobe colour information stay: they change how pixels look.
            0xe0 | 0xe2 | 0xee => false,
            // Other application segments are makers' private data.
            0xe3..=0xef => true,
            _ => false,
        };
        // The orientation goes where EXIF belongs: after JFIF, before everything else.
        if !placed && s.marker != 0xe0 {
            out.extend_from_slice(&orientation_segment(orientation.unwrap_or(1)));
            placed = true;
        }
        if !drop {
            out.extend_from_slice(&b[s.start..s.end]);
        }
    }
    if !placed {
        out.extend_from_slice(&orientation_segment(orientation.unwrap_or(1)));
    }
    out.extend_from_slice(&b[data..]);
    Some(out)
}

fn strip_png(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(PNG_MAGIC);
    let mut at = PNG_MAGIC.len();
    while at < b.len() {
        let len = be32(b, at)? as usize;
        let kind = b.get(at + 4..at + 8)?;
        let end = at.checked_add(12)?.checked_add(len)?;
        if end > b.len() {
            return None;
        }
        if !matches!(kind, b"tEXt" | b"zTXt" | b"iTXt" | b"tIME" | b"eXIf") {
            out.extend_from_slice(&b[at..end]);
        }
        at = end;
        if kind == b"IEND" {
            break;
        }
    }
    Some(out)
}

fn strip_webp(b: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::with_capacity(b.len());
    let mut at = 12;
    while at + 8 <= b.len() {
        let kind = &b[at..at + 4];
        let len = le32(b, at + 4)? as usize;
        // Chunks are padded to an even length.
        let end = at.checked_add(8)?.checked_add(len)?.checked_add(len & 1)?;
        let end = end.min(b.len());
        if at + 8 + len > b.len() {
            return None;
        }
        if kind == b"VP8X" && len >= 1 {
            let mut chunk = b[at..end].to_vec();
            // Clear "has EXIF" (bit 3) and "has XMP" (bit 2).
            chunk[8] &= !0x0c;
            body.extend_from_slice(&chunk);
        } else if kind != b"EXIF" && kind != b"XMP " {
            body.extend_from_slice(&b[at..end]);
        }
        at = end;
    }
    let mut out = Vec::with_capacity(body.len() + 12);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&u32::try_from(body.len() + 4).ok()?.to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);
    Some(out)
}

/// The same picture without metadata. `None`: the file is not a well-formed
/// image of its type, and must not be sent as if it had been cleaned.
pub fn strip_metadata(b: &[u8]) -> Option<Vec<u8>> {
    match sniff(b)? {
        ImageType::Jpeg => strip_jpeg(b),
        ImageType::Png => strip_png(b),
        ImageType::Webp => strip_webp(b),
        ImageType::Gif => Some(b.to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(marker: u8, content: &[u8]) -> Vec<u8> {
        let mut s = vec![0xff, marker];
        s.extend_from_slice(&u16::try_from(content.len() + 2).unwrap().to_be_bytes());
        s.extend_from_slice(content);
        s
    }

    /// EXIF content: a little-endian TIFF with Orientation and a GPS pointer.
    fn exif(orientation: u16) -> Vec<u8> {
        let mut t = b"Exif\0\0II*\0\x08\0\0\0".to_vec();
        t.extend_from_slice(&2u16.to_le_bytes());
        t.extend_from_slice(&[0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00]);
        t.extend_from_slice(&orientation.to_le_bytes());
        t.extend_from_slice(&[0, 0]);
        // GPSInfo pointer and some "coordinates".
        t.extend_from_slice(&[0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00]);
        t.extend_from_slice(&[0, 0, 0, 0]);
        t.extend_from_slice(b"GPS 55.7558N 37.6173E");
        t
    }

    fn jpeg(orientation: Option<u16>) -> Vec<u8> {
        let mut j = vec![0xff, 0xd8];
        j.extend(segment(0xe0, b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0"));
        if let Some(o) = orientation {
            j.extend(segment(0xe1, &exif(o)));
        }
        j.extend(segment(
            0xe1,
            b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret place</x:xmpmeta>",
        ));
        j.extend(segment(0xe2, b"ICC_PROFILE\0\x01\x01profile"));
        j.extend(segment(0xed, b"Photoshop 3.0\08BIM author"));
        j.extend(segment(0xfe, b"shot at home"));
        j.extend(segment(0xdb, &[0; 65]));
        // SOF0: precision 8, height 300, width 400, 3 components.
        j.extend(segment(
            0xc0,
            &[8, 0x01, 0x2c, 0x01, 0x90, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
        ));
        j.extend(segment(0xda, &[3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));
        j.extend_from_slice(&[0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
        j
    }

    fn has(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn jpeg_loses_metadata_and_keeps_pixels_and_rotation() {
        let j = jpeg(Some(6));
        assert_eq!(sniff(&j), Some(ImageType::Jpeg));
        assert_eq!(dimensions(&j), Some((300, 400)), "rotated by a quarter");
        let clean = strip_metadata(&j).unwrap();
        for secret in [&b"GPS"[..], b"secret place", b"author", b"shot at home", b"xmpmeta"] {
            assert!(
                has(&j, secret) && !has(&clean, secret),
                "{}",
                String::from_utf8_lossy(secret)
            );
        }
        // JFIF, the colour profile, the tables and the picture data are untouched.
        assert!(has(&clean, b"JFIF") && has(&clean, b"ICC_PROFILE"));
        assert!(clean.ends_with(&[0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]));
        // The rotation survives, right after JFIF, and nothing else of EXIF.
        assert_eq!(dimensions(&clean), Some((300, 400)));
        let (segments, _) = jpeg_segments(&clean).unwrap();
        assert_eq!(
            segments.iter().map(|s| s.marker).collect::<Vec<_>>(),
            [0xe0, 0xe1, 0xe2, 0xdb, 0xc0]
        );
        assert_eq!(jpeg_orientation(&clean, &segments), Some(6));
        // Cleaning twice changes nothing more.
        assert_eq!(strip_metadata(&clean).unwrap(), clean);

        // Upright or without EXIF: no EXIF at all afterwards.
        for j in [jpeg(Some(1)), jpeg(None)] {
            assert_eq!(dimensions(&j), Some((400, 300)));
            let clean = strip_metadata(&j).unwrap();
            let (segments, _) = jpeg_segments(&clean).unwrap();
            assert!(segments.iter().all(|s| s.marker != 0xe1));
            assert_eq!(dimensions(&clean), Some((400, 300)));
        }
        // A cut file is not passed off as cleaned.
        assert!(strip_metadata(&j[..40]).is_none());
        assert!(dimensions(&j[..40]).is_none());
    }

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(data);
        c.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        c
    }

    #[test]
    fn png_loses_text_time_and_exif() {
        let mut p = PNG_MAGIC.to_vec();
        let mut ihdr = 640u32.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&480u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        p.extend(chunk(b"IHDR", &ihdr));
        p.extend(chunk(b"tEXt", b"Author\0Mama"));
        p.extend(chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0where we live"));
        p.extend(chunk(b"tIME", &[7, 0xea, 11, 20, 10, 0, 0]));
        p.extend(chunk(b"eXIf", b"II*\0camera"));
        p.extend(chunk(b"gAMA", &[0, 0, 0xb1, 0x8f]));
        p.extend(chunk(b"IDAT", b"pixels"));
        p.extend(chunk(b"IEND", b""));
        assert_eq!((sniff(&p), dimensions(&p)), (Some(ImageType::Png), Some((640, 480))));
        let clean = strip_metadata(&p).unwrap();
        for secret in [&b"Mama"[..], b"where we live", b"camera", b"tIME"] {
            assert!(!has(&clean, secret), "{}", String::from_utf8_lossy(secret));
        }
        assert!(has(&clean, b"gAMA") && has(&clean, b"pixels") && has(&clean, b"IEND"));
        assert_eq!(dimensions(&clean), Some((640, 480)));
        assert!(strip_metadata(&p[..p.len() - 9]).is_none());
    }

    fn riff(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = kind.to_vec();
        c.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        c.extend_from_slice(data);
        if data.len() % 2 == 1 {
            c.push(0);
        }
        c
    }

    #[test]
    fn webp_loses_exif_and_xmp() {
        let mut body = Vec::new();
        // VP8X: flags (EXIF, XMP, ICC), reserved, canvas 800x600.
        body.extend(riff(b"VP8X", &[0x2c, 0, 0, 0, 0x1f, 0x03, 0, 0x57, 0x02, 0]));
        body.extend(riff(b"ICCP", b"profile"));
        body.extend(riff(b"VP8 ", b"pixels!"));
        body.extend(riff(b"EXIF", b"II*\0where"));
        body.extend(riff(b"XMP ", b"<x:xmpmeta>who</x:xmpmeta>"));
        let mut w = b"RIFF".to_vec();
        w.extend_from_slice(&u32::try_from(body.len() + 4).unwrap().to_le_bytes());
        w.extend_from_slice(b"WEBP");
        w.extend_from_slice(&body);
        assert_eq!((sniff(&w), dimensions(&w)), (Some(ImageType::Webp), Some((800, 600))));
        let clean = strip_metadata(&w).unwrap();
        assert!(!has(&clean, b"where") && !has(&clean, b"xmpmeta"));
        assert!(has(&clean, b"profile") && has(&clean, b"pixels!"));
        assert_eq!(clean[20], 0x20, "only the colour profile is still announced");
        assert_eq!(le32(&clean, 4).unwrap() as usize, clean.len() - 8);
        assert_eq!(dimensions(&clean), Some((800, 600)));

        // The simple formats give their size too.
        let mut lossy = b"RIFF\x1e\0\0\0WEBPVP8 \x12\0\0\0".to_vec();
        lossy.extend_from_slice(&[
            0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        assert_eq!(dimensions(&lossy), Some((320, 240)));
        let mut lossless = b"RIFF\x12\0\0\0WEBPVP8L\x06\0\0\0\x2f".to_vec();
        lossless.extend_from_slice(&((99u32) | (49u32 << 14)).to_le_bytes());
        lossless.push(0);
        assert_eq!(dimensions(&lossless), Some((100, 50)));
    }

    #[test]
    fn other_files_are_not_images() {
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b""), None);
        assert!(strip_metadata(b"plain text").is_none());
        let gif = b"GIF89a\x10\x00\x20\x00rest";
        assert_eq!((sniff(gif), dimensions(gif)), (Some(ImageType::Gif), Some((16, 32))));
        assert_eq!(strip_metadata(gif).unwrap(), gif);
    }
}
