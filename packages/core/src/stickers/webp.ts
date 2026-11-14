// WebP header reading without decoding (sizes and the animation flag), so a
// file is checked before any decoder sees it.

export interface WebpInfo {
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u24(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

/** Sizes and animation of a WebP file, or null when it is not a well-formed WebP header. */
export function webpInfo(b: Uint8Array): WebpInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const riff = u32(b, 4);
  if (riff + 8 > b.length || riff < 22) return null;
  const chunk = ascii(b, 12, 4);
  const size = u32(b, 16);
  if (20 + size > b.length) return null;
  const d = 20;
  if (chunk === 'VP8 ') {
    if (size < 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    return { width: u16(b, d + 6) & 0x3fff, height: u16(b, d + 8) & 0x3fff, animated: false };
  }
  if (chunk === 'VP8L') {
    if (size < 5 || b[d] !== 0x2f) return null;
    const bits = u32(b, d + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === 'VP8X') {
    if (size < 10) return null;
    return { width: u24(b, d + 4) + 1, height: u24(b, d + 7) + 1, animated: (b[d]! & 0x02) !== 0 };
  }
  return null;
}
