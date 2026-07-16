/**
 * Cross-cutting helpers shared across token-goat modules.
 *
 * Kept intentionally small: only utilities with no natural owner that would
 * otherwise be duplicated. Imports only Node built-ins and other Layer 1 files.
 *
 * IMPORTANT: `runGit` is the ONLY place in the entire codebase that spawns git.
 * A structural test (git_chokepoint.test.ts) greps every src/*.ts for bare git
 * spawn patterns outside this file and fails if any are found.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import * as path from 'node:path'

import { normalizePath } from './paths.js'
import type { GitResult, RunGitOptions } from './types.js'

export { normalizePath }

/**
 * Block the calling thread for `ms` milliseconds without spawning a process.
 *
 * Uses `Atomics.wait` on a throwaway SharedArrayBuffer: the wait never resolves
 * (no other thread writes to it), so it always times out after `ms`. This is a
 * true synchronous sleep, unlike a busy-loop, and burns no CPU.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Check if running on Windows. */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Windows creation flags for suppressing console windows (CREATE_NO_WINDOW). */
export function noWindowCreationFlags(): number {
  return isWindows() ? 0x08000000 : 0
}

// Case-insensitive filesystems (Windows, macOS) treat C:/Foo and C:/foo as the same path; normalizePath only lowercases the drive letter, so path-equality and dedup comparisons must fold the whole string. TOKEN_GOAT_CASE_INSENSITIVE_FS ('1' or '0') overrides the platform default for deterministic cross-platform tests.
export function isCaseInsensitiveFs(): boolean {
  const o = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
  if (o === '1') return true
  if (o === '0') return false
  return process.platform === 'win32' || process.platform === 'darwin'
}

export function foldPath(p: string): string {
  return isCaseInsensitiveFs() ? foldCase(p) : p
}

/** Best-effort file size in bytes, or null when the path cannot be stat'd or isn't a regular file. */
export function statSize(absPath: string): number | null {
  try {
    const st = statSync(absPath)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/**
 * Unicode-aware case folding primitive. This is the SINGLE source of truth for how
 * token-goat folds case: `foldPath()` uses it on the JS side, and `db.ts` registers it
 * verbatim as a SQL scalar function (see `TG_LOWER` in `initConnection`) so `pathEqClause`'s
 * SQL-side folding stays byte-for-byte consistent with the JS side. SQLite's built-in
 * `LOWER()` only folds ASCII A-Z, which would silently diverge from this for non-ASCII
 * casing (e.g. `Ä` vs `ä`) — never use `LOWER()` for path comparisons, use `TG_LOWER`.
 */
export function foldCase(s: string): string {
  return s.toLowerCase()
}

/**
 * Run git and return its captured output.
 *
 * THE ONLY git spawn site in the codebase. Always:
 *   - prepends `-c core.fsmonitor=` to disable fsmonitor (prevents it from
 *     interfering with or being slowed by the agent's own git operations);
 *   - passes `windowsHide: true` so no console window flashes on Windows;
 *   - passes the args array directly (no shell, so nothing is shell-escaped).
 *
 * Output is decoded as UTF-8. A spawn failure (git not on PATH) surfaces as a
 * non-zero `exitCode` with the error message on `stderr` rather than throwing.
 */
export function runGit(args: string[], opts: RunGitOptions = {}): GitResult {
  const fullArgs = ['-c', 'core.fsmonitor=', '-c', 'core.quotepath=false', ...args]
  const result = spawnSync('git', fullArgs, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 200 * 1024 * 1024, // 200 MB - allow large git outputs (ls-files, log, diff on large repos)
  })

  // A timed-out spawnSync sets result.error (ETIMEDOUT) with a null status -- already handled
  // by the existing error branch below, so a caller that opted into timeoutMs just sees a
  // non-zero exitCode and fails soft, exactly like any other git failure.
  if (result.error) {
    return { stdout: '', stderr: String(result.error.message ?? result.error), exitCode: -1 }
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // status is null when the process was terminated by a signal; treat as -1.
    exitCode: result.status ?? -1,
  }
}

/** Errno codes worth retrying on Windows when a file is briefly locked. */
const RETRYABLE_ERRNO: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'ETXTBSY'])

