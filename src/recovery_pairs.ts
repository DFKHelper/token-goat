/** Failure-recovery pairs: remember what fixed a failed Bash command, and say so the next time it fails the same way. A failed command C opens a pending pair; when C (or C behind a prefix such as an env activation, `npx`, `uv run` or `env VAR=`) then exits 0 within {@link RECOVERY_WINDOW} later Bash calls with no edit between, the fix is what the model ran in between, or the prefix S added to C. A rerun with nothing between is a flaky command, and an edit between means the edit was the fix (the code changed, not the environment), so both learn nothing. Pairs live per project in a sidecar JSON under the token-goat data dir, keyed by the project hash, with no database migration; a later session whose Bash fails the same way (same normalized command, same error cluster) gets one line naming the fix, and the pair is scored on what follows: the fix ran and C then passed is a help, C failing again after the fix is a hurt, and two hurts with more hurts than helps retire it. Nothing is learned from a command that is destructive, names token-goat, can not sit inside one backtick fence, or carries a credential: the stored fix is replayed into the model's context, so it has to be safe to run on sight. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stripLeadingAssignments } from './bash_extractors.js'
import { dataDir } from './constants.js'
import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { applyHintTracking, uncorrelatedHint } from './hint_stats.js'
import { contextOutput, getCwd } from './hooks_common.js'
import { fencedCommand } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { projectHash, resolveProjectRoot } from './project.js'
import { hasPreciseSecret, redactSecrets } from './secret_redact.js'
import { sessionSidecarPath } from './session_store.js'
import { errorPrefix } from './tool_error_class.js'
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
const STORE_VERSION = 1

export interface StoredPair {
  /** The error cluster ({@link errorPrefix} of the redacted error text). */
  signature: string
  /** The normalized command that failed, wrappers and prefix removed. */
  commandShape: string
  fix: string
  count: number
  lastSeen: number
  helped: number
  hurt: number
}

interface OpenPair {
  key: string
  /** The failed command as run, squeezed, so a rerun can be compared with it whole. */
  failed: string
  signature: string
  calls: number
  between: string[]
  offered?: { fix: string }
  fixRan?: boolean
}

interface PendingState {
  open: OpenPair[]
  shown: string[]
  /** The working directory the cached project key was resolved for; resolving it spawns git, so one hook process per Bash call would pay for it every time. */
  cwd?: string
  projectKey?: string | null
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
  return !hasPreciseSecret(text)
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
  const f = splitCommandPrefix(failed)
  const s = splitCommandPrefix(success)
  if (f.core === '' || f.core !== s.core) return null
  if (![failed, success, ...between].every(isLearnableCommand)) return null
  const worked = between.map(squeeze).filter((c) => !isDiagnostic(c))
  const wrapperDelta = s.prefix !== f.prefix || s.run !== f.run
  const parts = worked.slice(-MAX_FIX_COMMANDS)
  if (wrapperDelta) parts.push(squeeze(success))
  if (parts.length === 0) return null
  const fix = parts.join(' && ')
  const safe = redactSecrets(fix).text
  return safe === fix && fix.length <= MAX_FIX_CHARS ? fix : null
}

function storePath(key: string): string {
  return join(dataDir(), 'recovery_pairs', `${key}.json`)
}

/** The path of the project's pair file; exported for tests. */
export function recoveryStorePath(key: string): string {
  return storePath(key)
}

function loadStore(key: string, now: number): StoredPair[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(key), 'utf8'))
    const pairs = (parsed as { pairs?: unknown }).pairs
    if (!Array.isArray(pairs)) return []
    return pairs.filter((p): p is StoredPair => {
      const o = p as Partial<StoredPair> | null
      return o !== null && typeof o === 'object' && typeof o.signature === 'string' && typeof o.commandShape === 'string' && typeof o.fix === 'string' && typeof o.count === 'number' && typeof o.lastSeen === 'number' && typeof o.helped === 'number' && typeof o.hurt === 'number' && now - o.lastSeen <= PAIR_TTL_MS
    })
  } catch {
    return []
  }
}

function saveStore(key: string, pairs: StoredPair[]): void {
  try {
    const kept = [...pairs].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_PAIRS)
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

function readPending(target: string): PendingState {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<PendingState>
    const state: PendingState = { open: Array.isArray(parsed.open) ? parsed.open : [], shown: Array.isArray(parsed.shown) ? parsed.shown : [] }
    if (parsed.projectKey !== undefined) state.projectKey = typeof parsed.projectKey === 'string' ? parsed.projectKey : null
    if (typeof parsed.cwd === 'string') state.cwd = parsed.cwd
    return state
  } catch {
    return { open: [], shown: [] }
  }
}

