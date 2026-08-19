/**
 * SHA-256 file and content fingerprinting.
 *
 * Ports the `hashlib.sha256(...).hexdigest()` pattern used throughout the
 * Python codebase (parser.py, snapshots.py, baseline.py) for content identity.
 *
 * Pure leaf module: no mutable state, so no {@link registerReset} hook. Imports
 * only Node built-ins.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'

/**
 * Return the hex-encoded SHA-256 of `content`.
 *
 * A `string` is encoded as UTF-8 before hashing so the digest matches Python's
 * `hashlib.sha256(text.encode("utf-8")).hexdigest()` for identical text. A
 * `Buffer` is hashed verbatim, matching `hashlib.sha256(raw).hexdigest()` for
 * identical bytes.
 */
export function fingerprintContent(content: string | Buffer): string {
  const hash = createHash('sha256')
  hash.update(typeof content === 'string' ? Buffer.from(content, 'utf-8') : content)
  return hash.digest('hex')
}

/**
 * Return the first 16 hex chars of the SHA-256 of `content`, used for short
 * cache keys. Extracted from ≥11 call sites that all use `.slice(0, 16)`.
 */
export function shortFingerprint(content: string | Buffer): string {
  return fingerprintContent(content).slice(0, 16)
}

/**
 * Return the hex-encoded SHA-256 of the file at `filePath`, or `null` if the
 * file cannot be read (missing, permission denied, is a directory, etc.).
 *
 * Reads the raw bytes and hashes them verbatim, so the digest matches a content
 * fingerprint computed over the same bytes. Never throws: any read failure
 * collapses to `null` so callers on the hot hook path can branch without a
 * try/catch.
 */
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

/**
 * Is there genuinely no file at `filePath`?
 *
 * `true` only for ENOENT. A file that is present but cannot be examined right now -- a Windows
 * ACL denial, EACCES on a parent directory, a disconnected network share -- answers `false`,
 * because "I cannot tell" is not the same as "it is gone", and every caller here does something
 * destructive or user-visible with a `true`.
 *
 * This is what `fs.existsSync` cannot give: existsSync is a stat inside a bare catch, so it
 * answers `false` for a permission or I/O error exactly as it does for a missing file. Measured
 * on Windows against a directory with a deny ACE for the current user: `existsSync` returned
 * false for a file that was still there, while `statSync(p, { throwIfNoEntry: false })` threw
 * EPERM. `throwIfNoEntry: false` returns `undefined` for ENOENT and only ENOENT, and throws for
 * everything else, which is precisely the distinction.
 */
export function fileIsAbsent(filePath: string): boolean {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false }) === undefined
  } catch {
    return false
  }
}