function isRetryable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && RETRYABLE_ERRNO.has(code)
}

function isEExist(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === 'EEXIST'
}

/**
 * Create a directory recursively, ignoring EEXIST errors from concurrent mkdir races.
 *
 * Node.js `mkdirSync(..., { recursive: true })` is not atomic: the existence check
 * and actual mkdir syscall have a TOCTOU (time-of-check-to-time-of-use) window where
 * two concurrent calls can both pass the check but only one wins the actual mkdir,
 * leaving the second with an EEXIST error despite `recursive: true`. This is a
 * known issue on Windows and some Unix systems.
 *
 * This function catches and ignores EEXIST specifically (the desired end-state
 * — the directory exists — is already true), while propagating all other errors.
 */
export function ensureDirSync(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    if (!isEExist(err)) {
      // Propagate all errors except EEXIST (EACCES, ENOSPC, EINVAL, etc.)
      throw err
    }
    // Directory exists; the race condition resolved successfully.
  }
}

/**
 * Runs `fn`, retrying up to 5 times with a `50 * attempt` ms backoff when it throws a
 * transient Windows file-lock error (EPERM/EBUSY/ETXTBSY) -- the errno set a brief
 * AV-scanner/search-indexer lock on the destination produces. Any other error, or the
 * 5th consecutive failure, propagates immediately.
 *
 * Shared by every fs mutation in this codebase that can race a transient Windows lock:
 * atomicWriteCore's rename below, and cli.ts's `atomicWriteBuffer` rename (which nests
 * its own EXDEV cross-device fallback inside `fn`, so a successful fallback still counts
 * as success here).
 */
export function withRetryOnLock(fn: () => void): void {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fn()
      return
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === 5) throw err
      sleepSync(50 * attempt)
    }
  }
  // Unreachable: the loop either returns or throws, but satisfies tsc.
  throw lastErr
}

/**
 * Shared atomic-write core for text and bytes.
 *
 * Writes `content` to a sibling temp file (created with 0o600 so it is never
 * world-readable even transiently on POSIX), then renames over `dest`. On
 * Windows a brief exclusive-lock window can make the rename fail with
 * EPERM/EBUSY/ETXTBSY; we retry up to 5 times with a `50 * attempt` ms backoff.
 * Any failure past this point -- a failed write (ENOSPC, EIO, ...) just as much as a
 * failed rename -- cleans up the temp file before the error propagates, so a partial
 * write never leaks a `.tmp` file next to `dest`.
 */
