/**
 * Duplicate-invocation suppression for VS Code agent hooks.
 *
 * VS Code discovers hook files from two independent sources -- the user one (`~/.copilot/hooks`,
 * shared with `install --copilot`) and the workspace-local one (`<root>/.github/hooks`, one per
 * workspace folder) -- and runs EVERY file it finds. Captured live against VS Code 1.137.0
 * (`645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`): with a hooks file in both scopes, one chat turn
 * produced two invocations of every event -- sessionStart, userPromptSubmitted, preToolUse,
 * postToolUse and agentStop -- inside a single session id, and an identical basename in both
 * scopes did not dedupe them. A multi-root workspace with a project install in each root fires
 * once per root the same way, each copy carrying its own root as the payload `cwd`.
 *
 * The discriminating principle for what to do about it:
 *
 * - **Where a path can be gated on, let the path gate decide.** `vscode_path_gate.ts` already
 *   refuses any target outside the workspace cwd the harness supplied, and every VS Code
 *   pre_tool_use handler that stats or reads a path calls it first
 *   (`tests/vscode_pre_handler_path_gate.test.ts` sweeps the registry so none can skip it). In an
 *   N-root workspace exactly one copy's workspace contains the target, so the other N-1 decline
 *   themselves for free. No code here is needed for that case and none is written.
 * - **Where there is no path to gate on, first writer wins.** That is the pathless advisories
 *   (session start, prompt submit, stop, compact) and the Bash pipeline, whose paths live inside
 *   a shell command string (`run_in_terminal`'s captured `tool_input` is
 *   `{command, explanation, goal, mode}` -- no path at all) and are resolved against the cwd
 *   rather than gated. Those are indistinguishable between copies, so one is elected by an
 *   exclusive-create marker keyed on the payload's own identity.
 *
 * The marker key is exact rather than heuristic: duplicate invocations of one event carry a
 * byte-identical payload `timestamp` (captured: both `preToolUse` firings of one call reported
 * `2026-09-12T18:00:06.528Z`), so `(session_id, event, timestamp)` names one logical event.
 *
 * Separately, the cross-scope case is settled at its source rather than by election: a user-scope
 * copy stands down when the workspace it was handed has its own project-scope install, because
 * that copy is the one with the correct per-root cwd. The user-scope copy cannot get one -- VS
 * Code resolves its cwd to `folders[0]` for every invocation, which is the whole reason
 * `install --vscode` now defaults to project scope.
 *
 * **Everything here fails OPEN.** Every path returns `false` (do not suppress) on any error, on a
 * missing timestamp, on an unreadable marker directory. A suppression bug that silences hooks is
 * indistinguishable from working correctly -- it produces no error and no output -- so the only
 * acceptable failure direction is a duplicate hook, never a missing one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readCopilotHooksOwners } from './bridges/copilot_cli_install.js'
import { hasCreatedConfig } from './bridges/created_configs.js'
import { dataDir } from './constants.js'
import type { HookEvent } from './hook_registry.js'
import { getCwd, getFilePath } from './hooks_common.js'
import { displaySafeText } from './paths.js'
import { atomicWriteText, ensureDirSync } from './util.js'
import { vscodePathAllowed } from './vscode_path_gate.js'

/**
 * Set by the hook shim to its own directory, which is the hooks directory VS Code loaded it from.
 * That is the only way this process can tell a user-scope copy from a project-scope one: both are
 * byte-identical files running the same binary, and the payload is identical too (captured: the
 * two copies' env and payload differ in nothing but the `cwd` VS Code resolved for each).
 */
export const VSCODE_HOOKS_DIR_ENV = 'TOKEN_GOAT_VSCODE_HOOKS_DIR'

/** Markers older than this are litter from finished sessions. */
const MARKER_MAX_AGE_MS = 60 * 60 * 1000

