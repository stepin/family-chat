// Why a sticker file or archive was refused. The UI turns the code into words.

export type StickerErrorCode =
  /** Not a ZIP archive, or a damaged one. */
  | 'bad-zip'
  | 'zip-encrypted'
  /** ZIP64 or multi-disk archives are not supported (a sticker pack never needs them). */
  | 'zip64'
  /** More files than allowed. */
  | 'too-many-files'
  /** One file is larger than allowed (`detail`: its name). */
  | 'file-too-large'
  /** All files together are larger than allowed. */
  | 'too-large-total'
  /** Compressed suspiciously well (a decompression bomb). */
  | 'ratio'
  /** A path outside the archive, absolute, with `..` or a backslash. */
  | 'bad-path'
  /** An archive inside the archive. */
  | 'nested-archive'
  /** A compression method other than stored or deflate. */
  | 'bad-compression'
  /** Not a WebP image (or broken). */
  | 'bad-webp'
  /** Not a `.tgs` (gzip of Lottie JSON), or broken. */
  | 'bad-tgs'
  /** The unpacked animation is larger than allowed. */
  | 'tgs-too-big'
  /** Longer than allowed, too many frames per second, or too large a canvas. */
  | 'tgs-too-long'
  /** Too many layers or shapes (the animation would be too heavy to draw). */
  | 'tgs-too-complex'
  /** Sides out of range. */
  | 'bad-size'
  /** Nothing usable in what was chosen. */
  | 'no-stickers'
  /** More stickers than a pack holds. */
  | 'too-many-stickers'
  /** The browser cannot unpack (no DecompressionStream). */
  | 'unsupported-browser'
  /** The file's bytes do not give its name (hash), or its size differs from the manifest. */
  | 'hash-mismatch';

export class StickerError extends Error {
  override readonly name = 'StickerError';
  readonly code: StickerErrorCode;
  /** A file name, when the problem is one file. Never file contents. */
  readonly detail: string | null;

  constructor(code: StickerErrorCode, detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export function isStickerError(e: unknown, code?: StickerErrorCode): e is StickerError {
  return e instanceof StickerError && (code === undefined || e.code === code);
}
