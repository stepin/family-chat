// Content shared into the installed app from the system share sheet (M5,
// Web Share Target, docs/PLAN.md 7.5). The service worker
// (apps/web/public/push-sw.js) receives the POST, keeps the text and files
// in the settings table under `share.pending` and opens the app, which
// takes it from there (also when the app was closed).

/** Settings key written by the service worker. */
export const SETTING_SHARE_PENDING = 'share.pending';
/** Files of one share (the attachment limit of a message). */
export const MAX_SHARED_FILES = 10;
/** All shared files together; more is refused by the service worker. */
export const MAX_SHARED_BYTES = 1024 * 1024 * 1024;
/** Shared text (title, text and address together), characters. */
export const MAX_SHARED_TEXT = 16 * 1024;
/** A share older than this is dropped (the person changed their mind long ago). */
export const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

export type ShareProblem = 'too-many-files' | 'too-large' | 'unreadable';

export interface SharedContent {
  readonly id: string;
  readonly at: number;
  /** Title, text and address joined into the text of a message (may be empty). */
  readonly text: string;
  readonly files: readonly File[];
  /** Set when the service worker refused the share (files are then empty). */
  readonly problem: ShareProblem | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Joins title, text and address like a person would write them (no duplicates). */
export function sharedText(title: string, text: string, url: string): string {
  const parts: string[] = [];
  for (const p of [title, text, url].map((s) => s.trim())) {
    if (p && !parts.some((q) => q.includes(p))) parts.push(p);
  }
  return parts.join('\n').slice(0, MAX_SHARED_TEXT);
}

/** Validates what the service worker stored; null for anything malformed or stale. */
export function parseShared(v: unknown, now: number): SharedContent | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : NaN;
  if (!Number.isFinite(at) || now - at > SHARE_TTL_MS || at - now > 60_000) return null;
  const problem = o.problem === 'too-many-files' || o.problem === 'too-large' || o.problem === 'unreadable' ? o.problem : null;
  const files = Array.isArray(o.files) ? o.files.filter((f): f is File => typeof Blob !== 'undefined' && f instanceof Blob).slice(0, MAX_SHARED_FILES) : [];
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_SHARED_BYTES) return { id: str(o.id), at, text: '', files: [], problem: 'too-large' };
  return {
    id: str(o.id).slice(0, 64),
    at,
    text: sharedText(str(o.title), str(o.text), str(o.url)),
    files: problem ? [] : files,
    problem,
  };
}
