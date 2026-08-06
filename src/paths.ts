/**
 * Path normalization and join safety.
 *
 * Ports `_normalize_path` / `normalize_path` from `paths.py` plus the colon
 * rejection at the heart of `safe_join`. No imports from other local modules.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

// Compiled once: matches a WSL mount path /mnt/<drive>/rest. The `s` flag makes `.` match newlines so paths containing newline bytes still normalize fully. Exported so project.ts's cross-shell canonicalization reuses this exact pattern instead of maintaining a second, flag-divergent copy.
export const WSL_PATH_RE = /^\/mnt\/([a-zA-Z])\/(.*)$/s

// Compiled once: matches a Git Bash / MSYS mount path /<drive>/rest, with the trailing /rest optional so a bare drive root (`/c`) still matches and becomes `c:/` instead of falling through unrewritten. The `s` flag makes `.` match newlines so paths containing newline bytes still normalize fully. Exported so project.ts's cross-shell canonicalization reuses this exact pattern instead of maintaining a second, mandatory-trailing-slash copy.
export const MSYS_PATH_RE = /^\/([a-zA-Z])(\/.*)?$/s

// Matches a UNC path's host+share segment once backslashes have already been converted to forward slashes (e.g. `\\FileServer\Dev\...` -> `//FileServer/Dev/...`). Host and share names are case-insensitive on Windows, exactly like a drive letter, so two differently-cased references to the same network share must normalize to the same string. Only the host/share segment is captured; everything beyond it is left untouched, matching how the drive-letter fold below only lowercases the drive letter itself.
const UNC_HOST_SHARE_RE = /^\/\/([^/]+)\/([^/]+)/

// Cheap heuristic for a Windows 8.3 short-name path segment (e.g. `JOHNDO~1.ACM`): a tilde followed by a digit. Used to skip the syscall in expandShortPath for the overwhelming majority of paths that don't contain one.
const SHORT_NAME_RE = /~\d/

// Expands a Windows 8.3 short-name path segment to its long form. `%TEMP%`/`%USERPROFILE%` can be pinned to the short 8.3 form on Windows, so every `os.tmpdir()`-based path -- including every test fixture directory `fs.mkdtempSync` creates -- inherits that short form and a child process spawned with it as `cwd` preserves it verbatim, while `git` always normalizes its own output paths to long form; without this expansion the same physical directory normalizes to two different index keys depending on whether the path came from `process.cwd()` or from `git diff --name-only`, so writes and lookups silently disagree. `fs.realpathSync` (the POSIX-style implementation) does NOT resolve 8.3 short names on Windows; only `fs.realpathSync.native` does. Guarded so it's a no-op off Windows, a no-op when the path doesn't look like it contains a short name, and falls back to the original string if the path doesn't exist yet (e.g. a file about to be created) or the native call throws for any other reason.
export function expandShortPath(p: string): string {
  if (process.platform !== 'win32') return p
  const segments = p.split('/')
  // Find the last path segment that looks like an 8.3 short name and resolve only the prefix through it via the filesystem, leaving everything after it byte-for-byte as-is: fs.realpathSync.native returns on-disk casing regardless of query casing, so running it over the *whole* path would silently case-fold every segment, collapsing two deliberately differently-cased paths (see tests/session.test.ts's case-sensitive-FS control case) into one.
  let lastShortIdx = -1
  for (let i = 0; i < segments.length; i++) {
    if (SHORT_NAME_RE.test(segments[i] as string)) lastShortIdx = i
  }
  if (lastShortIdx === -1) return p
  const prefix = segments.slice(0, lastShortIdx + 1).join('/')
  const suffix = segments.slice(lastShortIdx + 1).join('/')
  try {
    const expandedPrefix = fs.realpathSync.native(prefix).replace(/\\/g, '/')
    return suffix ? `${expandedPrefix}/${suffix}` : expandedPrefix
  } catch {
    // Fall back unchanged: the short-named directory itself doesn't exist (unusual, but possible for a path built purely as a string in a test).
    return p
  }
}

/**
 * Lowercases a Windows drive-letter prefix (e.g. "C:" -> "c:") or a UNC path's host+share
 * segment (e.g. "//FileServer/Dev/..." -> "//fileserver/dev/...") so path comparisons/cache
 * keys agree regardless of input case. For a drive letter, only touches position 0 when it's
 * an ASCII uppercase letter immediately followed by ':' — anything else (already-lowercase,
 * digit, symbol, non-ASCII) is left untouched. Shared by normalizePath (paths.ts) and
 * canonicalize (project.ts) so the rule can't drift between the two call sites again.
 */
export function lowercaseDriveLetter(s: string): string {
  if (s.length >= 2 && s[1] === ':') {
    const c = s[0] as string
    if (/^[A-Z]$/.test(c)) {
      return c.toLowerCase() + s.slice(1)
    }
  }
  const uncMatch = UNC_HOST_SHARE_RE.exec(s)
  if (uncMatch) {
    const full = uncMatch[0] as string
    const host = uncMatch[1] as string
    const share = uncMatch[2] as string
    return `//${host.toLowerCase()}/${share.toLowerCase()}${s.slice(full.length)}`
  }
  return s
}

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
// Matches a `\\?\UNC\` extended-length UNC prefix, case-insensitively.
const EXTENDED_UNC_PREFIX_RE = /^\\\\\?\\UNC\\/i
// Matches a plain `\\?\` extended-length-path prefix.
const EXTENDED_PREFIX_RE = /^\\\\\?\\/

