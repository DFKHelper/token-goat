/**
 * Path normalization and join safety.
 *
 * Ports `_normalize_path` / `normalize_path` from `paths.py` plus the colon
 * rejection at the heart of `safe_join`. No imports from other local modules.
 */

import * as path from 'node:path'

// Compiled once: matches a WSL mount path /mnt/<drive>/rest. The `s` flag makes `.` match newlines so paths containing newline bytes still normalize fully.
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

  // Step 1: backslashes -> forward slashes (before the WSL check so mixed separators like /mnt/c/foo\bar normalize fully before the regex runs).
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

  // Step 2b: Git Bash / MSYS mount form /<drive>/rest -> <drive>:/rest, Windows only. On Linux/macOS `/c/foo` is a real path and must not be rewritten. Single letter only so a real `/cab/` dir is untouched; bare `/c` becomes `c:/`.
  if (process.platform === 'win32') {
    const g = /^\/([a-zA-Z])(\/.*)?$/.exec(s)
    if (g) s = `${(g[1] as string).toLowerCase()}:${g[2] ?? '/'}`
  }

  // Step 3: lowercase the drive-letter prefix (C: -> c:) on all platforms. WSL processes emit Windows-format paths on Linux; both must produce the same cache key, so lowercasing is unconditional.
  if (s.length >= 2 && s[1] === ':') {
    const c = s[0] as string
    if (/^[A-Z]$/.test(c)) {
      s = c.toLowerCase() + s.slice(1)
    }
  }

  return s
}

/**
 * Resolve a user-supplied path to the canonical key form the symbol index uses.
 *
 * Every symbol/ref/file row is keyed by `normalizePath(absolutePath)` (see
 * `indexFileSync` in parser.ts and `cmdIndex` in cli.ts). Index-backed read
 * commands receive paths exactly as the user typed them ("src/worker.ts",
 * "./src/worker.ts", "SRC\\worker.ts") or as `git diff --name-only` emits them
 * (repo-root-relative). The DB lookup is exact equality (`file_path = ?`), so a
 * raw relative or backslash path never matches an absolute, forward-slashed,
 * lowercase-drive key and the query silently returns nothing. Routing every
 * query site through this one helper guarantees the lookup key matches the
 * write key byte-for-byte across platforms.
 *
 * @param file  Path as typed by the user or emitted by git.
 * @param base  Directory to resolve `file` against. Defaults to the process
 *              working directory; `changed` passes its own repo root.
 */
export function resolveIndexPath(file: string, base: string = process.cwd()): string {
  // A Windows-drive-absolute file or base (C:/foo, from a WSL-Windows-interop process, a
  // Windows caller, or a cwd carried over from a Windows session) must resolve using Windows
  // semantics regardless of host: the ambient path.resolve is POSIX on a non-Windows host and
  // doesn't recognize a drive letter as absolute in either argument, so it would join a
  // drive-letter file onto base (or a relative file onto a drive-letter base) as if neither
  // were absolute, corrupting the index key. path.win32.resolve recognizes drive letters on
  // any host; when neither argument is Windows-absolute this still behaves like plain resolve.
  const isWindowsAbsolute = (s: string): boolean => /^[a-zA-Z]:[/\\]/.test(s)
  const resolve = isWindowsAbsolute(file) || isWindowsAbsolute(base) ? path.win32.resolve : path.resolve
  return normalizePath(resolve(base, file))
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