function atomicWriteCore(dest: string, content: string | Uint8Array): void {
  // Two-component temp name: pid + high-resolution time avoids collisions across concurrent and rapid sequential writes to the same path.
  const tmp = `${dest}.${process.pid}.${process.hrtime.bigint().toString()}.tmp`

  // dest's parent directory is normally created as a side effect of an earlier operation
  // (getDb() mkdir's DATA_DIR before opening global.db), but a genuinely first write into a
  // fresh data dir -- a brand-new machine's very first `token-goat config set`, or a freshly
  // isolated test DATA_DIR with no prior DB/session activity -- has no such earlier creator and
  // openSync below throws ENOENT. ensureDirSync is the existing race-safe mkdir helper used
  // elsewhere in this file; ENOENT here was reproduced for real via saveConfig() as the first
  // write into a fresh isolated test data dir.
  ensureDirSync(path.dirname(dest))

  try {
    // mode 0o600: owner read/write only (no effect on Windows ACLs, but harmless).
    const fd = openSync(tmp, 'w', 0o600)
    try {
      if (typeof content === 'string') {
        // Encode ourselves so we control the encoding; a Buffer write avoids the CRLF translation a text-mode stream could apply on Windows.
        writeSync(fd, Buffer.from(content, 'utf-8'))
      } else {
        writeSync(fd, Buffer.from(content))
      }
    } finally {
      closeSync(fd)
    }

    // Preserve the destination's existing file mode (e.g. the exec bit on a committed
    // script) across the rewrite. On POSIX, renaming the 0o600 temp file over dest would
    // otherwise silently drop dest's permissions -- git then reports a 100755->100644 mode
    // change and the file stops being executable. A brand-new dest has no mode to inherit,
    // so it keeps the 0o600 default. No-op on Windows (chmodSync has no effect there).
    try {
      const destMode = statSync(dest).mode
      chmodSync(tmp, destMode)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    withRetryOnLock(() => renameSync(tmp, dest))
  } catch (err) {
    // Clean up the orphaned temp file on ANY failure past this point, not just a failed
    // rename: the temp file is created by openSync before the write attempt, so it exists
    // (and leaks) whether the write or the rename is what failed. Best-effort: a failed
    // cleanup-unlink must never mask the original error.
    try {
      unlinkSync(tmp)
    } catch {
      // ignore: temp cleanup is best-effort
    }
    throw err
  }
}

/**
 * Atomically write UTF-8 text to `filePath` via a temp file + rename.
 *
 * Avoids partial writes if the process is killed mid-flight. The temp file is
 * created with 0o600 permissions. Retries the rename on transient Windows
 * file-lock errors (EPERM/EBUSY/ETXTBSY) up to 5 times.
 */
export function atomicWriteText(filePath: string, content: string): void {
  atomicWriteCore(filePath, content)
}

/**
 * Atomically write raw bytes to `filePath` via a temp file + rename.
 *
 * Same guarantees as {@link atomicWriteText} but for binary content; writing
 * bytes directly avoids the CRLF doubling a text path could introduce on
 * Windows.
 */
export function atomicWriteBytes(filePath: string, content: Buffer | Uint8Array): void {
  atomicWriteCore(filePath, content)
}

/**
 * Copy `p` to a timestamped `<p>.bak.<ISO-with-dashes>` sibling before an in-place
 * overwrite, so a bad merge or corrupt rewrite has a recovery copy. No-op if `p`
 * doesn't exist yet (nothing to back up).
 */
// Caps how many timestamped backups pile up per file. backupFile runs on every install/
// uninstall of a harness's hook config (install.ts, codex_install.ts, copilot_cli_install.ts,
// gemini_install.ts, openclaw_install.ts), so a config directory a user re-installs into
// repeatedly would otherwise accumulate one .bak.<timestamp> file forever.
const MAX_BACKUPS_PER_FILE = 5

export function backupFile(p: string): void {
  if (!existsSync(p)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(p, `${p}.bak.${stamp}`)
  pruneOldBackups(p)
}

function pruneOldBackups(p: string): void {
  const dir = path.dirname(p)
  const prefix = `${path.basename(p)}.bak.`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  // ISO-with-dashes timestamps sort lexicographically in chronological order.
  const backups = entries.filter((e) => e.startsWith(prefix)).sort()
  const excess = backups.length - MAX_BACKUPS_PER_FILE
  for (const stale of backups.slice(0, Math.max(0, excess))) {
    try {
      unlinkSync(path.join(dir, stale))
    } catch {
      // Best-effort cleanup; a failed unlink here shouldn't fail the caller's backup.
    }
  }
}

// Bounds how long withFileLock waits behind another holder before giving up (never hangs
// the caller indefinitely), and how old an unreleased lock file must be before a crashed
// holder's lock is treated as abandoned and stolen.
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 5000

// Larger wait budget for hot, contended withFileLock call sites (e.g. session_store.ts's
// saveSessionState, config_commands.ts's `config set`) where the default LOCK_WAIT_MS can
// plausibly be missed under real machine load even though no lock holder is actually stuck.
// Falling back to an unprotected write on that miss reintroduces the exact clobber the lock
// exists to prevent, precisely when contention (and therefore risk) is highest -- so these
// call sites wait much longer instead. An actually-wedged holder still gets its lock stolen
// well before this via withFileLock's own staleMs abandonment check, so this only lengthens
// the wait for genuine, resolving contention, not a real hang.
export const LOCK_WAIT_MS_HARDENED = 15_000

// Heartbeat run in a separate OS process while the lock is held. fn() is synchronous and may
// block the holder's own thread for its entire duration (slow sync disk I/O, a GC pause, a
// long-running synchronous computation, ...) -- a setInterval/setTimeout in the holder's own
// process cannot fire while fn() has the thread pinned in a blocking synchronous call, so it
// can't refresh the lock file's mtime from there (verified empirically: a busy-spin inside the
// holder starves its own timers completely). A separate process has its own event loop and
// keeps ticking regardless of what the holder's thread is doing, so staleness detection then
// reflects genuine liveness instead of a fixed timeout: a live holder's heartbeat keeps the file
// newer than staleMs indefinitely, while a crashed holder (no clean shutdown, e.g. kill -9)
// takes the heartbeat down with it, so the file goes quiet and a later caller still reclaims it
// once staleMs has elapsed since the last tick.
const HEARTBEAT_SCRIPT = `
const fs = require('fs')
const [, lockPath, token, ms] = process.argv
const ppid = process.ppid
function tick() {
  try {
    process.kill(ppid, 0)
  } catch {
    // Parent is gone (crashed, killed, ...): stop ticking so a genuinely dead holder's lock
    // still goes stale and gets reclaimed. Windows ties this child's lifetime to its parent's
    // Job Object automatically, but POSIX does not -- without this check, a plain spawn()
    // child outlives a crashed parent as an orphan and would refresh the lock file forever,
    // permanently wedging it. This is the actual enforcement mechanism on POSIX (this
    // project's CI runs on ubuntu-latest); on Windows it is a harmless backstop.
    process.exit(0)
  }
  try {
    // Only ever refresh the token already on disk; never (re)create the file. This preserves
    // the ownership check in withFileLock's finally block unchanged -- the heartbeat never
    // changes what makes a lock file "belong" to a holder, only how fresh its mtime looks.
    if (fs.readFileSync(lockPath, 'utf8') === token) fs.writeFileSync(lockPath, token)
  } catch {}
}
setInterval(tick, Number(ms))
`

function startHeartbeat(lockPath: string, token: string, staleMs: number): ChildProcess | undefined {
  // A few ticks within staleMs so one missed/delayed tick can't let the file go stale; scales
  // with staleMs (not a fixed constant) so tests overriding staleMs keep the same margin.
  const intervalMs = Math.max(20, Math.floor(staleMs / 3))
  try {
    return spawn(process.execPath, ['-e', HEARTBEAT_SCRIPT, lockPath, token, String(intervalMs)], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    return undefined // best-effort: no heartbeat just means staleness falls back to the fixed timeout, as before
  }
}

/**
 * Runs `fn` while holding an exclusive lock at `lockPath`, so the same critical section
 * never runs concurrently across separate OS processes. The mutex primitive is an atomic
 * exclusive-create write (`wx`), which behaves identically on Windows and POSIX, unlike
 * advisory `flock`.
 *
 * If another process already holds the lock, this waits (backoff style mirrors
 * atomicWriteCore's rename retry) for up to `waitMs` before giving up. A lock file whose
 * mtime is older than `staleMs` is treated as abandoned by a holder that crashed without
 * releasing it and is stolen, so one crashed process can never permanently wedge every
 * future caller of this critical section. While the lock is held, a heartbeat (see
 * startHeartbeat above) keeps the lock file's mtime fresh so a live holder -- even one whose
 * fn() blocks the thread for longer than staleMs -- is never mistaken for a crashed one.
 *
 * Returns `undefined` -- without ever calling `fn` -- if the lock could not be acquired in
 * time. Callers whose own persistence must never block forever should treat that as
 * "proceed without the lock" (e.g. fall back to an unprotected write), not as a hard failure.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { waitMs?: number; staleMs?: number } = {},
): T | undefined {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  // Unique per acquisition attempt (not just per process) so release can confirm it still
  // owns the lock file before deleting it -- the same pid+hrtime idiom atomicWriteCore uses
  // for its temp-file name.
  const token = `${process.pid}:${process.hrtime.bigint().toString()}`
  const deadline = Date.now() + waitMs
  let attempt = 0
  for (;;) {
    try {
      writeFileSync(lockPath, token, { flag: 'wx' })
      break
    } catch (err) {
      if (!isEExist(err)) return undefined // can't lock at all (e.g. missing dir); let the caller fall back
    }
    // Someone else holds it. A holder that crashed without releasing it would otherwise
    // wedge every future caller of this critical section forever, so treat a lock file
    // older than staleMs as abandoned and steal it.
    let stale: boolean
    try {
      const st = statSync(lockPath)
      stale = Date.now() - st.mtimeMs > staleMs
    } catch {
      stale = true // lock vanished between the failed create and this stat; clear to retry
    }
    if (stale) {
      try {
        unlinkSync(lockPath)
      } catch {
        // another waiter may already be stealing/holding it; the retried create sorts it out
      }
      continue // no sleep: stealing (or losing the steal race) always makes forward progress
    }
    if (Date.now() >= deadline) return undefined
    sleepSync(Math.min(20 * ++attempt, 200))
  }
  const heartbeat = startHeartbeat(lockPath, token, staleMs)
  try {
    return fn()
  } finally {
    // Stop refreshing the lock's mtime before deciding whether to release it, so a heartbeat
    // tick can't refresh/recreate the file after ownership has already been decided below.
    try {
      heartbeat?.kill()
    } catch {
      // best-effort: a heartbeat that already exited on its own is not an error
    }
    // Only remove the lock if it still carries our own token: if a stall let a waiter decide
    // this lock was abandoned and steal it, that waiter's lock is now the live one and must
    // not be deleted out from under it.
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath)
    } catch {
      // best-effort: release is advisory, a missing/unreadable lock file is not an error
    }
  }
}

/** Strip leading/trailing whitespace and lowercase (matches util.py strip_lower). */
export function stripLower(s: string): string {
  return s.trim().toLowerCase()
}

/** Escapes regex metacharacters so a string is safely embeddable inside a `new RegExp(...)` pattern and matches only itself. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Basename of a path, mirroring Python's os.path.basename for convenience. */
export function basename(p: string): string {
  return path.basename(p)
}

/**
 * Swap `filePath`'s extension for `format` (e.g. `'jpeg'` -> `.jpg`, `'webp'` -> `.webp`),
 * preserving its directory and basename. Used after `shrinkImage()` re-encodes a capture to a
 * different container format, so the extension actually reflects the bytes written -- writing
 * JPEG bytes under a caller-requested `.png` path would otherwise silently mislabel the file.
 */
export function withExtension(filePath: string, format: string): string {
  const ext = format === 'jpeg' ? '.jpg' : `.${format}`
  const dir = path.dirname(filePath)
  const base = path.basename(filePath, path.extname(filePath))
  return path.join(dir, `${base}${ext}`)
}

/** Ensure text ends with a newline; no-op if already present. Extracted from 5 call sites. */
export function ensureNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n'
}

/** Extract readable message string from unknown error type. Extracted from 6 call sites. */
export function extractErrorMessage(err: unknown, fallback: string = ''): string {
  return err instanceof Error ? err.message : (fallback || String(err))
}

// Parses a numeric CLI flag value, rejecting anything but an exact integer literal (optional
// leading minus, followed by digits) instead of letting a bare Number.parseInt/parseFloat accept
// trailing garbage ("30x" -> 30) or exponential notation ("1e3" -> 1). Mirrors cli.ts's
// requireInt/requireNonNegativeInt/requirePositiveInt for command modules cli.ts itself imports
// (config_commands.ts, cache_session_commands.ts) — those can't import cli.ts back without a
// circular dependency, so this shared, dependency-free copy lives in util.ts instead.
export function requireStrictInt(flag: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${flag} must be a number, got: "${raw}"`)
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} must be a number, got: "${raw}"`)
  }
  return n
}