export function normalizePath(p: string): string {
  let s = p

  // Step 0: strip a `\\?\` extended-length-path prefix so it normalizes identically to its non-extended equivalent. `\\?\UNC\server\share\...` rewrites to the standard `\\server\share\...` UNC form first; a plain `\\?\C:\...` just drops the `\\?\` marker. Must run before the backslash->forward-slash conversion below, since the prefix is expressed in backslash form and (for the UNC case) `//?/...` would otherwise incorrectly match UNC_HOST_SHARE_RE with `?` as the host and `c:` as the "share".
  if (EXTENDED_UNC_PREFIX_RE.test(s)) {
    s = '\\\\' + s.slice(8)
  } else if (EXTENDED_PREFIX_RE.test(s)) {
    s = s.slice(4)
  }

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
    const g = MSYS_PATH_RE.exec(s)
    if (g) s = `${(g[1] as string).toLowerCase()}:${g[2] ?? '/'}`
  }

  // Step 2c: expand a Windows 8.3 short-name segment (e.g. `JOHNDO~1.ACM`) to its long form, so a path where %TEMP% is pinned to short form normalizes identically to git's always-long-form output. Must run after steps 1-2b so `s` is already in drive-letter/forward-slash form (the native fs call needs a real Windows-shaped path, not a WSL mount path).
  s = expandShortPath(s)

  // Step 3: lowercase the drive-letter prefix (C: -> c:) on all platforms. WSL processes emit Windows-format paths on Linux; both must produce the same cache key, so lowercasing is unconditional.
  s = lowercaseDriveLetter(s)

  // Step 4: macOS reports the same temp path with two system aliases depending
  // on whether it came from os.tmpdir() or process.cwd().
  s = normalizeDarwinSystemAlias(s)

  return s
}

/**
 * Normalize macOS's public `/var` alias to its physical `/private/var` path.
 *
 * `os.tmpdir()` commonly returns `/var/...`, while `process.cwd()` returns
 * `/private/var/...` after chdir. Keep this lexical so deleted/future paths
 * normalize too, without resolving arbitrary user symlinks.
 */
export function normalizeDarwinSystemAlias(p: string): string {
  if (process.platform !== 'darwin') return p
  if (p.toLowerCase() === '/var') return `/private${p}`
  if (p.slice(0, 5).toLowerCase() === '/var/') return `/private${p}`
  return p
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
  // A Windows-drive-absolute file or base (C:/foo, from a WSL-Windows-interop process, a Windows caller, or a cwd carried over from a Windows session) must resolve using Windows semantics regardless of host: the ambient path.resolve is POSIX on a non-Windows host and doesn't recognize a drive letter as absolute in either argument, so it would join a drive-letter file onto base (or a relative file onto a drive-letter base) as if neither were absolute, corrupting the index key. path.win32.resolve recognizes drive letters on any host; when neither argument is Windows-absolute this still behaves like plain resolve.
  const isWindowsAbsolute = (s: string): boolean => /^[a-zA-Z]:[/\\]/.test(s)
  const resolve = isWindowsAbsolute(file) || isWindowsAbsolute(base) ? path.win32.resolve : path.resolve
  return normalizePath(resolve(base, file))
}

/**
 * Convert an indexed absolute path to a display form for HUMAN (non-JSON) output.
 *
 * The global index is machine-wide and keyed by absolute path on purpose (see
 * `resolveIndexPath` above), so a query can legitimately return rows from projects
 * other than `root` -- those rows must stay absolute or the printed path becomes
 * ambiguous. Only a path genuinely inside `root` is shortened, and only for display;
 * `--json` payloads must never call this and must keep the raw absolute path.
 *
 * Cross-drive guard: on Windows, `path.relative()` between two different drive
 * letters returns the target's own absolute path unchanged rather than a `..`-prefixed
 * relative path (documented Node behavior, not a bug). A bare `!rel.startsWith('..')`
 * check is therefore not sufficient -- it would let an unrelated-drive path through as
 * if it were in-root. Mirrors the guard shape already used by
 * `relPathWithinRoot` (hooks_read.ts) and `isPathWithinRoot` (pack.ts): any relative
 * result that is itself absolute, or that starts with `..`, means `target` is NOT
 * inside `root`, so the original absolute path is returned unchanged.
 */
export function toDisplayPath(root: string | undefined, target: string): string {
  // No root means the caller has none it can name without resolving one itself. Return the
  // absolute path rather than falling back to process.cwd(): a cwd-relative path renders the
  // SAME query differently depending on where it was run from, is ambiguous once printed, and
  // cannot be resolved from anywhere else -- strictly worse than the absolute path it replaced.
  if (root === undefined) return target
  // Normalize BOTH sides first. Indexed paths are stored normalized, but a root reaches here however its caller spelled it, and path.relative compares text: a Windows 8.3 segment (RUNNER~1) against its long form, or macOS /var against /private/var, share no prefix, so the relative walk escapes upward and the whole absolute path gets printed instead of a location you can feed back to `read`. Both spellings are what normalizePath exists to collapse.
  const rel = path.relative(normalizePath(root), normalizePath(target)).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return rel === '' ? '.' : target
  }
  return rel
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
