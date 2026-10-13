/** Failure-recovery pairs: remember what fixed a failed Bash command, and say so the next time it fails the same way. A failed command C opens a pending pair; when C (or C behind a prefix such as an env activation, `npx`, `uv run` or `env VAR=`) then exits 0 within {@link RECOVERY_WINDOW} later Bash calls with no edit between, the fix is what the model ran in between, or the prefix S added to C. A rerun with nothing between is a flaky command, and an edit between means the edit was the fix (the code changed, not the environment), so both learn nothing. Pairs live per project in a sidecar JSON under the token-goat data dir, keyed by the project hash, with no database migration; a later session whose Bash fails the same way (same command in the same directory, same first error line) gets one line naming the fix as history once two distinct sessions have learned it, and the pair is scored on what follows: the fix ran and C then passed is a help, C failing again after the fix is a hurt, and two hurts with more hurts than helps retire it. Nothing is learned from a command that names token-goat, can not sit inside one backtick fence, or carries a credential, and a fix is kept only when every part starts with an allowlisted build, test or install verb (recovery_fix_policy.ts): the stored fix is replayed into the model's context, so it has to be safe to run on sight. No command line is written to disk: the failed command, its prefix and its directory-scoped shape are kept as HMAC-SHA-256 digests under a per-install key, and a command run in between is kept as text only when it passes that allowlist and carries no credential, otherwise as {@link OTHER_STEP}, which makes the pair unlearnable, and the failed command rerun behind a prefix is kept as that prefix and {@link RERUN_PLACEHOLDER}, never its arguments; a file from before digests is ignored (STORE_VERSION, PENDING_VERSION). */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path'

import { stripLeadingAssignments } from './bash_extractors.js'
import { dataDir } from './constants.js'
import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { applyHintTracking, uncorrelatedHint } from './hint_stats.js'
import { contextOutput, getCwd } from './hooks_common.js'
import { fencedCommand } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { projectHash, resolveProjectRoot } from './project.js'
import { redactSecrets } from './secret_redact.js'
import { sessionSidecarPath } from './session_store.js'
import { errorPrefix } from './tool_error_class.js'
import { carriesCredential, fixIsAllowed, RERUN_PLACEHOLDER, rerunIsAllowed } from './recovery_fix_policy.js'
import { atomicWriteText, ensureDirSync } from './util.js'

/** Later Bash calls a pending pair stays open for before it is dropped. */
export const RECOVERY_WINDOW = 6

/** Pending pairs tracked per session; a session juggling more failures than this is not one where the oldest still matters. */
const MAX_OPEN = 4

/** Pairs kept per project; the oldest by `lastSeen` is evicted past this. */
export const MAX_PAIRS = 50

/** A pair untouched this long is dropped. */
export const PAIR_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** Longest fix, in characters. A fix over this is not learned: cutting a command short would store a different command. */
export const MAX_FIX_CHARS = 200

/** Longest command considered at all. */
const MAX_COMMAND_CHARS = 400

/** Commands the fix is built from, at most. */
const MAX_FIX_COMMANDS = 2

const PENDING_SUFFIX = '.recovery-pending'

/** Version 4 keys the digests with a per-install secret ({@link digestKey}); a version 3 file holds bare SHA-256 digests that match nothing the keyed digests produce and can be guessed offline, and a version 2 or older file holds command lines or error text in the clear, so both are dropped unread. */
const STORE_VERSION = 4
const PENDING_VERSION = 4

/** Stands in for a command run between a failure and its success that is not an allowlisted fix: the text is never kept, and a fix that would include it is not learned. */
export const OTHER_STEP = '<other>'

/** Distinct sessions that must have learned a pair before it speaks; one session's coincidence is not history. */
const MIN_SESSIONS = 2

/** Session tags kept per pair; only the count up to MIN_SESSIONS matters, the rest bounds the file. */
const MAX_SESSIONS = 8

