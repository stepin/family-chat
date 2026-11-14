/**
 * Storage abstraction (docs/PLAN.md sections 4 and 7.7). The protocol is
 * written in terms of this interface; WebDAV is the only implementation in v1.
 *
 * Paths are relative to the server root and consist of segments matching
 * `[a-z0-9.-]{1,64}` (section 6.1). A trailing `/` marks a collection.
 */
export interface StorageEntry {
  /** Last path segment, URL-decoded. Not validated: callers check names against exact formats. */
  name: string;
  isDir: boolean;
  /** Bytes; 0 when the server does not report it (typical for collections). */
  size: number;
  /**
   * `getlastmodified` in ms since epoch, diagnostics only: file times never take
   * part in acceptance or ordering rules (section 6.12).
   */
  mtime?: number;
}

/** One reading of the server clock from the `Date` header. */
export interface ServerTimeSample {
  /** Server time from `Date`, ms since epoch (1 s resolution). */
  serverMs: number;
  /** Local clock (`now()` passed to the storage) when the response arrived. */
  localMs: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface GetOptions extends RequestOptions {
  /** Fail with `Fatal`/`response-too-large` if the body is bigger. */
  maxBytes?: number;
}

export interface Storage {
  /** Lists a collection (Depth 1), without the collection itself. */
  list(dir: string, opts?: RequestOptions): Promise<StorageEntry[]>;
  get(path: string, opts?: GetOptions): Promise<Uint8Array>;
  put(path: string, data: Uint8Array | Blob, opts?: RequestOptions): Promise<void>;
  /** Deletes a file, or a collection with its contents when `path` ends with `/`. */
  delete(path: string, opts?: RequestOptions): Promise<void>;
  /** Creates one collection level; succeeds if it already exists. Verified by re-reading. */
  mkdir(dir: string, opts?: RequestOptions): Promise<void>;
  /** Latest server clock reading from any response, including errors. */
  serverTime(): ServerTimeSample | null;
}
