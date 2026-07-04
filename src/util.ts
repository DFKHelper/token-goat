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

import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
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
  return isCaseInsensitiveFs() ? p.toLowerCase() : p
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
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 200 * 1024 * 1024, // 200 MB - allow large git outputs (ls-files, log, diff on large repos)
  })

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

// Bounds how long withFileLock waits behind another holder before giving up (never hangs
// the caller indefinitely), and how old an unreleased lock file must be before a crashed
// holder's lock is treated as abandoned and stolen.
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 5000

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
 * future caller of this critical section.
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
  try {
    return fn()
  } finally {
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

/** Truncate `s` to `maxChars`, appending a single ellipsis when it overflows. */
export function ellipsize(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars - 1) + '…'
}

/** Strip leading/trailing whitespace and lowercase (matches util.py strip_lower). */
export function stripLower(s: string): string {
  return s.trim().toLowerCase()
}

/** Basename of a path, mirroring Python's os.path.basename for convenience. */
export function basename(p: string): string {
  return path.basename(p)
}

/** Ensure text ends with a newline; no-op if already present. Extracted from 5 call sites. */
export function ensureNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n'
}

/** Extract readable message string from unknown error type. Extracted from 6 call sites. */
export function extractErrorMessage(err: unknown, fallback: string = ''): string {
  return err instanceof Error ? err.message : (fallback || String(err))
}

/** Check if a line is a code fence delimiter (``` or ~~~). Extracted from 7 call sites in skill_cache.ts. */
export function isCodeFenceDelimiter(line: string): boolean {
  const s = line.trim()
  return s.startsWith('```') || s.startsWith('~~~')
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
