/**
 * Path normalization and join safety.
 *
 * Ports `_normalize_path` / `normalize_path` from `paths.py` plus the colon
 * rejection at the heart of `safe_join`. No imports from other local modules.
 */

import * as path from 'node:path'

// Compiled once: matches a WSL mount path /mnt/<drive>/rest. The `s` flag makes
// `.` match newlines so paths containing newline bytes still normalize fully.
const WSL_PATH_RE = /^\/mnt\/([a-zA-Z])\/(.*)$/s

/**
 * Normalize a file path to a canonical string form for cross-platform keys.
 *
 * Transformations, in order (matches util.py normalize_path):
 *   1. Replace all backslashes with forward slashes.
 *   2. Convert WSL paths `/mnt/<drive>/rest` to Windows form `<drive>:/rest`,
 *      collapsing duplicate leading slashes in `rest`.
 *   3. Lowercase an uppercase drive-letter prefix (`C:` -> `c:`).
 *
 * This is a string canonicalizer, not a filesystem canonicalizer: symlinks,
 * junctions, and case-insensitive NTFS paths are not resolved.
 */
export function normalizePath(p: string): string {
  let s = p

  // Step 1: backslashes -> forward slashes (before the WSL check so mixed
  // separators like /mnt/c/foo\bar normalize fully before the regex runs).
  if (s.includes('\\')) {
    s = s.replace(/\\/g, '/')
  }

  // Step 2: WSL /mnt/<single-letter-drive>/rest -> <drive>:/rest
  const m = WSL_PATH_RE.exec(s)
  if (m) {
    const driveLetter = (m[1] as string).toLowerCase()
    const rest = m[2] as string
    const restStripped = rest.replace(/^\/+/, '')
    s = `${driveLetter}:/${restStripped}`
  }

  // Step 3: lowercase the drive-letter prefix (C: -> c:) on all platforms.
  // WSL processes emit Windows-format paths on Linux; both must produce the
  // same cache key, so lowercasing is unconditional.
  if (s.length >= 2 && s[1] === ':') {
    const c = s[0] as string
    if (/^[A-Z]$/.test(c)) {
      s = c.toLowerCase() + s.slice(1)
    }
  }

  return s
}

/**
 * Join `base` with one or more path parts, rejecting any part that could
 * escape the base directory via a Windows drive-letter or NTFS stream.
 *
 * Unconditionally rejects any part containing `:` — a colon turns a fragment
 * into a Windows absolute path (`C:/evil`) or an NTFS Alternate Data Stream,
 * and Codex session IDs can contain colons. Rejection is platform-independent
 * so behaviour is identical on POSIX and Windows.
 *
 * @throws Error if any part contains a colon.
 */
export function safeJoin(base: string, ...parts: string[]): string {
  for (const part of parts) {
    if (part.includes(':')) {
      throw new Error(`safeJoin: path component contains colon: ${JSON.stringify(part)}`)
    }
  }
  return path.join(base, ...parts)
}