export interface StoredPair {
  /** The digest ({@link digestOf}) of the error cluster ({@link errorPrefix} of the redacted error text): an error can echo an argument back unquoted, so its text is never kept. */
  signature: string
  /** The digest ({@link digestOf}) of the failed command's core, wrappers and prefix removed, qualified by its directory. Never the command text. */
  commandShape: string
  fix: string
  count: number
  lastSeen: number
  helped: number
  hurt: number
  /** Short hashes of the distinct sessions that learned or were helped by this pair. */
  sessions: string[]
}

/** The failed command as three digests, so a success can be compared with it without the command text being kept. */
interface FailedDigest {
  /** The command core, wrappers and prefix removed; what a success is matched on. */
  core: string
  /** Everything through the last top-level `&&` or `;`. */
  prefix: string
  /** The command after that separator, wrappers included. */
  run: string
}

interface OpenPair {
  key: string
  /** The digest of the command core qualified by its project-relative directory; what a pair is keyed on. */
  shape: string
  /** The failed command's prefix and run digests; with `key` they say whether a success is the same command behind a different prefix. */
  failedPrefix: string
  failedRun: string
  signature: string
  calls: number
  /** The commands run since the failure: an allowlisted fix as text, anything else as {@link OTHER_STEP}. */
  between: string[]
  offered?: { fix: string }
  /** How many leading parts of the offered fix have run, whole and in order. */
  progress?: number
  fixRan?: boolean
}

interface PendingState {
  open: OpenPair[]
  shown: string[]
  /** The working directory the cached project key was resolved for; resolving it spawns git, so one hook process per Bash call would pay for it every time. */
  cwd?: string
  projectKey?: string | null
  root?: string | null
}

