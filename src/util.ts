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

import { ensureDataDirPrivate } from './constants.js'
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
 *   - for a `diff` subcommand specifically, inserts `--no-ext-diff --no-textconv` right after
 *     it, so a repo-local `.gitattributes` diff driver or textconv filter can never run as a
 *     side effect of a `diff` call this codebase makes on the caller's behalf -- defense-in-
 *     depth against a malicious `.gitattributes`/git config in a repo this tool is pointed at.
 *     Deliberately NOT done via `-c diff.external=`/`-c core.attributesfile=`: an *empty*
 *     `diff.external` value is not "disabled" to git, it is a literal empty-string command to
 *     spawn, so `-c diff.external=` makes every diff fail with "cannot spawn : No such file or
 *     directory" -- confirmed by hand against a real repo. `--no-ext-diff`/`--no-textconv` are
 *     the flags git itself documents for this, and only `diff` (not `status`/`add`/etc., which
 *     don't accept them) needs them;
 *   - passes `windowsHide: true` so no console window flashes on Windows;
 *   - passes the args array directly (no shell, so nothing is shell-escaped).
 *
 * Output is decoded as UTF-8. A spawn failure (git not on PATH) surfaces as a
 * non-zero `exitCode` with the error message on `stderr` rather than throwing.
 */
export function runGit(args: string[], opts: RunGitOptions = {}): GitResult {
  const subArgs = args[0] === 'diff' ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args
  const fullArgs = [
    // Never take an optional lock. Every git call here is on someone else's
    // working repo, and a `status` that refreshes the index writes
    // `.git/index.lock`; if this process is killed mid-call -- which the hint
    // paths deliberately invite, since they spawn under a short timeout -- the
    // orphaned lock blocks every subsequent commit in that repo until a human
    // deletes it. Observed doing exactly that on 2026-08-05. `--no-optional-
    // locks` suppresses only locks git considers optional, so write commands
    // that genuinely need one are unaffected.
    '--no-optional-locks',
    '-c', 'core.fsmonitor=',
    '-c', 'core.quotepath=false',
    ...subArgs,
  ]
  const result = spawnSync('git', fullArgs, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 200 * 1024 * 1024, // 200 MB - allow large git outputs (ls-files, log, diff on large repos)
  })

  // A timed-out spawnSync sets result.error (ETIMEDOUT) with a null status -- already handled by the existing error branch below, so a caller that opted into timeoutMs just sees a non-zero exitCode and fails soft, exactly like any other git failure.
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
  // The data root holds every cached page, command output, and index DB, so it is created
  // owner-only before any child lands in it. Cheap: memoized to one syscall per process.
  ensureDataDirPrivate()
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

  // dest's parent directory is normally created as a side effect of an earlier operation (getDb() mkdir's DATA_DIR before opening global.db), but a genuinely first write into a fresh data dir -- a brand-new machine's very first `token-goat config set`, or a freshly isolated test DATA_DIR with no prior DB/session activity -- has no such earlier creator and openSync below throws ENOENT. ensureDirSync is the existing race-safe mkdir helper used elsewhere in this file; ENOENT here was reproduced for real via saveConfig() as the first write into a fresh isolated test data dir.
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

    // Preserve the destination's existing file mode (e.g. the exec bit on a committed script) across the rewrite. On POSIX, renaming the 0o600 temp file over dest would otherwise silently drop dest's permissions -- git then reports a 100755->100644 mode change and the file stops being executable. A brand-new dest has no mode to inherit, so it keeps the 0o600 default. No-op on Windows (chmodSync has no effect there).
    try {
      const destMode = statSync(dest).mode
      chmodSync(tmp, destMode)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    withRetryOnLock(() => renameSync(tmp, dest))
  } catch (err) {
    // Clean up the orphaned temp file on ANY failure past this point, not just a failed rename: the temp file is created by openSync before the write attempt, so it exists (and leaks) whether the write or the rename is what failed. Best-effort: a failed cleanup-unlink must never mask the original error.
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

/** Outcome of an {@link installSingleFilePlugin} call. */
export interface SingleFilePluginInstallResult {
  readonly filePath: string
  /** True when the file on disk was already byte-identical to the current template (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Install a single-file, no-merge-target plugin/extension (pi's extension, opencode's
 * plugin): write `template` to `filePath` unless it's already byte-identical, and
 * unconditionally refresh the `{entryPath: process.argv[1]}` sidecar next to it so a
 * stale sidecar gets fixed even when the plugin file itself needs no update.
 */
export function installSingleFilePlugin(filePath: string, sidecarPath: string, template: string): SingleFilePluginInstallResult {
  let existing: string | undefined
  try {
    existing = readFileSync(filePath, 'utf8')
  } catch {
    existing = undefined
  }

  const entryPath = process.argv[1]
  if (entryPath) {
    ensureDirSync(path.dirname(filePath))
    atomicWriteText(sidecarPath, JSON.stringify({ entryPath }))
  }

  if (existing === template) {
    return { filePath, alreadyInstalled: true }
  }

  ensureDirSync(path.dirname(filePath))
  atomicWriteText(filePath, template)
  return { filePath, alreadyInstalled: false }
}

/**
 * Remove a single-file plugin/extension and its entry sidecar (see
 * {@link installSingleFilePlugin}). Returns true when the main file was actually
 * present and removed; false when nothing was installed (no write occurs either way).
 */
export function uninstallSingleFilePlugin(filePath: string, sidecarPath: string): boolean {
  try {
    unlinkSync(sidecarPath)
  } catch {
    // no sidecar to remove -- fine, e.g. an install predating the sidecar
  }
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Copy `p` to a timestamped `<p>.bak.<ISO-with-dashes>` sibling before an in-place
 * overwrite, so a bad merge or corrupt rewrite has a recovery copy. No-op if `p`
 * doesn't exist yet (nothing to back up).
 */
// Caps how many timestamped backups pile up per file. backupFile runs on every install/ uninstall of a harness's hook config (install.ts, codex_install.ts, copilot_cli_install.ts, gemini_install.ts, openclaw_install.ts), so a config directory a user re-installs into repeatedly would otherwise accumulate one .bak.<timestamp> file forever.
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

// Per-file ceiling on a single file's contribution to a bytes-saved stat's counterfactual "what reading it whole would have cost" side, deliberately NOT read from config: it's derived from two independent, unrelated sources landing within 8% of each other -- token-goat's own FILE_TYPE_THRESHOLDS.generic (src/hints/file_type_handler.ts) is 100_000, the size above which token-goat itself intercepts an unrecognized file rather than letting it be read whole, so "the agent would have read the whole file" is contradicted by token-goat's own behavior past that point; and Claude Code's Read tool truncates at 2000 lines by default, which at this repo's measured ~54 bytes/line (read_commands.ts: 271,673 bytes / ~5000 lines) puts Read's real ceiling at ~108,000 bytes -- and it stays a hardcoded constant rather than a config knob because coupling the ledger's unit to a user-configurable threshold would let a config change silently rewrite historical stat comparability. Lives in util.ts rather than beside its original caller (sumFileSizes) because the re-read hook credits the same counterfactual per file and must not import read_commands.ts to say so: that module's eval cost is a large share of hook startup.
export const PER_FILE_COUNTERFACTUAL_CEILING = 100_000

// Bounds how long withFileLock waits behind another holder before giving up (never hangs the caller indefinitely), and how old an unreleased lock file must be before a crashed holder's lock is treated as abandoned and stolen.
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 5000

// Larger wait budget for hot, contended withFileLock call sites (e.g. session_store.ts's saveSessionState, config_commands.ts's `config set`) where the default LOCK_WAIT_MS can plausibly be missed under real machine load even though no lock holder is actually stuck. Falling back to an unprotected write on that miss reintroduces the exact clobber the lock exists to prevent, precisely when contention (and therefore risk) is highest -- so these call sites wait much longer instead. An actually-wedged holder still gets its lock stolen well before this via withFileLock's own staleMs abandonment check, so this only lengthens the wait for genuine, resolving contention, not a real hang.
export const LOCK_WAIT_MS_HARDENED = 15_000

// Heartbeat run in a separate OS process while the lock is held. fn() is synchronous and may block the holder's own thread for its entire duration (slow sync disk I/O, a GC pause, a long-running synchronous computation, ...) -- a setInterval/setTimeout in the holder's own process cannot fire while fn() has the thread pinned in a blocking synchronous call, so it can't refresh the lock file's mtime from there (verified empirically: a busy-spin inside the holder starves its own timers completely). A separate process has its own event loop and keeps ticking regardless of what the holder's thread is doing, so staleness detection then reflects genuine liveness instead of a fixed timeout: a live holder's heartbeat keeps the file newer than staleMs indefinitely, while a crashed holder (no clean shutdown, e.g. kill -9) takes the heartbeat down with it, so the file goes quiet and a later caller still reclaims it once staleMs has elapsed since the last tick.
const HEARTBEAT_SCRIPT = `
const fs = require('fs')
const [, lockPath, token, ms] = process.argv
const ppid = process.ppid
function tick() {
  try {
    process.kill(ppid, 0)
  } catch {
    // Parent is gone (crashed, killed, ...): stop ticking so a genuinely dead holder's lock still goes stale and gets reclaimed. Windows ties this child's lifetime to its parent's Job Object automatically, but POSIX does not -- without this check, a plain spawn() child outlives a crashed parent as an orphan and would refresh the lock file forever, permanently wedging it. This is the actual enforcement mechanism on POSIX (this project's CI runs on ubuntu-latest); on Windows it is a harmless backstop.
    process.exit(0)
  }
  try {
    // Only ever refresh the token already on disk; never (re)create the file. This preserves the ownership check in withFileLock's finally block unchanged -- the heartbeat never changes what makes a lock file "belong" to a holder, only how fresh its mtime looks.
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
  // Unique per acquisition attempt (not just per process) so release can confirm it still owns the lock file before deleting it -- the same pid+hrtime idiom atomicWriteCore uses for its temp-file name.
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
    // Someone else holds it. A holder that crashed without releasing it would otherwise wedge every future caller of this critical section forever, so treat a lock file older than staleMs as abandoned and steal it.
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
    // Only remove the lock if it still carries our own token: if a stall let a waiter decide this lock was abandoned and steal it, that waiter's lock is now the live one and must not be deleted out from under it.
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

/**
 * Sanitize an arbitrary id/string into a filesystem-safe stem: every character outside
 * `[A-Za-z0-9_-]` becomes `_`, then the result is capped to `maxLen` chars (omit for no cap).
 * Pass `fallback` to substitute a non-empty default when sanitization yields an empty string
 * (e.g. an id made entirely of disallowed characters); omitted, an empty result is returned as-is.
 * Shared by every call site that turns a session/content id into a safe directory or file name
 * (compact.ts, snapshots.ts, session_store.ts, disk_cache.ts, doc_compact.ts) so the character
 * class stays in exactly one place.
 */
export function sanitizeIdForFilename(id: string, maxLen?: number, fallback?: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLen)
  return safe.length > 0 ? safe : (fallback ?? safe)
}

/** One hook entry as stored in a harness's `[[hooks.<Event>]]`/`hooks.<event>[]` config shape --
 * the minimal fields {@link stripOwnHooksFromMap} needs. */
interface HookEntryLike {
  readonly command: string
}

/** One matcher group under a hook event key -- the minimal fields {@link stripOwnHooksFromMap}
 * needs. Generic over the hook-entry type so each bridge's own richer interface (with its
 * harness-specific extra fields) is preserved through the spread in the returned groups. */
interface MatcherGroupLike<H extends HookEntryLike> {
  readonly hooks?: readonly H[]
}

/**
 * Shared by codex_install.ts's `uninstallCodex` and gemini_install.ts's `uninstallGemini`
 * (both harnesses use the same `Record<eventKey, matcherGroup[]>` hooks shape): strip
 * token-goat's own hook entries out of `hooks`, mutating it in place. A matcher group survives
 * if it still has non-token-goat hooks left, OR if it started with zero hooks (an empty group
 * is user data token-goat never wrote, so it's preserved rather than treated as "fully
 * stripped"). An event key whose every group was removed entirely is deleted. Returns true if
 * at least one hook entry was actually removed, so callers can skip writing the file back when
 * nothing changed.
 */
export function stripOwnHooksFromMap<H extends HookEntryLike, G extends MatcherGroupLike<H>>(
  hooks: Record<string, G[] | undefined>,
  isOurs: (command: string) => boolean,
): boolean {
  let removed = false
  for (const eventKey of Object.keys(hooks)) {
    const groups = hooks[eventKey]
    // A malformed config can hold a single table (TOML `[hooks.SomeEvent]`) where the
    // array-of-tables shape (`[[hooks.SomeEvent]]`) is expected -- skip it rather than
    // crashing on `for...of` over a non-iterable; it's user data, not ours to touch.
    if (groups === undefined || !Array.isArray(groups)) continue
    const kept: G[] = []
    for (const group of groups) {
      const keptHooks = (group.hooks ?? []).filter((h) => {
        const isOur = isOurs(h.command)
        if (isOur) removed = true
        return !isOur
      })
      if (keptHooks.length > 0) {
        kept.push({ ...group, hooks: keptHooks })
      } else if ((group.hooks ?? []).length === 0) {
        kept.push(group)
      }
    }
    if (kept.length > 0) {
      hooks[eventKey] = kept
    } else {
      delete hooks[eventKey]
    }
  }
  return removed
}

/** {@link MatcherGroupLike} plus the optional `matcher` field {@link stripStaleGroupHooks} needs. */
interface MatcherGroupWithMatcher<H extends HookEntryLike> extends MatcherGroupLike<H> {
  readonly matcher?: string
}

/**
 * Shared by codex_install.ts, gemini_install.ts, and qwen_install.ts's install functions: given
 * one hook event's existing matcher groups, strip out any stale token-goat hook entry (legacy
 * bare command, or a same-shape command whose baked entry path is no longer current) so a
 * re-install upgrades in place instead of leaving a dead duplicate. When `matcherFilter` is
 * provided, only groups whose `matcher` field strictly equals `matcherFilter.matcher` (which may
 * itself be `undefined`, for matcher-less groups) are filtered; other groups pass through
 * untouched -- this matches codex/gemini's per-matcher install loop. When `matcherFilter` is
 * omitted entirely, every group is filtered regardless of its `matcher` field -- this matches
 * qwen's single catch-all group and codex's matcher-less global-event loop. The wrapper object
 * (rather than a bare `matcher?: string` param) is what lets "no restriction" and "restrict to
 * groups whose matcher is undefined" be expressed as two distinct calls. A group survives
 * filtering if it still has non-token-goat hooks left, OR if it started with zero hooks (an
 * empty group is user data token-goat never wrote, so it's preserved). Does not mutate `groups`;
 * returns the filtered array for the caller to push the fresh entry onto.
 */
export function stripStaleGroupHooks<H extends HookEntryLike, G extends MatcherGroupWithMatcher<H>>(
  groups: readonly G[],
  isOurs: (command: string) => boolean,
  matcherFilter?: { readonly matcher: string | undefined },
): G[] {
  const next: G[] = []
  for (const group of groups) {
    if (matcherFilter !== undefined && group.matcher !== matcherFilter.matcher) {
      next.push(group)
      continue
    }
    const keptHooks = (group.hooks ?? []).filter((h) => !isOurs(h.command))
    if (keptHooks.length > 0) {
      next.push({ ...group, hooks: keptHooks })
    } else if ((group.hooks ?? []).length === 0) {
      next.push(group)
    }
  }
  return next
}

/**
 * Shared by install.ts's `stripClaudeMdBlock` and codex_install.ts's `stripAgentsBlock`:
 * remove a delimited block (everything from `beginMarker` through the end of `endMarker`,
 * inclusive) from the file at `p`. Returns false without writing when the file can't be read
 * or the markers aren't found in order. Collapses the surrounding whitespace so removing the
 * block doesn't leave a run of blank lines behind.
 */
export function stripDelimitedBlock(p: string, beginMarker: string, endMarker: string): boolean {
  let existing: string
  try {
    existing = readFileSync(p, 'utf8')
  } catch {
    return false
  }

  const beginIdx = existing.indexOf(beginMarker)
  const endIdx = existing.indexOf(endMarker)
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return false

  const before = existing.slice(0, beginIdx).replace(/\s+$/, '')
  const after = existing.slice(endIdx + endMarker.length).replace(/^\s+/, '')

  let next: string
  if (before.length > 0 && after.length > 0) {
    next = `${before}\n\n${after}`
  } else if (before.length > 0) {
    next = `${before}\n`
  } else {
    next = after
  }

  atomicWriteText(p, next)
  return true
}

/**
 * Shared by install.ts's `writeClaudeMdBlock` and codex_install.ts's `writeAgentsBlock`:
 * insert or update a delimited block in the file at `p`. If `beginMarker`/`endMarker` are
 * already present (in order), the span between them is replaced with `block` verbatim
 * (returning false without writing when it's already exactly `block`). Otherwise `block` is
 * appended after a blank line, trimming trailing whitespace first so re-runs don't accumulate
 * blank lines. Creates `p`'s parent directory and treats a missing file as empty content.
 */
export function upsertDelimitedBlock(p: string, beginMarker: string, endMarker: string, block: string): boolean {
  let existing: string
  try {
    existing = readFileSync(p, 'utf8')
  } catch {
    existing = ''
  }

  const beginIdx = existing.indexOf(beginMarker)
  const endIdx = existing.indexOf(endMarker)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx)
    const after = existing.slice(endIdx + endMarker.length)
    const current = existing.slice(beginIdx, endIdx + endMarker.length)
    if (current === block) return false
    ensureDirSync(path.dirname(p))
    atomicWriteText(p, `${before}${block}${after}`)
    return true
  }

  const trimmed = existing.replace(/\s+$/, '')
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, next)
  return true
}

/**
 * Shared by install.ts, bridges/gemini_install.ts, and bridges/openclaw_install.ts: persist a
 * settings object as pretty-printed JSON with a trailing newline, backing up the prior file
 * first and creating `p`'s parent directory if needed.
 */
export function writeJsonSettings(p: string, settings: unknown): void {
  ensureDirSync(path.dirname(p))
  backupFile(p)
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * Shared by bridges/grok_install.ts and bridges/copilot_cli_install.ts: write `content` to `p`
 * only if it differs from what's already there (or the file doesn't exist), optionally backing
 * up the prior file first. Returns whether a write happened.
 */
export function writeIfDifferent(p: string, content: string, backup = false): boolean {
  let existing: string | undefined
  try {
    existing = readFileSync(p, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === content) return false
  if (backup) backupFile(p)
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, content)
  return true
}

/** One line of a source-context window: its 1-indexed line number and verbatim text. Matches the shape `grep`'s `GrepHit.context` entries already use, so the same renderer serves `grep -C`, `refs -C`, and `callers -C`. */
export interface SourceContextLine {
  readonly line: number
  readonly text: string
}

/**
 * Read an inclusive window of `contextLines` source lines either side of `line` (1-indexed)
 * out of `absPath`. Returns null when `contextLines` is not positive, the file cannot be read,
 * or `line` falls outside the file -- callers treat null as "render the plain, context-free
 * line", so a deleted/unreadable file degrades to today's output instead of erroring.
 */
export function buildContextWindow(absPath: string, line: number, contextLines: number): SourceContextLine[] | null {
  if (!Number.isFinite(contextLines) || contextLines <= 0) return null
  let text: string
  try {
    text = readFileSync(absPath, 'utf-8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  const idx = line - 1
  if (idx < 0 || idx >= lines.length) return null
  const start = Math.max(0, idx - contextLines)
  const end = Math.min(lines.length - 1, idx + contextLines)
  const out: SourceContextLine[] = []
  for (let i = start; i <= end; i++) out.push({ line: i + 1, text: lines[i] ?? '' })
  return out
}

/**
 * Render a context window in `grep`'s established form: the matched line as
 * `file:N: text` (plus `matchSuffix`), every surrounding line as `file-N- text`. Extracted
 * from {@link runGrep}'s own emit loop so `refs`/`callers` `-C` produce byte-identical
 * framing rather than a second, subtly different dialect.
 */
export function renderContextWindow(
  displayFile: string,
  matchLine: number,
  window: readonly SourceContextLine[],
  matchSuffix = '',
  indent = '',
): string[] {
  return window.map((c) =>
    c.line === matchLine
      ? `${indent}${displayFile}:${c.line}: ${c.text}${matchSuffix}`
      : `${indent}${displayFile}-${c.line}- ${c.text}`,
  )
}

/** Rounds a byte count to the nearest whole kilobyte, for size labels in hints/messages. */
export function toKB(bytes: number): number {
  return Math.round(bytes / 1024)
}

/**
 * Compiles a `--grep` pattern into a predicate, following the convention every existing
 * `--grep` flag already uses: treat it as a regex, and fall back to a literal substring
 * match when it does not compile. An agent that writes `--grep "config("` means the text,
 * not a syntax error, and erroring there would cost a round trip to learn nothing useful.
 * Case-sensitive, matching the other `--grep` flags -- callers wanting otherwise pass an
 * inline `(?i)`-style alternation or a broader pattern.
 */
export function compileGrepMatcher(pattern: string): (candidate: string) => boolean {
  try {
    const re = new RegExp(pattern)
    return (candidate) => re.test(candidate)
  } catch {
    return (candidate) => candidate.includes(pattern)
  }
}

/**
 * Shared `--grep`-filtered-to-empty notice for listing commands (`types`, `exports`, `imports`,
 * `dead`, `deps`) that have no `--min-lines` counterpart to `read_commands.ts`'s
 * `filteredToEmptyNotice` (skeleton/outline). Distinguishes "the store genuinely has nothing" from
 * "the store has N items but --grep matched none of them" -- without this, both states render as
 * the same bare empty message and a caller cannot tell whether to widen the filter or give up on
 * the file/project entirely, the same "filtered store renders as populated" trap this repo has hit
 * 9+ times before. `nounSingular`/`nounPlural` name what was filtered (e.g. "type declaration" /
 * "type declarations") so the message matches the command's own vocabulary.
 */
export function grepFilteredToEmptyNotice(preFilterCount: number, grep: string, nounSingular: string, nounPlural: string): string {
  const noun = preFilterCount === 1 ? nounSingular : nounPlural
  // The verb has to agree with the noun the count already selects: "all 1 dead symbol were filtered out" reads as a typo in the tool rather than as a report about the store, and a single survivor is the most common way to hit this notice.
  const verb = preFilterCount === 1 ? 'was' : 'were'
  // The trailing pronoun has to agree for the same reason the verb does -- "all 1 type declaration was filtered out ... to see them" was half-corrected, agreeing the verb and then contradicting it one clause later.
  const pronoun = preFilterCount === 1 ? 'it' : 'them'
  return `  (all ${preFilterCount} ${noun} ${verb} filtered out by --grep ${grep} -- widen or drop the filter to see ${pronoun})`
}

/**
 * `3 references` / `1 reference` -- a count and a noun that agrees with it. Trivial, but the
 * agreement was getting dropped: `refs --exclude-tests` rendered `1 references` because five
 * call sites interpolated `${results.length} references` directly, and a test pinned that
 * output as correct. Reach for this instead of interpolating a bare noun after a count.
 */
export function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The parenthetical every `--exclude-tests` surface appends when the flag hid something, e.g.
 * `3 in test files hidden by --exclude-tests`. Shared rather than interpolated per call site
 * because the noun has to agree with the count and it previously did not: fourteen call sites
 * across refs/callers/dead/call-chain/impact/semantic each hard-coded the plural, so hiding a
 * single reference reported "1 in test files hidden" -- which reads as a bug in the tool rather
 * than as a report about the store, and one hidden ref is the most common way to reach this
 * notice at all. Same reasoning as {@link grepFilteredToEmptyNotice} directly above.
 */
export function excludeTestsHiddenNote(count: number): string {
  return `${count} in test ${count === 1 ? 'file' : 'files'} hidden by --exclude-tests`
}

/**
 * Count the lines of content actually present in `content`.
 *
 * `content.split('\n').length` counts a phantom final element for any file that
 * ends in a newline, and essentially every real file does. Anything that hands
 * that number on as a line count -- a symbol's end line, a "N lines total"
 * preview, an "showing X of N lines" marker -- then claims one line that does
 * not exist.
 */
export function countContentLines(content: string): number {
  if (content === '') return 0
  const n = content.split('\n').length
  return content.endsWith('\n') ? n - 1 : n
}

/**
 * Appends every item of `items` to `target`, the way `target.push(...items)` reads but without
 * passing the items as call arguments.
 *
 * The spread form is a function call with one argument per item, so it fails with `RangeError:
 * Maximum call stack size exceeded` somewhere around 125,000 items -- a limit on the engine's
 * call stack, not on memory, and low enough to be reached by ordinary files. A 5 MB JSON array,
 * a 300,000-element XML document and a long Word document each crashed a command that exists to
 * read exactly those files without loading them whole. Use this wherever the number of items
 * comes from a file rather than from a fixed-size slice.
 */
export function pushAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item)
}

/** Escapes regex metacharacters so a string is safely embeddable inside a `new RegExp(...)` pattern and matches only itself. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Encodes a single argument for inclusion inside a `cmd.exe /d /s /c "<command>"` command line built by joining a program path and its arguments -- the standard way Node itself must invoke a .cmd/.bat wrapper when spawnSync's shell:true is required (there is no separate .exe for most Node-based CLIs on Windows, and spawnSync cannot exec .cmd/.bat directly). This replaces a naive "quote only if it contains whitespace" approach, which let a metacharacter-bearing-but-space-free arg (& | < > ^ ( )) pass through raw and never escaped an embedded `"`, so a quoted arg could be terminated early by its own content.
//
// Ordinary characters are wrapped in a cmd.exe-recognized double-quoted span, which neutralizes & | < > ^ ( ) for cmd's own tokenizer (cmd does not re-tokenize inside "..."). Two character classes, though, are NOT neutralized by quoting and need the opposite treatment -- emitted OUTSIDE any quoted span, caret-escaped:
//   - `%` (and, defensively, `!` for delayed expansion) -- cmd.exe's percent/delayed-expansion variable substitution scans the raw command line before quote state is considered, so `"%WINDIR%"` still expands inside quotes; only `^%` (caret, unquoted) suppresses it, and a caret written *inside* a quoted span is left as a literal character in the final argument instead of being stripped, so quoting and caret-escaping can never be combined on the same character.
//   - an embedded `"` -- cmd.exe's own quote-state tracking flips on every literal `"` it sees, oblivious to backslash-escaping, so a naive `\"` emitted inside a quoted span silently closes that span early and exposes the remainder of the argument to cmd's tokenizer. The safe encoding for a literal quote is `\^"` (backslash + caret-escaped quote) emitted outside any quoted span: cmd consumes the caret (without flipping its quote-state) and passes `\"` through, which the underlying CRT/CommandLineToArgvW argv parser used by the wrapper's target executable (node.exe, npm-cli.js, etc.) then decodes as one literal `"` with no phantom quote-toggle.
// Everywhere else, backslash/quote escaping follows the CommandLineToArgvW argv-splitting convention (a run of backslashes immediately before a real quote-span boundary is doubled so the CRT parser reconstructs it exactly). All of the classes above -- embedded quote, cmd metacharacter with no adjacent whitespace, `%`/`!`, empty string, and combinations of these -- were verified against a real `cmd.exe /d /s /c` invocation of a `.cmd` wrapper forwarding to node.exe (the exact shape of the npm-shim target this function exists for) before being ported into this function; see windowsCmdQuoteArg's test file for the individual cases.
// This corrects a defect in the escaping shipped by 31a60efd: `CommandLineToArgvW` halves a run of backslashes that immediately precedes a real `"`, so every code path that emits a `"` must double whatever backslash run is pending right before it, but the original code only did that doubling on one of the three call sites that emit a quote (the in-quote branch of the close-quote helper), leaving the close-quote else-branch and the open-quote helper to emit their `"` after an undoubled run -- `%\"` round-tripped back out as `%\` and `!\"` as `!\`, silently dropping the embedded quote. flushBackslashesDoubled/flushBackslashesPlain are now the single choke point every quote-emitting branch routes through, so the doubling can't again be wired to only one of them.
export function windowsCmdQuoteArg(arg: string): string {
  if (arg === '') return '""'
  // An argument that both starts and ends with a literal `"` (e.g. `"&calc&"`) cannot be faithfully round-tripped through cmd.exe even though the encoding below is correct: cmd's own `/s` first-token scan toggles a naive quote-state per literal `"` it sees (it does not honor the caret this function uses to escape one), so the back-to-back quotes this shape emits at the very start of the token reset that naive parity to "unquoted" for the rest of the string, and cmd then treats a later metacharacter as ending the program name instead of the neutralized character it actually is -- reject here, at the single point that encodes every argument, rather than let the caller silently hand cmd a command line it will misexecute.
  if (arg[0] === '"' && arg[arg.length - 1] === '"') {
    throw new Error(`windowsCmdQuoteArg: cannot faithfully encode an argument that both starts and ends with a literal double quote for cmd.exe: ${JSON.stringify(arg)}`)
  }
  let out = ''
  let inQuote = false
  let backslashes = 0

  const flushBackslashesPlain = (): void => {
    if (backslashes > 0) {
      out += '\\'.repeat(backslashes)
      backslashes = 0
    }
  }
  const flushBackslashesDoubled = (): void => {
    out += '\\'.repeat(backslashes * 2)
    backslashes = 0
  }
  const ensureQuoteOpen = (): void => {
    if (!inQuote) {
      flushBackslashesDoubled()
      out += '"'
      inQuote = true
    } else {
      flushBackslashesPlain()
    }
  }
  const ensureQuoteClosed = (): void => {
    if (inQuote) {
      flushBackslashesDoubled()
      out += '"'
      inQuote = false
    } else {
      flushBackslashesPlain()
    }
  }

  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      flushBackslashesDoubled()
      if (inQuote) {
        out += '"'
        inQuote = false
      }
      out += '\\^"'
      continue
    }
    if (ch === '%' || ch === '!') {
      ensureQuoteClosed()
      out += `^${ch}`
      continue
    }
    ensureQuoteOpen()
    out += ch
  }
  ensureQuoteClosed()
  return out
}

/** Strips everything from the first `?` onward, so a signed or tokenized URL can't leak its
 * access material (SAS tokens, share signatures) into stderr and from there into model context
 * via an error message. String truncation rather than `new URL().origin` on purpose: the callers
 * that need this most are the ones reporting a URL that failed to parse at all, where no URL
 * object is available. Does not redact credentials in the userinfo or fragment parts. */
export function redactUrlQuery(raw: string): string {
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

/** Basename of a path, mirroring Python's os.path.basename for convenience. */
export function basename(p: string): string {
  return path.basename(p)
}

/** Strip a leading UTF-8 BOM (U+FEFF) if present -- some editors (notably Windows ones) save
 * text files with this prefix, which is valid content but trips up a strict JSON.parse. Mirrors
 * parser.ts's parseContent and section_reader.ts's inline BOM strips; this is the shared copy for
 * callers (openapi_query.ts, coverage_query.ts) that don't otherwise share a module with those two. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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

// Parses a numeric CLI flag value, rejecting anything but an exact integer literal (optional leading minus, followed by digits) instead of letting a bare Number.parseInt/parseFloat accept trailing garbage ("30x" -> 30) or exponential notation ("1e3" -> 1). Mirrors cli.ts's requireInt/requireNonNegativeInt/requirePositiveInt for command modules cli.ts itself imports (config_commands.ts, cache_session_commands.ts) — those can't import cli.ts back without a circular dependency, so this shared, dependency-free copy lives in util.ts instead.
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

/** Swallow EPIPE on the process's stdio streams so piping into an early-closing consumer (`| head -2`, `| grep -q`, a pager the user quits) ends quietly instead of crashing. Without this, Node's default `error` handling on the stream throws an unhandled 'error' event and the CLI dies with a stack trace and a nonzero exit -- `token-goat grep ... | head -2` was a hard crash, and piping to `head` is one of the most common agent invocation shapes. Only EPIPE is absorbed: any other stream error still surfaces. Returns the streams it attached to so a test can assert the wiring. */
export function installEpipeGuard(streams?: Array<NodeJS.WriteStream | undefined>): Array<NodeJS.WriteStream> {
  const targets = (streams ?? [process.stdout, process.stderr]).filter((s): s is NodeJS.WriteStream => s !== undefined)
  for (const stream of targets) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // The consumer is gone; there is nothing left to write and nothing to report to.
        process.exitCode = 0
        return
      }
      throw err
    })
  }
  return targets
}

