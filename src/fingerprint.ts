/** SHA-256 file and content fingerprinting. Ports the `hashlib.sha256(...).hexdigest()` pattern used throughout the Python codebase (parser.py, snapshots.py, baseline.py) for content identity. Pure leaf module: no mutable state, so no {@link registerReset} hook. Imports only Node built-ins. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'

/** Return the hex-encoded SHA-256 of `content`. A `string` is encoded as UTF-8 before hashing so the digest matches Python's `hashlib.sha256(text.encode("utf-8")).hexdigest()` for identical text. A `Buffer` is hashed verbatim, matching `hashlib.sha256(raw).hexdigest()` for identical bytes. */
export function fingerprintContent(content: string | Buffer): string {
  const hash = createHash('sha256')
  hash.update(typeof content === 'string' ? Buffer.from(content, 'utf-8') : content)
  return hash.digest('hex')
}

/** Return the first 16 hex chars of the SHA-256 of `content`, used for short cache keys. Extracted from ≥11 call sites that all use `.slice(0, 16)`. */
export function shortFingerprint(content: string | Buffer): string {
  return fingerprintContent(content).slice(0, 16)
}

/** Is an index row's file definitely gone from `filePath`? True when nothing answers there (ENOENT, or ENOTDIR because a parent became a file) or what answers is not a regular file: `files` rows are source files, so a directory (or a symlink to one) at an indexed path means the indexed file is gone even though the path still exists. False for a file that is there and for any stat failure that cannot be told apart from "present but unreachable" (EPERM, EBUSY, an unmounted share), so an unreadable file is never reported gone. The one rule behind reconcile, the worker drain and the prune sweeps; {@link fileIsAbsent} stays ENOENT-only for callers that must not treat a directory as gone. */
export function indexedFileIsGone(filePath: string): boolean {
  return statIndexedFile(filePath) === 'gone'
}

/** One stat of an index row's file: its stats when a regular file answers at `filePath`, `'gone'` when {@link indexedFileIsGone} would say so, and `null` for any other stat failure, which says nothing either way. For a caller that needs the mtime of a file it also has to tell apart from a deleted one, so it stats once rather than twice. */
export function statIndexedFile(filePath: string): fs.Stats | 'gone' | null {
  try {
    const st = fs.statSync(filePath)
    return st.isFile() ? st : 'gone'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : null
  }
}

/** Return the hex-encoded SHA-256 of the file at `filePath`, or `null` if the file cannot be read (missing, permission denied, is a directory, etc.). Reads the raw bytes and hashes them verbatim, so the digest matches a content fingerprint computed over the same bytes. Never throws: any read failure collapses to `null` so callers on the hot hook path can branch without a try/catch. */
export function fingerprintFile(filePath: string): string | null {
  let data: Buffer
  try {
    data = fs.readFileSync(filePath)
  } catch {
    // Missing file, permission error, directory, or transient lock — the caller treats "no fingerprint" the same regardless of the cause.
    return null
  }
  return fingerprintContent(data)
}

/** Is there genuinely no file at `filePath`? `true` only for ENOENT. A file that is present but cannot be examined right now -- a Windows ACL denial, EACCES on a parent directory, a disconnected network share -- answers `false`, because "I cannot tell" is not the same as "it is gone", and every caller here does something destructive or user-visible with a `true`. This is what `fs.existsSync` cannot give: existsSync is a stat inside a bare catch, so it answers `false` for a permission or I/O error exactly as it does for a missing file. Measured on Windows against a directory with a deny ACE for the current user: `existsSync` returned false for a file that was still there, while `statSync(p, { throwIfNoEntry: false })` threw EPERM. `throwIfNoEntry: false` returns `undefined` for ENOENT and only ENOENT, and throws for everything else, which is precisely the distinction. */
export function fileIsAbsent(filePath: string): boolean {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false }) === undefined
  } catch {
    return false
  }
}

/** The two columns of a `files` row the rule reads, in seconds. */
export interface RowStamp {
  readonly mtime: number
  readonly indexedAt: number
}

/** The coarsest timestamp tick the racy-clean gate guards against, in seconds: an assumption, not a verified figure: the bug report named 2 s for FAT and exFAT and 1 s for HFS+, and no filesystem documentation was read for either number. */
export const TIMESTAMP_TICK_SEC = 2

/** Does an equal mtime prove the file unchanged since its row was written? Only when that mtime is older than the row's indexed_at by at least one timestamp tick (both seconds): a file edited after indexing but inside the tick its recorded mtime was stamped in gets the same stamp while its bytes differ, so equality alone hides that edit forever, and a stamp truncated down to the tick can sit below indexed_at yet still cover the edit. Git's racy-clean rule (Documentation/technical/racy-git.txt, byte-identical at tags v2.43.0 and v2.47.0, https://github.com/git/git/blob/v2.43.0/Documentation/technical/racy-git.txt; the rendered page https://git-scm.com/docs/racy-git showed "last updated in 2.43.0" when read): an entry whose st_mtime is the same as or newer than the index file's timestamp is compared by content. Git stops at same-or-newer; the extra tick of margin here is this code's own, for the truncated stamp described above. An ambiguous file, a row with no indexed_at included, falls through to the hash compare, so only those files cost a read. */
export function mtimeProvesUnchanged(entry: RowStamp, diskMtimeMs: number): boolean {
  return mtimeEqualsRow(entry, diskMtimeMs) && entry.mtime + TIMESTAMP_TICK_SEC <= entry.indexedAt
}

/** Is the disk mtime the one the row recorded? A file that passes this but not {@link mtimeProvesUnchanged} is verified by content and, when the bytes match, is not a moved-timestamp file, so it must not be counted as one. */
export function mtimeEqualsRow(entry: RowStamp, diskMtimeMs: number): boolean {
  return entry.mtime !== 0 && diskMtimeMs / 1000 === entry.mtime
}