/** A prune scans the marker directory at most this often, so a busy session does not restat it per event. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

function markerDir(): string {
  return path.join(dataDir(), 'vscode-dedupe')
}

function foldDir(p: string): string {
  const forward = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? forward.toLowerCase() : forward
}

/** The hooks directory VS Code loaded this invocation's shim from, or undefined when it did not say. */
function shimHooksDir(): string | undefined {
  const raw = process.env[VSCODE_HOOKS_DIR_ENV]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** `~/.copilot/hooks` -- the user-scope hooks directory, mirroring `vscodeHooksDir()`'s user branch. */
function userHooksDir(): string {
  return path.join(os.homedir(), '.copilot', 'hooks')
}

/**
 * True when this invocation is the user-scope copy AND the workspace it was handed carries its own
 * project-scope token-goat hooks file THIS MACHINE INSTALLED. That project copy sees the same event
 * with a cwd that is actually this workspace folder, so it is the one that should answer.
 *
 * The bare `existsSync` this started as made a repository file into an off switch: committing
 * `.github/hooks/token-goat.json` containing `{}` stood the real user-scope hook down for every
 * event in that clone -- read dedup, hints, image shrinking, edit-queue reindexing and the
 * pre-approval path gate all silently returned `{}`, which is indistinguishable from working.
 * Two independent checks now have to agree before this copy defers:
 *
 * - the ownership sidecar (`token-goat.owners`) names `vscode`, which `installCopilotHooksFile`
 *   writes and a hooks file dropped in by hand does not have; and
 * - the created-configs ledger, which lives in token-goat's own data directory OUTSIDE the clone,
 *   records that an install on this machine wrote that exact path.
 *
 * A repository can still forge the sidecar -- it is a plain text file in the clone -- so this
 * raises the cost of the attack rather than eliminating the class. The ledger is what a clone
 * cannot write, and it is the check that actually has to fail for the attack to work; the sidecar
 * is kept because it is the cheap one and it also catches the honest case of an unrelated
 * third-party hooks file sharing the name.
 *
 * Both checks fail CLOSED for suppression and OPEN for the hook: anything unproven means this copy
 * keeps working, which duplicates a hook at worst. See the module header for why that is the only
 * acceptable direction.
 */
function userScopeCopyIsRedundant(event: HookEvent): boolean {
  const hooksDir = shimHooksDir()
  if (hooksDir === undefined) return false
  if (foldDir(hooksDir) !== foldDir(userHooksDir())) return false
  const cwd = getCwd(event)
  // No cwd means no workspace folder is open, so there is no project copy to defer to.
  if (cwd === undefined || cwd === '') return false
  const projectHooksDir = path.join(cwd, '.github', 'hooks')
  // This runs before VS Code has asked the user to approve anything, and `cwd` is whatever the
  // harness handed us, so the read below goes through the same gate every pre_tool_use handler
  // uses. It matters most for a UNC `cwd` (`\\host\share`): on Windows merely statting one opens
  // an SMB connection to that host and offers an NTLM authentication, with no timeout available on
  // the in-process path -- a hook that hangs or leaks a credential hash before approval.
  if (!vscodePathAllowed(projectHooksDir, cwd)) return false
  if (!readCopilotHooksOwners(projectHooksDir).has('vscode')) return false
  return hasCreatedConfig(path.join(projectHooksDir, 'token-goat.json'))
}

/**
 * One line on stderr, only when TOKEN_GOAT_LOG is set, saying that this copy stood down.
 *
 * A hook that stands down produces no error and no output, which is exactly what made the
 * repository-file off switch above invisible: the failure and the success look identical from
 * outside. This is the record that tells them apart. stderr, not stdout -- stdout is the hook's
 * wire response -- and `displaySafeText` because a workspace path is attacker-influenced content
 * being written into someone's log.
 */
function logStandDown(reason: string, event: HookEvent): void {
  if (process.env['TOKEN_GOAT_LOG'] === undefined || process.env['TOKEN_GOAT_LOG'] === '') return
  try {
    process.stderr.write(displaySafeText(`token-goat: vscode hook stood down (${reason}) event=${event.eventName} cwd=${getCwd(event) ?? '<none>'}`) + '\n')
  } catch {
    // A log line must never be the reason a hook fails.
  }
}

/**
 * A stable, filesystem-safe name for one logical event. Not a cryptographic hash: it only has to
 * separate distinct events within one marker directory, and a collision costs a suppressed
 * duplicate rather than anything unsafe.
 *
 * The fields are NUL-separated so no field's content can impersonate a boundary, written as an
 * escape rather than a literal control byte: a raw NUL in source survives neither every editor nor
 * every diff tool, and losing the separator silently merges distinct events onto one marker.
 */
function markerName(sessionId: string, eventName: string, timestamp: string): string {
  const raw = `${sessionId}\u0000${eventName}\u0000${timestamp}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < raw.length; i++) {
    h1 = Math.imul(h1 ^ raw.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 + raw.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/**
 * Delete markers past MARKER_MAX_AGE_MS, at most once per PRUNE_INTERVAL_MS across all processes
 * (the throttle is the stamp file's own mtime, so concurrent hook processes share it).
 *
 * If this never runs -- the directory is unwritable, the stamp cannot be stamped, a session ends
 * and the user never opens VS Code again -- the residue is empty files of ~0 bytes each, one per
 * pathless event, inside token-goat's own data directory. It is never written to the repository or
 * the working directory. The next VS Code hook invocation on that machine prunes them.
 */
function pruneMarkers(dir: string): void {
  const stamp = path.join(dir, '.pruned')
  try {
    const last = fs.statSync(stamp).mtimeMs
    if (Date.now() - last < PRUNE_INTERVAL_MS) return
  } catch {
    // No stamp yet: this is the first prune.
  }
  try {
    // atomicWriteText, not writeFileSync: it is the only text-write helper that runs
    // ensureDataDirPrivate() first, so the data root cannot be created 0755 by whichever writer
    // happens to land there first. On a fresh install where a hook fires before any CLI command,
    // that writer is this one. The hardening memoizes to one syscall per process.
    atomicWriteText(stamp, '')
  } catch {
    // Unwritable stamp means the prune is unthrottled rather than skipped; still better than not pruning.
  }
  const cutoff = Date.now() - MARKER_MAX_AGE_MS
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === '.pruned') continue
    const full = path.join(dir, entry)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
    } catch {
      // A marker another process just removed, or one we may not delete: leave it.
    }
  }
}

/**
 * Claim this logical event for this process. Returns true when some earlier copy already claimed
 * it (so this one should stand down), false when this copy is the winner OR when the election
 * could not be held at all -- an unwritable data directory elects everybody, which duplicates a
 * hook rather than silencing one.
 */
function alreadyClaimed(sessionId: string, eventName: string, timestamp: string): boolean {
  const dir = markerDir()
  try {
    // ensureDirSync, not a bare recursive mkdir: it hardens the data ROOT to 0700 before creating
    // anything under it. A bare mkdir here takes the process umask, which is 0755 on a stock Linux
    // box -- and this is a first-write path, so on a fresh install it is what creates the root.
    ensureDirSync(dir)
  } catch {
    return false
  }
  const marker = path.join(dir, markerName(sessionId, eventName, timestamp))
  try {
    // 'wx' is the election: exactly one caller creates the file, every later one gets EEXIST.
    fs.closeSync(fs.openSync(marker, 'wx'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return true
    // Anything else (EACCES, ENOSPC, EROFS) means no election happened. Fail open.
    return false
  }
  pruneMarkers(dir)
  return false
}

/**
 * Whether this VS Code hook invocation is a duplicate of one another copy is already handling.
 *
 * Never throws and never suppresses on an error path; see this module's header for why that
 * direction is the only acceptable one.
 */
export function shouldSuppressDuplicateVscodeHook(event: HookEvent, harness: string): boolean {
  if (harness !== 'vscode') return false
  try {
    if (userScopeCopyIsRedundant(event)) {
      logStandDown('a project-scope install owns this workspace', event)
      return true
    }

    // A gateable path is present: vscode_path_gate.ts already elects the copy whose workspace
    // contains it, and electing a second time here could stand down the only copy that would
    // have acted.
    if (getFilePath(event) !== undefined) return false

    const sessionId = event.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const timestamp = event.raw['timestamp']
    // Without the payload timestamp two genuinely distinct events of the same kind in one session
    // are indistinguishable, and suppressing on (session, event) alone would drop real work.
    if (typeof timestamp !== 'string' || timestamp === '') return false

    if (!alreadyClaimed(sessionId, event.eventName, timestamp)) return false
    logStandDown('another copy already claimed this event', event)
    return true
  } catch {
    return false
  }
}