/** Normalize path and convert backslashes to forward slashes. Extracted from 3 call sites in compact.ts. */
export function normalizePathForwardSlash(p: string, toLowerCase?: boolean): string {
  let result = normalizePath(p).replace(/\\/g, '/')
  if (toLowerCase) result = result.toLowerCase()
  return result
}

/**
 * Slice `str` at `endIndex` without splitting a UTF-16 surrogate pair -- if the code
 * unit at `endIndex` is a low surrogate (0xDC00-0xDFFF), back up one so the high
 * surrogate stays with it. Extracted from byte-identical private copies in
 * bash_compress.ts and overflow_guard.ts.
 */
export function safeSlice(str: string, endIndex: number): string {
  let idx = endIndex
  if (idx > 0 && idx < str.length) {
    const codeUnit = str.charCodeAt(idx)
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      idx--
    }
  }
  return str.slice(0, idx)
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

/**
 * Build a hook command line that invokes the shim via `process.execPath` directly rather
 * than relying on PATH/cmd.exe resolution (root cause of a real fail-closed deny-all class
 * of bugs on both Codex and Copilot CLI when `node` wasn't on the spawned hook's PATH).
 * `entryPath` (process.argv[1], the token-goat entry point that ran this install) is baked
 * in as a trailing arg so the shim's own inner `token-goat hook <event>` call can invoke it
 * directly too, instead of depending on PATH for that inner call as well. Omitted when
 * unavailable (should never happen under a real `node <script>` invocation) rather than
 * baking in something wrong; the shim's inner call falls back to its old PATH-based lookup.
 */
