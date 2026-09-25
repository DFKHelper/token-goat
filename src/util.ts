/** Cross-cutting helpers shared across token-goat modules. Kept intentionally small: only utilities with no natural owner that would otherwise be duplicated. Imports only Node built-ins and other Layer 1 files. IMPORTANT: `runGit` is the ONLY place in the entire codebase that spawns git. A structural test (git_chokepoint.test.ts) greps every src/*.ts for bare git spawn patterns outside this file and fails if any are found. */

import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import * as path from 'node:path'

import { createdBackupsFor, forgetCreatedBackup, recordCreatedBackup } from './bridges/created_configs.js'
import { assertWriteInScope } from './bridges/project_scope_guard.js'
import { ensureStorageRootPrivate } from './constants.js'
import { spawnSync } from 'node:child_process'

import { normalizePath } from './paths.js'
import { compileGuardedRegex } from './regex_guard.js'
import type { GitResult, RunGitOptions } from './types.js'

export { normalizePath }
export type { GitResult, RunGitOptions }

export {
  type HookEntryLike,
  type MatcherGroupLike,
  type MatcherGroupWithMatcher,
  stripOwnHooksFromMap,
  stripStaleGroupHooks,
  stripDelimitedBlock,
  upsertDelimitedBlock,
  writeJsonSettings,
  writeIfDifferent,
} from './util_config.js'

export {
  sleepSync,
  isWindows,
  noWindowCreationFlags,
  windowsCmdQuoteArg,
  quoteShellPath,
  quotePowershellPath,
  resolveOnPath,
  installEpipeGuard,
} from './process_util.js'
import {
  quoteShellPath,
  quotePowershellPath,
  sleepSync,
} from './process_util.js'

export type { SourceEncoding } from './encoding.js'
export {
  stripBom,
  detectSourceEncoding,
  decodeSource,
  encodeSource,
} from './encoding.js'