// Reading the code, not running it: a command like these changes nothing, so running one between a failure and its success is not a fix.
const DIAGNOSTIC_WORDS: ReadonlySet<string> = new Set(['ls', 'dir', 'cat', 'pwd', 'which', 'where', 'echo', 'head', 'tail', 'grep', 'rg', 'find', 'type', 'wc', 'stat', 'file', 'cd', 'test', 'true', 'date', 'whoami', 'env', 'printenv'])
const DIAGNOSTIC_GIT = /^git\s+(?:status|log|diff|show|branch|remote|rev-parse)\b/
const VERSION_PROBE = /\s(?:--version|-v|-V|version)\s*$/
const DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bgit\s+push\b[^|;&]*(?:--force|\s-f\b)|\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bRemove-Item\b[^|;&]*-Recurse|\bdel\s+\/[sq]|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=/i
// eslint-disable-next-line no-control-regex
const UNFENCEABLE = /[`\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const WRAPPER = /^(?:env\s+(?:-\S+\s+)*|npx\s+(?:(?:-y|--yes|--no-install)\s+)*|bunx\s+|uv\s+run\s+(?:--\S+\s+)*|poetry\s+run\s+|pipenv\s+run\s+|pnpm\s+exec\s+|sudo\s+(?:-\S+\s+)*)/

function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whether a command may be stored, replayed or learned from: one line short enough to be a command, nothing that breaks a backtick fence, nothing destructive, nothing that names token-goat, no credential. */
export function isLearnableCommand(command: string): boolean {
  const text = command.trim()
  if (text === '' || text.length > MAX_COMMAND_CHARS) return false
  if (UNFENCEABLE.test(text)) return false
  if (/token-goat/i.test(text) || DESTRUCTIVE.test(text)) return false
  return !carriesCredential(text)
}

/** Split `command` at its last top-level `&&` or `;` into the prefix (everything through that separator, normalized) and the core it runs, then peel wrappers (`env`, `npx`, `uv run`, leading `VAR=value`) off the core. The wrappers are discarded from the core, so `npx vitest` and `vitest` share a key; the prefix keeps the wrappers' absence/presence visible to the caller through {@link learnableFix}, which compares whole commands. A `||` or a separator inside quotes is not a boundary. */
export function splitCommandPrefix(command: string): { prefix: string; run: string; core: string } {
  const text = squeeze(command)
  let quote: string | null = null
  let cut = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === ';') cut = i + 1
    else if (ch === '&' && text[i + 1] === '&' && text[i - 1] !== '&') {
      cut = i + 2
      i += 1
    }
  }
  const prefix = text.slice(0, cut).trim()
  const run = text.slice(cut).trim()
  let core = run
  for (let peel = 0; peel < 4; peel++) {
    const stripped = squeeze(stripLeadingAssignments(core))
    const next = stripped.replace(WRAPPER, '')
    if (next === core) break
    core = next
  }
  return { prefix, run, core }
}

function isDiagnostic(command: string): boolean {
  const { core } = splitCommandPrefix(command)
  if (DIAGNOSTIC_GIT.test(core) || VERSION_PROBE.test(` ${core}`)) return true
  const word = core.split(' ')[0] ?? ''
  return DIAGNOSTIC_WORDS.has(word) && !/[>|]/.test(core)
}

/** The fix to remember for failed command `failed` that succeeded as `success`, with `between` the successful Bash commands run in between, or null when nothing should be learned. Pure. A prefix delta (success = C behind a prefix or wrapper that the failure lacked) is the fix itself; otherwise it is the last {@link MAX_FIX_COMMANDS} non-diagnostic commands from between, and a rerun with nothing between is a flaky command. */
export function learnableFix(failed: string, success: string, between: readonly string[]): string | null {
  if (![failed, ...between].every(isLearnableCommand)) return null
  const steps = between.flatMap((command) => {
    const step = betweenStep(command)
    return step === null ? [] : [step]
  })
  return learnFromDigest(digestFailed(failed), success, steps)
}

/** Where this install's digest key lives, beside the stores it protects so that removing the data directory removes both. */
function digestKeyPath(): string {
  return join(dataDir(), 'recovery_pairs', 'install.key')
}

const DIGEST_KEY_HEX = /^[0-9a-f]{64}$/

let digestKeyCache: { path: string; key: string } | undefined

/** The random key every digest is keyed with, created on first use and read once per process. Without it a digest is a bare SHA-256, and a leaked store lets anyone test guesses at a low-entropy command against it. The file is created exclusively and owner-only where the platform honours a mode, and its value is never logged or returned to a caller outside this module. When it can neither be read nor created the key is random for this process alone, so nothing learned in this process matches a later one: no pair is learned, which is the safe way to fail. */
function digestKey(): string {
  const path = digestKeyPath()
  if (digestKeyCache?.path === path) return digestKeyCache.key
  let key = ''
  try {
    key = readFileSync(path, 'utf8').trim()
  } catch {
    // Absent or unreadable: try to create it below.
  }
  if (!DIGEST_KEY_HEX.test(key)) {
    const fresh = randomBytes(32).toString('hex')
    try {
      ensureDirSync(dirname(path))
      writeFileSync(path, fresh, { flag: 'wx', mode: 0o600 })
      key = fresh
    } catch {
      // Lost a race to another hook process, or the directory is not writable: use whichever key is on disk now, else this process's own.
      try {
        key = readFileSync(path, 'utf8').trim()
      } catch {
        key = ''
      }
      if (!DIGEST_KEY_HEX.test(key)) key = fresh
    }
  }
  digestKeyCache = { path, key }
  return key
}

/** The HMAC-SHA-256 of `text` under {@link digestKey}, as hex: how a command is compared and keyed without being kept. */
function digestOf(text: string): string {
  return createHmac('sha256', digestKey()).update(text).digest('hex')
}

function digestFailed(command: string): FailedDigest {
  const { prefix, run, core } = splitCommandPrefix(command)
  return { core: digestOf(core), prefix: digestOf(prefix), run: digestOf(run) }
}

/** What to remember of a successful command run between a failure and its success: null for a read-only command, which is never part of a fix; the squeezed text when it is an allowlisted fix; else {@link OTHER_STEP}, so that no other command line reaches the disk. */
function betweenStep(command: string): string | null {
  if (isDiagnostic(command)) return null
  const text = squeeze(command)
  return text.length <= MAX_FIX_CHARS && !carriesCredential(text) && fixIsAllowed(text, WRAPPER) ? text : OTHER_STEP
}

/** The success that is the failed command behind a prefix or wrapper, as the text to keep: the prefix and the wrapper words, with the command itself replaced by {@link RERUN_PLACEHOLDER}, because its arguments are free text that no allowlist can vouch for. Null when the command is not one that may be rerun by name, or when there is nothing but the placeholder to say. */
function rerunPart(success: { prefix: string; run: string; core: string }): string | null {
  if (!rerunIsAllowed(success.core) || !success.run.endsWith(success.core)) return null
  const lead = success.run.slice(0, success.run.length - success.core.length)
  if (success.prefix === '' && lead === '') return null
  return squeeze(`${success.prefix} ${lead}${RERUN_PLACEHOLDER}`)
}

/** {@link learnableFix} over a failed command kept as digests and between steps as {@link betweenStep} left them. */
function learnFromDigest(failed: FailedDigest, success: string, steps: readonly string[]): string | null {
  const s = splitCommandPrefix(success)
  if (s.core === '' || digestOf(s.core) !== failed.core || !isLearnableCommand(success)) return null
  const wrapperDelta = digestOf(s.prefix) !== failed.prefix || digestOf(s.run) !== failed.run
  const parts = steps.slice(-MAX_FIX_COMMANDS)
  if (wrapperDelta) {
    const rerun = rerunPart(s)
    if (rerun === null) return null
    parts.push(rerun)
  }
  if (parts.length === 0) return null
  const fix = parts.join(' && ')
  return isReplayable(fix) ? fix : null
}

function storePath(key: string): string {
  return join(dataDir(), 'recovery_pairs', `${key}.json`)
}

/** The path of the project's pair file; exported for tests. */
export function recoveryStorePath(key: string): string {
  return storePath(key)
}

function dropStore(key: string): void {
  try {
    rmSync(storePath(key), { force: true })
  } catch {
    // Best-effort: a stale empty file is harmless, it only costs a read.
  }
}

function loadStore(key: string, now: number): StoredPair[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(key), 'utf8'))
    if ((parsed as { version?: unknown }).version !== STORE_VERSION) {
      dropStore(key)
      return []
    }
    const pairs = (parsed as { pairs?: unknown }).pairs
    if (!Array.isArray(pairs)) return []
    const kept = pairs
      .filter((p): p is StoredPair => {
        const o = p as Partial<StoredPair> | null
        return o !== null && typeof o === 'object' && typeof o.signature === 'string' && typeof o.commandShape === 'string' && typeof o.fix === 'string' && typeof o.count === 'number' && typeof o.lastSeen === 'number' && typeof o.helped === 'number' && typeof o.hurt === 'number' && now - o.lastSeen <= PAIR_TTL_MS
      })
      .map((p) => ({ ...p, sessions: Array.isArray(p.sessions) ? p.sessions.filter((s): s is string => typeof s === 'string') : [] }))
    if (kept.length === 0) dropStore(key)
    return kept
  } catch {
    return []
  }
}

// Read-modify-write without a lock: two hooks racing on one project can lose one update, which costs a pair one count and nothing else.
function saveStore(key: string, pairs: StoredPair[]): void {
  try {
    const kept = [...pairs].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_PAIRS)
    if (kept.length === 0) {
      dropStore(key)
      return
    }
    const target = storePath(key)
    ensureDirSync(dirname(target))
    atomicWriteText(target, JSON.stringify({ version: STORE_VERSION, pairs: kept }))
  } catch {
    // Best-effort: a pair that can not be stored is a pair the next session does not hear about.
  }
}

/** A pair the model has been misled by: two hurts and more hurts than helps. Kept as a tombstone so the same fix is not re-learned into a loop. */
export function isRetired(pair: StoredPair): boolean {
  return pair.hurt >= 2 && pair.hurt > pair.helped
}

function matches(pair: StoredPair, signature: string, shape: string): boolean {
  return pair.signature === signature && pair.commandShape === shape
}

/** Whether a stored fix may still be shown: the allowlist is checked again on replay, so a file written by an older policy, or edited by hand, can not put a command into the model's context. */
function isReplayable(fix: string): boolean {
  return fix.length <= MAX_FIX_CHARS && !carriesCredential(fix) && fixIsAllowed(fix, WRAPPER)
}

/** The same pair an offer came from: its fix, the shape it was learned for and the failure it was learned from, so a different failure of the same command never scores it. */
function isOffered(pair: StoredPair, offered: { fix: string }, signature: string, shape: string): boolean {
  return pair.fix === offered.fix && matches(pair, signature, shape)
}

/** A short stable tag for a session, so a pair can count the distinct sessions that learned it without storing session ids. */
function sessionTag(event: HookEvent): string {
  return createHash('sha256').update(sessionStateKey(event)).digest('hex').slice(0, 12)
}

function addSession(pair: StoredPair, tag: string): void {
  if (!pair.sessions.includes(tag)) pair.sessions = [...pair.sessions, tag].slice(-MAX_SESSIONS)
}

/** The key a project's pair file is stored under: the hash of its canonical root, resolved from the event's working directory. Null when the root can not be resolved. */
export function recoveryProjectKey(cwd: string | undefined): string | null {
  try {
    return projectHash(resolveProjectRoot(cwd === undefined ? undefined : { project: cwd }))
  } catch {
    return null
  }
}

/** The pairs stored for the project at `cwd`, retired ones included. */
export function loadRecoveryPairs(cwd: string | undefined): StoredPair[] {
  const key = recoveryProjectKey(cwd)
  return key === null ? [] : loadStore(key, Date.now())
}

function pendingPath(event: HookEvent): string | null {
  return event.sessionId ? sessionSidecarPath(sessionStateKey(event), PENDING_SUFFIX) : null
}

function isOpenPair(value: unknown): value is OpenPair {
  const o = value as Partial<OpenPair> | null
  return o !== null && typeof o === 'object' && typeof o.key === 'string' && typeof o.shape === 'string' && typeof o.failedPrefix === 'string' && typeof o.failedRun === 'string' && typeof o.signature === 'string' && typeof o.calls === 'number' && Array.isArray(o.between) && o.between.every((step) => typeof step === 'string')
}

function readPending(target: string): PendingState {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<PendingState> & { version?: unknown }
    if (parsed.version !== PENDING_VERSION) {
      // A file from before digests held command lines in the clear: replace it with an empty state now rather than whenever the next write happens.
      const fresh: PendingState = { open: [], shown: [] }
      writePending(target, fresh)
      return fresh
    }
    const state: PendingState = { open: Array.isArray(parsed.open) ? parsed.open.filter(isOpenPair) : [], shown: Array.isArray(parsed.shown) ? parsed.shown : [] }
    if (parsed.projectKey !== undefined) state.projectKey = typeof parsed.projectKey === 'string' ? parsed.projectKey : null
    if (parsed.root !== undefined) state.root = typeof parsed.root === 'string' ? parsed.root : null
    if (typeof parsed.cwd === 'string') state.cwd = parsed.cwd
    return state
  } catch {
    return { open: [], shown: [] }
  }
}

function projectFor(state: PendingState, event: HookEvent): { key: string | null; root: string | null } {
  const cwd = getCwd(event)
  if (state.projectKey !== undefined && state.root !== undefined && state.cwd === cwd) return { key: state.projectKey, root: state.root }
  let root: string | null = null
  let key: string | null = null
  try {
    root = resolveProjectRoot(cwd === undefined ? undefined : { project: cwd })
    key = projectHash(root)
  } catch {
    // An unresolvable root leaves both null: no pair is stored or offered for this call.
  }
  state.projectKey = key
  state.root = root
  if (cwd === undefined) delete state.cwd
  else state.cwd = cwd
  return { key, root }
}

function writePending(target: string, state: PendingState): void {
  try {
    ensureDirSync(dirname(target))
    atomicWriteText(target, JSON.stringify({ ...state, version: PENDING_VERSION }))
  } catch {
    // Best-effort, same contract as the failure ledger: an unwritten pending pair is a pair never learned.
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

const LEADING_CD = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/

/** The directory a command runs in, relative to the project root: the event's working directory, moved by a leading `cd`. Two services of one monorepo have different scopes, so `cd svc1 && pytest` and `cd svc2 && pytest` never share a pair. Empty at the root. */
function scopeOf(root: string | null, cwd: string | undefined, command: string): string {
  if (root === null || cwd === undefined) return ''
  let dir = toPosix(relative(root, cwd)) || '.'
  const cd = LEADING_CD.exec(squeeze(command))
  if (cd !== null) {
    const target = (cd[1] ?? '').replace(/^["']|["']$/g, '')
    dir = isAbsolute(target) ? toPosix(relative(root, target)) || '.' : posix.join(dir, target)
  }
  const scope = posix.normalize(dir)
  return scope === '.' ? '' : scope.replace(/\/$/, '')
}

function shapeOf(scope: string, core: string): string {
  return scope === '' ? core : `${scope}::${core}`
}

/** Lines that name no failure: an npm script banner (`> pkg@1.0.0 test`), a rule or title banner, a line with no letter or digit. */
function isGenericHeader(line: string): boolean {
  return /^>\s/.test(line) || /^[=\-*#~_\s]*$/.test(line) || (/^[=\-*#~_]{2}/.test(line) && /[=\-*#~_]{2}$/.test(line)) || !/[A-Za-z0-9]/.test(line)
}

const ERROR_LINE = /error|fail|cannot|not found|exception|denied|no such|traceback/i

/** The cluster key of an error: its first line that reads as an error, or the first three informative lines when none does, never a generic banner. Null when the text has no informative line. */
function signatureOf(errorText: string): string | null {
  const lines = redactSecrets(errorText)
    .text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^Exit code \d+$/.test(line))
  const exit = /^Exit code (\d+)/.exec(redactSecrets(errorText).text.trim())
  const informative = lines.filter((line) => !isGenericHeader(line))
  if (informative.length === 0) return null
  const chosen = informative.find((line) => ERROR_LINE.test(line))
  const picked = chosen === undefined ? informative.slice(0, 3) : [chosen]
  const text = `${exit === null ? '' : `exit ${exit[1] ?? ''}: `}${picked.map((line) => errorPrefix(line)).join(' | ')}`
  const signature = text.slice(0, MAX_FIX_CHARS)
  return carriesCredential(signature) ? null : digestOf(signature)
}

/** Record a failed Bash command and return the one-line recurrence hint when two earlier sessions learned a fix for this exact failure in this directory. `reason` is already known not to be one the failure hook withholds advice for. */
export function recoveryAfterFailure(event: HookEvent, failure: { command: string; errorText: string }): string | null {
  try {
    const target = pendingPath(event)
    if (target === null || !isLearnableCommand(failure.command)) return null
    const { core } = splitCommandPrefix(failure.command)
    if (core === '') return null
    const signature = signatureOf(failure.errorText)
    if (signature === null) return null
    const state = readPending(target)
    const { key, root } = projectFor(state, event)
    const failed = digestFailed(failure.command)
    const shape = digestOf(shapeOf(scopeOf(root, getCwd(event), failure.command), core))
    const now = Date.now()
    const pairs = key === null ? [] : loadStore(key, now)
    const prior = state.open.find((o) => o.key === failed.core)
    if (prior?.offered !== undefined && prior.fixRan === true) {
      const pair = pairs.find((p) => prior.offered !== undefined && isOffered(p, prior.offered, prior.signature, prior.shape))
      if (pair !== undefined && key !== null) {
        pair.hurt += 1
        saveStore(key, pairs)
      }
    }
    const candidates = pairs.filter((p) => matches(p, signature, shape) && !isRetired(p) && p.sessions.length >= MIN_SESSIONS && isReplayable(p.fix)).sort((a, b) => b.helped - b.hurt - (a.helped - a.hurt) || b.count - a.count || b.lastSeen - a.lastSeen)
    const best = candidates[0]
    const open: OpenPair = { key: failed.core, shape, failedPrefix: failed.prefix, failedRun: failed.run, signature, calls: 0, between: [], ...(best === undefined ? {} : { offered: { fix: best.fix } }) }
    state.open = [...state.open.filter((o) => o.key !== failed.core), open].slice(-MAX_OPEN)
    const id = `${signature}\n${shape}`
    const speak = best !== undefined && !state.shown.includes(id)
    if (speak) state.shown = [...state.shown, id].slice(-64)
    writePending(target, state)
    if (!speak || best === undefined) return null
    const text = `&#91;token-goat] In an earlier session this same failure was followed by: ${fencedCommand(displaySafeText(best.fix))} (seen ${best.count} ${best.count === 1 ? 'time' : 'times'}, not verified)`
    const out = applyHintTracking(event, contextOutput(text), uncorrelatedHint('recovery_pair'))
    return out.hookType === 'context' ? out.context : null
  } catch {
    return null
  }
}