/** Same as {@link requireStrictInt}, plus a sign check: rejects a strictly-negative value. */
export function requireNonNegativeStrictInt(flag: string, raw: string): number {
  const n = requireStrictInt(flag, raw)
  if (n < 0) {
    throw new Error(`${flag} must be a non-negative number, got: "${raw}"`)
  }
  return n
}

/** Same as {@link requireStrictInt}, plus a sign check: rejects zero or a negative value. */
export function requirePositiveStrictInt(flag: string, raw: string): number {
  const n = requireStrictInt(flag, raw)
  if (n <= 0) {
    throw new Error(`${flag} must be a positive number, got: "${raw}"`)
  }
  return n
}

/** Check if a line is a code fence delimiter (``` or ~~~). Extracted from 7 call sites in skill_cache.ts. */
export function isCodeFenceDelimiter(line: string): boolean {
  const s = line.trim()
  return s.startsWith('```') || s.startsWith('~~~')
}

/** Right-pad `s` with spaces to width `n` (no-op if already at/over width). Extracted from
 * byte-identical private copies in cache_session_commands.ts, cli_hint_stats.ts, cli_recall.ts. */
export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** Normalize path and convert backslashes to forward slashes. Extracted from 3 call sites in compact.ts. */
export function normalizePathForwardSlash(p: string, toLowerCase?: boolean): string {
  let result = normalizePath(p).replace(/\\/g, '/')
  if (toLowerCase) result = result.toLowerCase()
  return result
}