function keyFor(state: PendingState, event: HookEvent): string | null {
  const cwd = getCwd(event)
  if (state.projectKey !== undefined && state.cwd === cwd) return state.projectKey
  const key = recoveryProjectKey(cwd)
  state.projectKey = key
  if (cwd === undefined) delete state.cwd
  else state.cwd = cwd
  return key
}

function writePending(target: string, state: PendingState): void {
  try {
    ensureDirSync(dirname(target))
    atomicWriteText(target, JSON.stringify(state))
  } catch {
    // Best-effort, same contract as the failure ledger: an unwritten pending pair is a pair never learned.
  }
}

function signatureOf(errorText: string): string {
  return errorPrefix(redactSecrets(errorText).text).slice(0, MAX_FIX_CHARS)
}

/** Record a failed Bash command and return the one-line recurrence hint when an earlier session learned a fix for this exact failure. `reason` is already known not to be one the failure hook withholds advice for. */
export function recoveryAfterFailure(event: HookEvent, failure: { command: string; errorText: string }): string | null {
  try {
    const target = pendingPath(event)
    if (target === null || !isLearnableCommand(failure.command)) return null
    const { core } = splitCommandPrefix(failure.command)
    if (core === '') return null
    const signature = signatureOf(failure.errorText)
    const state = readPending(target)
    const key = keyFor(state, event)
    const now = Date.now()
    const pairs = key === null ? [] : loadStore(key, now)
    const prior = state.open.find((o) => o.key === core)
    if (prior?.offered !== undefined && prior.fixRan === true) {
      const pair = pairs.find((p) => p.fix === prior.offered?.fix && p.commandShape === core)
      if (pair !== undefined && key !== null) {
        pair.hurt += 1
        saveStore(key, pairs)
      }
    }
    const candidates = pairs.filter((p) => matches(p, signature, core) && !isRetired(p)).sort((a, b) => b.helped - b.hurt - (a.helped - a.hurt) || b.count - a.count || b.lastSeen - a.lastSeen)
    const best = candidates[0]
    const open: OpenPair = { key: core, failed: squeeze(failure.command), signature, calls: 0, between: [], ...(best === undefined ? {} : { offered: { fix: best.fix } }) }
    state.open = [...state.open.filter((o) => o.key !== core), open].slice(-MAX_OPEN)
    const id = `${signature}\n${core}`
    const speak = best !== undefined && !state.shown.includes(id)
    if (speak) state.shown = [...state.shown, id].slice(-64)
    writePending(target, state)
    if (!speak || best === undefined) return null
    const text = `[token-goat] This failed before; it was fixed by running: ${fencedCommand(displaySafeText(best.fix))} (seen ${best.count} ${best.count === 1 ? 'time' : 'times'})`
    const out = applyHintTracking(event, contextOutput(text), uncorrelatedHint('recovery_pair'))
    return out.hookType === 'context' ? out.context : null
  } catch {
    return null
  }
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
    const key = keyFor(state, event)
    const keep: OpenPair[] = []
    const { core } = splitCommandPrefix(command)
    let store: StoredPair[] | null = null
    let changed = false
    for (const open of state.open) {
      open.calls += 1
      if (open.calls > RECOVERY_WINDOW) continue
      if (!clean) continue
      if (core === open.key) {
        store ??= key === null ? [] : loadStore(key, now)
        const offered = open.offered
        if (offered !== undefined && open.fixRan === true) {
          const pair = store.find((p) => p.fix === offered.fix && p.commandShape === open.key)
          if (pair !== undefined) {
            pair.helped += 1
            pair.count += 1
            pair.lastSeen = now
            changed = true
          }
          continue
        }
        const fix = learnableFix(open.failed, command, open.between)
        if (fix !== null) {
          const same = store.find((p) => matches(p, open.signature, open.key) && p.fix === fix)
          if (same !== undefined) same.count += 1
          else store = [...store.filter((p) => !matches(p, open.signature, open.key)), { signature: open.signature, commandShape: open.key, fix, count: 1, lastSeen: now, helped: 0, hurt: 0 }]
          if (same !== undefined) same.lastSeen = now
          changed = true
        }
        continue
      }
      if (open.offered !== undefined && squeeze(command).includes(open.offered.fix)) open.fixRan = true
      open.between = [...open.between, squeeze(command)].slice(-RECOVERY_WINDOW)
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