/** Run git and return its captured output. THE ONLY git spawn site in the codebase. Always: - prepends `-c core.fsmonitor=` to disable fsmonitor (prevents it from interfering with or being slowed by the agent's own git operations); - for a `diff` subcommand specifically, inserts `--no-ext-diff --no-textconv` right after it, so a repo-local `.gitattributes` diff driver or textconv filter can never run as a side effect of a `diff` call this codebase makes on the caller's behalf -- defense-in- depth against a malicious `.gitattributes`/git config in a repo this tool is pointed at. Deliberately NOT done via `-c diff.external=`/`-c core.attributesfile=`: an *empty* `diff.external` value is not "disabled" to git, it is a literal empty-string command to spawn, so `-c diff.external=` makes every diff fail with "cannot spawn : No such file or directory" -- confirmed by hand against a real repo. `--no-ext-diff`/`--no-textconv` are the flags git itself documents for this, and only `diff` (not `status`/`add`/etc., which don't accept them) needs them; - passes `windowsHide: true` so no console window flashes on Windows; - passes the args array directly (no shell, so nothing is shell-escaped). Output is decoded as UTF-8. A spawn failure (git not on PATH) surfaces as a non-zero `exitCode` with the error message on `stderr` rather than throwing. */
export function runGit(args: string[], opts: RunGitOptions = {}): GitResult {
  const subArgs = args[0] === 'diff' ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args
  const fullArgs = [
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
    maxBuffer: 200 * 1024 * 1024,
  })

  if (result.error) {
    return { stdout: '', stderr: String(result.error.message ?? result.error), exitCode: -1 }
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

// Case-insensitive filesystems (Windows, macOS) treat C:/Foo and C:/foo as the same path; normalizePath only lowercases the drive letter, so path-equality and dedup comparisons must fold the whole string. TOKEN_GOAT_CASE_INSENSITIVE_FS ('1' or '0') overrides the platform default for deterministic cross-platform tests.
//
// Defined in path_containment.ts and re-exported here, unchanged, so every existing `import { foldPath } from './util.js'` keeps working. The definitions had to leave this file because isInsideRoot needs them and isInsideRoot must be importable by util.ts without the import reaching project.ts -- see path_containment.ts's header for the cycle that caused.
export { foldCase, foldPath, foldCaseForContainment, foldPathForContainment, isCaseInsensitiveFs } from './path_containment.js'
// Imported as well as re-exported: this file has its own callers of foldPath below.
import { foldPath } from './path_containment.js'

/** Best-effort file size in bytes, or null when the path cannot be stat'd or isn't a regular file. */
export function statSize(absPath: string): number | null {
  try {
    const st = statSync(absPath)
    return st.isFile() ? st.size : null
  } catch {
    return null
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

/** Create a directory recursively, ignoring EEXIST errors from concurrent mkdir races. Node.js `mkdirSync(..., { recursive: true })` is not atomic: the existence check and actual mkdir syscall have a TOCTOU (time-of-check-to-time-of-use) window where two concurrent calls can both pass the check but only one wins the actual mkdir, leaving the second with an EEXIST error despite `recursive: true`. This is a known issue on Windows and some Unix systems. This function catches and ignores EEXIST specifically (the desired end-state — the directory exists — is already true), while propagating all other errors. */
export function ensureDirSync(dir: string): void {
  // Confinement first, before the mkdir: a recursive create walks through a directory symlink a clone checked in, so `.github` linked out of the tree makes the "create the parent" step itself land outside. See bridges/project_scope_guard.ts for why this is enforced here rather than at each installer.
  assertWriteInScope(dir)
  // token-goat has TWO storage roots -- the data dir (cached pages, command output, index DBs) and `~/.token-goat` (session snapshots, session state, OCR and image caches) -- and both are created owner-only before any child lands inside them. Hardening only the data root was a live hole: half the sites a sweep had already visited resolve under the home root instead. Cheap: memoized to one syscall per root per process, and the root that does not contain `dir` is not touched at all.
  ensureStorageRootPrivate(dir)
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

/** Runs `fn`, retrying up to 5 times with a `50 * attempt` ms backoff when it throws a transient Windows file-lock error (EPERM/EBUSY/ETXTBSY) -- the errno set a brief AV-scanner/search-indexer lock on the destination produces. Any other error, or the 5th consecutive failure, propagates immediately. Shared by every fs mutation in this codebase that can race a transient Windows lock: atomicWriteCore's rename below, and cli.ts's `atomicWriteBuffer` rename (which nests its own EXDEV cross-device fallback inside `fn`, so a successful fallback still counts as success here). */
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

/** Shared atomic-write core for text and bytes. Writes `content` to a sibling temp file (created with 0o600 so it is never world-readable even transiently on POSIX), then renames over `dest`. On Windows a brief exclusive-lock window can make the rename fail with EPERM/EBUSY/ETXTBSY; we retry up to 5 times with a `50 * attempt` ms backoff. Any failure past this point -- a failed write (ENOSPC, EIO, ...) just as much as a failed rename -- cleans up the temp file before the error propagates, so a partial write never leaks a `.tmp` file next to `dest`. */
function atomicWriteCore(dest: string, content: string | Uint8Array): void {
  assertWriteInScope(dest)
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

/** Atomically write UTF-8 text to `filePath` via a temp file + rename. Avoids partial writes if the process is killed mid-flight. The temp file is created with 0o600 permissions. Retries the rename on transient Windows file-lock errors (EPERM/EBUSY/ETXTBSY) up to 5 times. */
export function atomicWriteText(filePath: string, content: string): void {
  atomicWriteCore(filePath, content)
}

/** Atomically write raw bytes to `filePath` via a temp file + rename. Same guarantees as {@link atomicWriteText} but for binary content; writing bytes directly avoids the CRLF doubling a text path could introduce on Windows. */
export function atomicWriteBytes(filePath: string, content: Buffer | Uint8Array): void {
  atomicWriteCore(filePath, content)
}

/** Outcome of an {@link installSingleFilePlugin} call. */
export interface SingleFilePluginInstallResult {
  readonly filePath: string
  /** True when the file on disk was already byte-identical to the current template (no write needed). */
  readonly alreadyInstalled: boolean
}

/** Install a single-file, no-merge-target plugin/extension (pi's extension, opencode's plugin): write `template` to `filePath` unless it's already byte-identical, and unconditionally refresh the `{entryPath: process.argv[1]}` sidecar next to it so a stale sidecar gets fixed even when the plugin file itself needs no update. */
/** Generic single-file plugin installer for harnesses (Grok, Kimi, etc.) that load a plugin from a single path. Writes the template if missing, and writes a sidecar JSON recording the entryPath. Confined within projectRoot when writing project-scoped configs. */
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

/** Delete one file, refusing it if the running install declared a project scope this path leaves. The write half of containment was made a property of the helpers (`backupFile`, `ensureDirSync`, `atomicWriteCore`, `upsertDelimitedBlock`); the DESTRUCTIVE half was not, and "the write helpers themselves refuse a write the declared root does not contain" reads as a completed boundary while an unlink walks straight through it. `unlinkSync` removes the LINK rather than its target, so a leaf symlink is harmless here -- but a DIRECTORY symlink above the leaf is not: `uninstall --pi --local` on a clone that checked `.pi/extensions` in as a junction deletes the real file at the junction target, outside the tree entirely. Fixed leaf names bound the harm to files token-goat chose the names of; they do not bound WHERE those names resolve, which is the whole point of resolving through links before deciding. Returns true when a file was actually removed, so callers keep the `unlinkSync`-in-a-try semantics they had. A refusal THROWS rather than returning false: a caller that cannot tell "there was nothing to delete" from "I was refused" would report a clean uninstall of a file still sitting outside the tree. */
export function removeFileInScope(p: string): boolean {
  assertWriteInScope(p)
  try {
    unlinkSync(p)
    return true
  } catch {
    return false
  }
}

/** Remove an empty directory within the project or user scope, e.g. an empty `.vscode` folder left behind after removing a configuration file. */
export function removeEmptyDirInScope(dirPath: string): boolean {
  assertWriteInScope(dirPath)
  try {
    const entries = readdirSync(dirPath)
    if (entries.length === 0) {
      rmdirSync(dirPath)
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Remove a single-file plugin/extension and its entry sidecar (see {@link installSingleFilePlugin}). Returns true when the main file was actually present and removed; false when nothing was installed (no write occurs either way). */
export function uninstallSingleFilePlugin(filePath: string, sidecarPath: string): boolean {
  // The sidecar's removal is best-effort (an install predating it has none), but it is still scope-checked: it sits in the same attacker-choosable directory as the plugin file.
  removeFileInScope(sidecarPath)
  return removeFileInScope(filePath)
}

/** Copy `p` to a timestamped `<p>.bak.<ISO-with-dashes>` sibling before an in-place overwrite, so a bad merge or corrupt rewrite has a recovery copy. No-op if `p` doesn't exist yet (nothing to back up). */
// Caps how many timestamped backups pile up per file. backupFile runs on every install/ uninstall of a harness's hook config (install.ts, codex_install.ts, copilot_cli_install.ts, gemini_install.ts, openclaw_install.ts), so a config directory a user re-installs into repeatedly would otherwise accumulate one .bak.<timestamp> file forever.
const MAX_BACKUPS_PER_FILE = 5

/** Distinct `.bak` names tried for one timestamp before the collision is reported as a real error. Each attempt is one attacker-planted link or one genuine same-millisecond backup; a handful is far more than either produces, and the bound is what keeps a directory somebody has filled with planted links from spinning here. */
const MAX_BACKUP_NAME_ATTEMPTS = 16

export function backupFile(p: string): void {
  // Before the existsSync, so the refusal does not depend on whether the link has a live target.
  assertWriteInScope(p)
  if (!existsSync(p)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let backupPath: string
  for (let attempt = 0; ; attempt++) {
    // Suffix from the second attempt on, so the ordinary name stays exactly `<p>.bak.<ISO>` and every existing reader of that shape (pruneOldBackups' ledger, the uninstall sweep, the `.bak.\d{4}-` filters in the install tests) is unaffected.
    backupPath = attempt === 0 ? `${p}.bak.${stamp}` : `${p}.bak.${stamp}-${attempt}`
    try {
      // COPYFILE_EXCL: fail rather than write through an existing destination. Without it a `.bak.<ISO>` path a repository checked in as a symlink is a write primitive -- copyFileSync follows a destination link and lands the source's bytes wherever it points. The source side is handled by the caller: assertProjectScopeTarget (bridges/project_scope_guard.ts) refuses a project-scope path that resolves outside the project before any read or backup runs.
      copyFileSync(p, backupPath, fsConstants.COPYFILE_EXCL)
      break
    } catch (err) {
      // EEXIST is the ONE error retried, and retrying it never weakens the link defence: EXCL is set on every attempt, so an occupied name is skipped rather than written through. The installer needs this: `installVscode` in project scope backs up the same instructions file twice in one process (writeGuidance, then syncVisualStudioProjectGuidance -> upsertDelimitedBlock), and the two calls land 4-6 ms apart -- inside one millisecond on faster hardware, where an unhandled EEXIST would abort the install outright. Failing loudly is not the safe direction when the collision is with token-goat's own earlier backup.
      if (!isEExist(err) || attempt >= MAX_BACKUP_NAME_ATTEMPTS - 1) throw err
    }
  }
  // Recorded at the instant it is created, so uninstall can later delete this file and no other. Nothing else identifies it: the name is one a user could have chosen too.
  recordCreatedBackup(backupPath)
  pruneOldBackups(p)
}

function pruneOldBackups(p: string): void {
  // The candidate set is the ledger, not a directory listing: a user's own file matching the `.bak.<stamp>` shape was never recorded, so it is never even considered for deletion.
  const backups = createdBackupsFor(p)
  const excess = backups.length - MAX_BACKUPS_PER_FILE
  for (const stalePath of backups.slice(0, Math.max(0, excess))) {
    try {
      removeFileInScope(stalePath)
      // Keep the ledger in step: a backup this pruned is gone, and a stale entry for it would otherwise sit there forever pointing at nothing.
      forgetCreatedBackup(stalePath)
    } catch {
      // Best-effort cleanup; a failed unlink here shouldn't fail the caller's backup.
    }
  }
}

// Per-file ceiling on a single file's contribution to a bytes-saved stat's counterfactual "what reading it whole would have cost" side, deliberately NOT read from config: it's derived from two independent, unrelated sources landing within 8% of each other -- token-goat's own FILE_TYPE_THRESHOLDS.generic (src/hints/file_type_handler.ts) is 100_000, the size above which token-goat itself intercepts an unrecognized file rather than letting it be read whole, so "the agent would have read the whole file" is contradicted by token-goat's own behavior past that point; and Claude Code's Read tool truncates at 2000 lines by default, which at this repo's measured ~54 bytes/line (read_commands.ts: 271,673 bytes / ~5000 lines) puts Read's real ceiling at ~108,000 bytes -- and it stays a hardcoded constant rather than a config knob because coupling the ledger's unit to a user-configurable threshold would let a config change silently rewrite historical stat comparability. Lives in util.ts rather than beside its original caller (sumFileSizes) because the re-read hook credits the same counterfactual per file and must not import read_commands.ts to say so: that module's eval cost is a large share of hook startup.
export const PER_FILE_COUNTERFACTUAL_CEILING = 100_000

/** Bytes a surgical-read CLI command may honestly claim it saved against reading `file` whole. The naive form these commands shipped with -- `fullSourceBytes - emittedBytes` -- prices the counterfactual as "the model would have loaded every byte of the source into context", which is false for exactly the inputs this family handles: a `pdf-meta` of a 40 MB scan credited all 40 MB against a dozen lines of metadata, and no Read of that file could ever have cost that, because the harness truncates and (per {@link PER_FILE_COUNTERFACTUAL_CEILING}) token-goat itself intercepts rather than serving a file that large whole. Capping the counterfactual -- not the emitted side -- is the same correction already applied on the hook path by `counterfactualCredit` in hooks_read.ts and by the deny credit in hooks_mcp.ts. Floor of 1 rather than 0, matching what these call sites already did: a command that emitted more than its capped counterfactual still records an event, so the kind's row count stays a true usage count. Only the credited magnitude changes. */
export function cappedSourceBytesSaved(fullSourceBytes: number, emittedBytes: number): number {
  return Math.max(1, Math.min(fullSourceBytes, PER_FILE_COUNTERFACTUAL_CEILING) - emittedBytes)
}

/** Body size below which collapsing an identical re-read cannot pay for itself: the replacement pointer is itself ~150 bytes. The real floor is the shared `bash_compress.min_net_savings_bytes` gate applied at the collapse site; this is only the cheap pre-check that avoids a hash and a cache lookup for output that could never qualify. Lives here rather than beside the collapse in hooks_bash.ts because both ends of that feature need it and neither hook module may import the other: each registers its hooks at module scope, so importing across them would arm one surface's handlers from the other's process. The producer side (hooks_read.ts) skips storing a slice smaller than this floor, since a stored body can only ever match a later read that is itself at least this large. */
export const IDENTICAL_READ_MIN_BODY_BYTES = 512

/** True when every line of `needle` appears as a contiguous, line-aligned run inside `haystack`. Line-aligned deliberately. A plain substring test would report a match when the new output merely starts mid-line inside the old one, and the lines withheld on the strength of that would not be the lines the model was actually shown. Wrapping both sides in newlines forces the match to begin at a line start and end at a line end, so a hit means the exact lines were served verbatim. One trailing newline is stripped from each side first, since the same run of lines is spelled with and without it depending on the command, and comparing raw would call those two different. Nothing else is normalized: CR is left in place, so a body that changed only its line endings correctly fails to match rather than being treated as already served. Lives here because both hook modules that withhold an already-served body need it -- the shell collapse and the read-side deny -- and neither may import the other: each registers its hooks at module scope. */
export function containsLineRun(haystack: string, needle: string): boolean {
  const h = haystack.endsWith('\n') ? haystack.slice(0, -1) : haystack
  const n = needle.endsWith('\n') ? needle.slice(0, -1) : needle
  if (n.length === 0 || n.length > h.length) return false
  return ('\n' + h + '\n').includes('\n' + n + '\n')
}

// Bounds how long withFileLock waits behind another holder before giving up (never hangs the caller indefinitely), and how old an unreleased lock file must be before a crashed holder's lock is treated as abandoned and stolen.
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 5000

// Larger wait budget for hot, contended withFileLock call sites (e.g. session_store.ts's saveSessionState, config_commands.ts's `config set`) where the default LOCK_WAIT_MS can plausibly be missed under real machine load even though no lock holder is actually stuck. Falling back to an unprotected write on that miss reintroduces the exact clobber the lock exists to prevent, precisely when contention (and therefore risk) is highest -- so these call sites wait much longer instead. An actually-wedged holder still gets its lock stolen well before this via withFileLock's own staleMs abandonment check, so this only lengthens the wait for genuine, resolving contention, not a real hang.
export const LOCK_WAIT_MS_HARDENED = 15_000

// How long a lock whose holder is still running is honoured past staleMs. A holder's liveness is read from the pid its token carries, and a pid can be reused once its process is gone, so a lock naming a live process is still taken once it is this old; a legitimate holder never blocks a session save or a config write for anything close to this.
const LOCK_LIVE_HOLDER_MAX_MS = 60_000

/** Whether the process that wrote lock token `token` (`<pid>:<hrtime>`) is still running and is not this one. A token naming no pid, a pid that is gone, or this process's own pid (a synchronous holder here has already returned or thrown, and released) reads as not alive, so that lock is judged by its age alone. `EPERM` means the process exists under another user, which is alive. */
function lockHolderAlive(token: string): boolean {
  const pid = Number(/^(\d+):/.exec(token)?.[1])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Runs `fn` while holding an exclusive lock at `lockPath`, so the same critical section never runs concurrently across separate OS processes. The mutex primitive is an atomic exclusive-create write (`wx`), which behaves identically on Windows and POSIX, unlike advisory `flock`. If another process already holds the lock, this waits (backoff style mirrors atomicWriteCore's rename retry) for up to `waitMs` before giving up. A lock file whose mtime is older than `staleMs` is treated as abandoned by a holder that crashed without releasing it and is stolen, so one crashed process can never permanently wedge every future caller of this critical section. A lock whose holder is still running (see lockHolderAlive above) is not stolen at staleMs, so a live holder -- even one whose fn() blocks the thread for longer than staleMs -- is never mistaken for a crashed one. Returns `undefined` -- without ever calling `fn` -- if the lock could not be acquired in time. Callers whose own persistence must never block forever should treat that as "proceed without the lock" (e.g. fall back to an unprotected write), not as a hard failure. */
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
    // Someone else holds it. A holder that crashed without releasing it would otherwise wedge every future caller of this critical section forever, so a lock file older than staleMs whose holder is no longer running is abandoned and stolen. A holder that is still running keeps its lock however long fn() blocks, up to LOCK_LIVE_HOLDER_MAX_MS.
    let stale: boolean
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs
      stale = age > staleMs && (age > Math.max(staleMs, LOCK_LIVE_HOLDER_MAX_MS) || !lockHolderAlive(readFileSync(lockPath, 'utf8')))
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

/** Sanitize an arbitrary id/string into a filesystem-safe stem: every character outside `[A-Za-z0-9_-]` becomes `_`, then the result is capped to `maxLen` chars (omit for no cap). Pass `fallback` to substitute a non-empty default when sanitization yields an empty string (e.g. an id made entirely of disallowed characters); omitted, an empty result is returned as-is. Shared by every call site that turns a session/content id into a safe directory or file name (compact.ts, snapshots.ts, session_store.ts, disk_cache.ts, doc_compact.ts) so the character class stays in exactly one place. */
export function sanitizeIdForFilename(id: string, maxLen?: number, fallback?: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLen)
  return safe.length > 0 ? safe : (fallback ?? safe)
}

/** Rounds a byte count to the nearest whole kilobyte, for size labels in hints/messages. */
export function toKB(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** Compiles a `--grep` pattern into a predicate, following the convention every existing `--grep` flag already uses: treat it as a regex, and fall back to a literal substring match when it does not compile. An agent that writes `--grep "config("` means the text, not a syntax error, and erroring there would cost a round trip to learn nothing useful. Case-sensitive, matching the other `--grep` flags -- callers wanting otherwise pass an inline `(?i)`-style alternation or a broader pattern. A pattern that would stall the process takes the same fallback, for the same reason and by the same route: this returns a predicate and has no channel to report a problem through, and a substring match is both safe and closer to what the caller meant than a hang. `compileGuardedRegex` decides that; see `regex_guard.ts` for why a shape check alone does not. */
export function compileGrepMatcher(pattern: string): (candidate: string) => boolean {
  const guarded = compileGuardedRegex(pattern)
  if (!guarded.ok) return (candidate) => candidate.includes(pattern)
  const re = guarded.re
  return (candidate) => re.test(candidate)
}

/** Shared `--grep`-filtered-to-empty notice for listing commands (`types`, `exports`, `imports`, `dead`, `deps`) that have no `--min-lines` counterpart to `read_commands.ts`'s `filteredToEmptyNotice` (skeleton/outline). Distinguishes "the store genuinely has nothing" from "the store has N items but --grep matched none of them" -- without this, both states render as the same bare empty message and a caller cannot tell whether to widen the filter or give up on the file/project entirely, the same "filtered store renders as populated" trap this repo has hit 9+ times before. `nounSingular`/`nounPlural` name what was filtered (e.g. "type declaration" / "type declarations") so the message matches the command's own vocabulary. */
export function grepFilteredToEmptyNotice(preFilterCount: number, grep: string, nounSingular: string, nounPlural: string): string {
  const noun = preFilterCount === 1 ? nounSingular : nounPlural
  // The verb has to agree with the noun the count already selects: "all 1 dead symbol were filtered out" reads as a typo in the tool rather than as a report about the store, and a single survivor is the most common way to hit this notice.
  const verb = preFilterCount === 1 ? 'was' : 'were'
  // The trailing pronoun has to agree for the same reason the verb does -- "all 1 type declaration was filtered out ... to see them" was half-corrected, agreeing the verb and then contradicting it one clause later.
  const pronoun = preFilterCount === 1 ? 'it' : 'them'
  return `  (all ${preFilterCount} ${noun} ${verb} filtered out by --grep ${grep} -- widen or drop the filter to see ${pronoun})`
}

/** The multi-filter sibling of {@link grepFilteredToEmptyNotice}, for surfaces where more than one filter flag can be active at once (skeleton/outline's `--min-lines` + `--grep`, csv-query's repeatable `--where`). Names every active filter rather than blaming the first one, and takes an optional `reassurance` clause for callers that also need to say the underlying store is fine (e.g. "the file is indexed"). Same "filtered store renders as populated" trap as its sibling. */
export function filtersFilteredToEmptyNotice(preFilterCount: number, activeFilters: string[], nounSingular: string, nounPlural: string, reassurance?: string): string {
  const noun = preFilterCount === 1 ? nounSingular : nounPlural
  // Name every filter that is actually active, not just the first one: with both set, blaming one of them sends the caller to widen the wrong knob.
  const cause = activeFilters.length === 0 ? 'the active filter' : activeFilters.join(' + ')
  const knob = activeFilters.length > 1 ? 'filters' : 'filter'
  // The verb has to agree with the noun the count already selects: "all 1 indexed symbol were filtered out" reads as a typo in the tool rather than as a report about the file.
  const verb = preFilterCount === 1 ? 'was' : 'were'
  const tail = reassurance === undefined ? '' : `; ${reassurance}`
  return `  (all ${preFilterCount} ${noun} ${verb} filtered out by ${cause}${tail} -- widen or drop the ${knob} to see them)`
}

/** `3 references` / `1 reference` -- a count and a noun that agrees with it. Trivial, but the agreement was getting dropped: `refs --exclude-tests` rendered `1 references` because five call sites interpolated `${results.length} references` directly, and a test pinned that output as correct. Reach for this instead of interpolating a bare noun after a count. */
export function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** The parenthetical every `--exclude-tests` surface appends when the flag hid something, e.g. `3 in test files hidden by --exclude-tests`. Shared rather than interpolated per call site because the noun has to agree with the count and it previously did not: fourteen call sites across refs/callers/dead/call-chain/impact/semantic each hard-coded the plural, so hiding a single reference reported "1 in test files hidden" -- which reads as a bug in the tool rather than as a report about the store, and one hidden ref is the most common way to reach this notice at all. Same reasoning as {@link grepFilteredToEmptyNotice} directly above. */
export function excludeTestsHiddenNote(count: number): string {
  return `${count} in test ${count === 1 ? 'file' : 'files'} hidden by --exclude-tests`
}

/** Count the lines of content actually present in `content`. `content.split('\n').length` counts a phantom final element for any file that ends in a newline, and essentially every real file does. Anything that hands that number on as a line count -- a symbol's end line, a "N lines total" preview, an "showing X of N lines" marker -- then claims one line that does not exist. */
export function countContentLines(content: string): number {
  if (content === '') return 0
  const n = content.split('\n').length
  return content.endsWith('\n') ? n - 1 : n
}

/** Appends every item of `items` to `target`, the way `target.push(...items)` reads but without passing the items as call arguments. The spread form is a function call with one argument per item, so it fails with `RangeError: Maximum call stack size exceeded` somewhere around 125,000 items -- a limit on the engine's call stack, not on memory, and low enough to be reached by ordinary files. A 5 MB JSON array, a 300,000-element XML document and a long Word document each crashed a command that exists to read exactly those files without loading them whole. Use this wherever the number of items comes from a file rather than from a fixed-size slice. */
export function pushAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item)
}

/** Escapes regex metacharacters so a string is safely embeddable inside a `new RegExp(...)` pattern and matches only itself. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Strips everything from the first `?` onward, so a signed or tokenized URL can't leak its access material (SAS tokens, share signatures) into stderr and from there into model context via an error message. String truncation rather than `new URL().origin` on purpose: the callers that need this most are the ones reporting a URL that failed to parse at all, where no URL object is available. Does not redact credentials in the userinfo or fragment parts. */
export function redactUrlQuery(raw: string): string {
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

/** Basename of a path, mirroring Python's os.path.basename for convenience. */
export function basename(p: string): string {
  return path.basename(p)
}

/** Swap `filePath`'s extension for `format` (e.g. `'jpeg'` -> `.jpg`, `'webp'` -> `.webp`), preserving its directory and basename. Used after `shrinkImage()` re-encodes a capture to a different container format, so the extension actually reflects the bytes written -- writing JPEG bytes under a caller-requested `.png` path would otherwise silently mislabel the file. */
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

/** Right-pad `s` with spaces to width `n` (no-op if already at/over width). Extracted from byte-identical private copies in cache_session_commands.ts, cli_hint_stats.ts, cli_recall.ts. */
export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** Normalize path and convert backslashes to forward slashes. Extracted from 3 call sites in compact.ts. */
export function normalizePathForwardSlash(p: string, toLowerCase?: boolean): string {
  let result = normalizePath(p).replace(/\\/g, '/')
  if (toLowerCase) result = result.toLowerCase()
  return result
}

/** Slice `str` at `endIndex` without splitting a UTF-16 surrogate pair -- if the code unit at `endIndex` is a low surrogate (0xDC00-0xDFFF), back up one so the high surrogate stays with it. Extracted from byte-identical private copies in bash_compress.ts and overflow_guard.ts. */
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

/** True when `filePath` lives under any of `blockedRoots` (each an absolute path prefix set via `token-goat project exclude`). Comparison resolves and case-folds both sides (see normalizePath/foldPath) so a Windows drive-letter or separator difference cannot let a blocked file slip through, and respects path boundaries so a blocked root of `foo` does not also match a sibling directory named `foo-bar`. */
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

/** True when `now` (local time) falls inside the `"HH:MM-HH:MM"` window described by `spec` (24h clock). An empty `spec` or one that doesn't parse means quiet hours are disabled -- always false. A window whose end is earlier than or equal to its start (e.g. `"22:00-06:00"`) wraps past midnight. */
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

/** Build a hook command line that invokes the shim via `process.execPath` directly rather than relying on PATH/cmd.exe resolution (root cause of a real fail-closed deny-all class of bugs on both Codex and Copilot CLI when `node` wasn't on the spawned hook's PATH). `entryPath` (process.argv[1], the token-goat entry point that ran this install) is baked in as a trailing arg so the shim's own inner `token-goat hook <event>` call can invoke it directly too, instead of depending on PATH for that inner call as well. Omitted when unavailable (should never happen under a real `node <script>` invocation) rather than baking in something wrong; the shim's inner call falls back to its old PATH-based lookup. */
export function hookCommandFor(scriptPath: string, event: string): string {
  const entryPath = process.argv[1]
  const entryArg = entryPath ? ` ${quoteShellPath(entryPath)}` : ''
  return `${quoteShellPath(process.execPath)} ${quoteShellPath(scriptPath)} ${event}${entryArg}`
}

/** hookCommandFor's exec-form parts, for a harness whose hook schema accepts an `args` array alongside `command` (Claude Code >= 2.1.139): the harness spawns `command` directly with that argv, so nothing needs shell-quoting and no shell process sits in front of every hook call. */
export function hookExecPartsFor(scriptPath: string, event: string): { command: string; args: string[] } {
  const entryPath = process.argv[1]
  return { command: process.execPath, args: entryPath ? [scriptPath, event, entryPath] : [scriptPath, event] }
}

/** hookCommandFor's PowerShell form: the same shape, single-quoted so PowerShell cannot expand a `$` in any embedded path. */
export function hookPowershellCommand(scriptPath: string, event: string): string {
  const entryPath = process.argv[1]
  const entryArg = entryPath ? ` ${quotePowershellPath(entryPath)}` : ''
  return `${quotePowershellPath(process.execPath)} ${quotePowershellPath(scriptPath)} ${event}${entryArg}`
}