/** Advance the offered fix's progress with one successful command: each part of the fix must run as a whole command, in order, and a single call that is the whole fix counts for all of it. */
function advanceOfferedFix(open: OpenPair, command: string): void {
  const offered = open.offered
  if (offered === undefined || open.fixRan === true) return
  const ran = squeeze(command)
  const parts = offered.fix.split(' && ')
  if (ran === offered.fix) {
    open.fixRan = true
    return
  }
  const next = open.progress ?? 0
  if (ran !== parts[next]) return
  open.progress = next + 1
  if (open.progress === parts.length) open.fixRan = true
}

/** A successful Bash command: it may close a pending pair (learning a fix or scoring an offered one), or be the in-between work for one. */
export function recoveryAfterSuccess(event: HookEvent, command: string): void {
  try {
    const target = pendingPath(event)
    if (target === null) return
    const state = readPending(target)
    if (state.open.length === 0) return
    const clean = isLearnableCommand(command)
    const now = Date.now()
    const { key } = projectFor(state, event)
    const tag = sessionTag(event)
    const keep: OpenPair[] = []
    const coreDigest = digestOf(splitCommandPrefix(command).core)
    const step = clean ? betweenStep(command) : null
    let store: StoredPair[] | null = null
    let changed = false
    for (const open of state.open) {
      open.calls += 1
      if (open.calls > RECOVERY_WINDOW) continue
      if (!clean) continue
      if (coreDigest === open.key) {
        store ??= key === null ? [] : loadStore(key, now)
        const offered = open.offered
        if (offered !== undefined && open.fixRan === true) {
          const pair = store.find((p) => isOffered(p, offered, open.signature, open.shape))
          if (pair !== undefined) {
            pair.helped += 1
            pair.count += 1
            pair.lastSeen = now
            addSession(pair, tag)
            changed = true
          }
          continue
        }
        const fix = learnFromDigest({ core: open.key, prefix: open.failedPrefix, run: open.failedRun }, command, open.between)
        if (fix !== null) {
          const sameShape = store.filter((p) => matches(p, open.signature, open.shape))
          const same = sameShape.find((p) => p.fix === fix)
          if (same !== undefined) {
            same.count += 1
            same.lastSeen = now
            addSession(same, tag)
            changed = true
          } else if (!sameShape.some((p) => p.helped > 0)) {
            store = [...store.filter((p) => !matches(p, open.signature, open.shape)), { signature: open.signature, commandShape: open.shape, fix, count: 1, lastSeen: now, helped: 0, hurt: 0, sessions: [tag] }]
            changed = true
          }
        }
        continue
      }
      advanceOfferedFix(open, command)
      if (step !== null) open.between = [...open.between, step].slice(-RECOVERY_WINDOW)
      keep.push(open)
    }
    if (changed && store !== null && key !== null) saveStore(key, store)
    state.open = keep
    writePending(target, state)
  } catch {
    // Learning is best-effort: a hook that cannot record a pair must still return normally.
  }
}

/** An edit tool ran: whatever succeeds next may succeed because of the edit, so every pending pair is dropped. */
export function recoveryAfterEdit(event: HookEvent): void {
  try {
    const target = pendingPath(event)
    if (target === null) return
    const state = readPending(target)
    if (state.open.length === 0) return
    state.open = []
    writePending(target, state)
  } catch {
    // Same best-effort contract as above.
  }
}