export function hookCommandFor(scriptPath: string, event: string): string {
  const entryPath = process.argv[1]
  const entryArg = entryPath ? ` "${entryPath}"` : ''
  return `"${process.execPath}" "${scriptPath}" ${event}${entryArg}`
}

// Capped Levenshtein distance, mirroring config_commands.ts's didYouMeanKeySuffix helper (same
// cap, same top-N/sort-by-distance shape) for consistency across this CLI's "did you mean"
// suggestions. Shared here since text_commands.ts's lockdeps command and dep_docs.ts's package
// lookup both need the identical package-name suggestion behavior.
export function packageNameDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr.push(Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost))
    }
    prev.splice(0, prev.length, ...curr)
  }
  return prev[b.length] ?? cap + 1
}

export function suggestPackageNames(query: string, names: string[]): string[] {
  return [...new Set(names)]
    .map((n) => ({ n, d: packageNameDistance(query.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.n)
}

/** The encodings {@link decodeSource} recognizes from a leading byte-order mark. `utf8` means no mark was found. */
export type SourceEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be'

/**
 * Which encoding `buf` declares through its leading byte-order mark.
 *
 * Order matters: UTF-32LE begins `FF FE 00 00`, whose first two bytes are exactly the UTF-16LE
 * mark, so the four-byte forms have to be tested first or a UTF-32 file decodes as UTF-16 and
 * comes back interleaved with NULs -- the same failure this whole helper exists to remove.
 *
 * A file with no mark is reported as `utf8` and decoded as UTF-8 exactly as before. Mark-less
 * UTF-16 is not guessed at: heuristics on byte distribution misfire on binary, and a wrong guess
 * is worse than the honest empty result.
 */
export function detectSourceEncoding(buf: Buffer): SourceEncoding {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) return 'utf32le'
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) return 'utf32be'
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
    if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom'
  return 'utf8'
}

/**
 * Decode a source file's bytes to text, honoring a byte-order mark.
 *
 * `buf.toString('utf8')` is right for almost every file and wrong for the ones Windows produces by
 * accident: PowerShell 5.1 writes UTF-16LE for `>` redirection and `Out-File`, so a script, log, or
 * generated document created that way is UTF-16 with a BOM. Decoded as UTF-8 those bytes become the
 * text interleaved with NULs, which parses to nothing at all -- the file indexes with zero symbols
 * and is reported as indexed, and `read` on it emits the doubled, NUL-laced mojibake into the
 * model's context.
 *
 * The mark itself is never part of the returned text, including for UTF-8: U+FEFF at the head of a
 * file is an encoding marker, not content, and leaving it in shifts every column on the first line
 * and stops a heading or shebang from matching at position 0.
 */
export function decodeSource(buf: Buffer): string {
  switch (detectSourceEncoding(buf)) {
    case 'utf32le':
      return decodeUtf32(buf.subarray(4), true)
    case 'utf32be':
      return decodeUtf32(buf.subarray(4), false)
    case 'utf16le':
      return buf.subarray(2).toString('utf16le')
    case 'utf16be':
      return swap16(buf.subarray(2)).toString('utf16le')
    case 'utf8-bom':
      return buf.subarray(3).toString('utf8')
    default:
      return buf.toString('utf8')
  }
}

/**
 * Re-encode `text` in `encoding`, mark included, so a command that rewrites a file puts it back the
 * way it found it.
 *
 * Without this, reading a UTF-16 file correctly and writing it back as UTF-8 would silently convert
 * it -- worse than never having read it, since the caller asked to edit one section and got the
 * whole file re-encoded.
 */
export function encodeSource(text: string, encoding: SourceEncoding): Buffer {
  switch (encoding) {
    case 'utf32le':
      return Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), encodeUtf32(text, true)])
    case 'utf32be':
      return Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), encodeUtf32(text, false)])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swap16(Buffer.from(text, 'utf16le'))])
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    default:
      return Buffer.from(text, 'utf8')
  }
}

/** Byte-swapped copy, for big-endian UTF-16: Node decodes only the little-endian form. Copies rather than swapping in place, because the input may be a view onto a buffer a caller still holds. */
function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf)
  // An odd trailing byte cannot form a code unit; dropping it loses nothing a decoder could have used.
  return out.subarray(0, out.length - (out.length % 2)).swap16()
}

/** UTF-32 has no Node decoder, so its code points are read one 4-byte unit at a time. A trailing partial unit is dropped, and a unit outside the Unicode range becomes U+FFFD rather than throwing on a truncated or corrupt file. */
function decodeUtf32(buf: Buffer, littleEndian: boolean): string {
  const points: number[] = []
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    const cp = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i)
    points.push(cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp)
  }
  return String.fromCodePoint(...points)
}

/** Counterpart to {@link decodeUtf32}. */
function encodeUtf32(text: string, littleEndian: boolean): Buffer {
  const points = [...text]
  const out = Buffer.alloc(points.length * 4)
  points.forEach((ch, i) => {
    const cp = ch.codePointAt(0) ?? 0xfffd
    if (littleEndian) out.writeUInt32LE(cp, i * 4)
    else out.writeUInt32BE(cp, i * 4)
  })
  return out
}