/** Return true when a path looks like a test file (tests/ dir or .test./.spec./_test. suffix). Moved here from graph_commands.ts (re-exported there) so other file-walk consumers (repomap, baseline) can share the same heuristic without a circular import. */
export function isTestFile(p: string): boolean {
  return /(^|[/\\])(tests?)[/\\]/i.test(p) || /\.(test|spec)\.|_test\.|(^|[/\\])test_/i.test(p)
}

/**
 * True when `filePath` lives under any of `blockedRoots` (each an absolute path prefix set via
 * `token-goat project exclude`). Comparison resolves and case-folds both sides (see
 * normalizePath/foldPath) so a Windows drive-letter or separator difference cannot let a blocked
 * file slip through, and respects path boundaries so a blocked root of `foo` does not also match
 * a sibling directory named `foo-bar`.
 */
export function isUnderBlockedRoot(filePath: string, blockedRoots: readonly string[]): boolean {
  if (blockedRoots.length === 0) return false
  const target = foldPath(normalizePath(path.resolve(filePath)))
  for (const root of blockedRoots) {
    if (!root) continue
    const normRoot = foldPath(normalizePath(path.resolve(root)))
    if (target === normRoot) return true
    const boundary = normRoot.endsWith('/') ? normRoot : `${normRoot}/`
    if (target.startsWith(boundary)) return true
  }
  return false
}

const QUIET_HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

/**
 * True when `now` (local time) falls inside the `"HH:MM-HH:MM"` window described by
 * `spec` (24h clock). An empty `spec` or one that doesn't parse means quiet hours are
 * disabled -- always false. A window whose end is earlier than or equal to its start
 * (e.g. `"22:00-06:00"`) wraps past midnight.
 */
export function isWithinQuietHours(spec: string, now: Date = new Date()): boolean {
  const m = QUIET_HOURS_RE.exec(spec)
  if (!m) return false

  const startMin = Number(m[1]) * 60 + Number(m[2])
  const endMin = Number(m[3]) * 60 + Number(m[4])
  const nowMin = now.getHours() * 60 + now.getMinutes()

  if (startMin === endMin) return false
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin
  return nowMin >= startMin || nowMin < endMin
}
