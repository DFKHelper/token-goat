/**
 * session_start hook: re-inject a short command-routing reminder every time a
 * session starts, resumes, or restarts after compaction.
 *
 * install.ts's `buildClaudeMdBlock()` writes a one-time static routing block into
 * ~/.claude/CLAUDE.md at install time, and `token-goat install` also drops a
 * SKILL.md -- but neither is reinforced again during a session. Over a long
 * session that one-time prose competes against a strong base-training prior
 * toward the Read/Grep tools with zero reinforcement, and the reactive PreToolUse hints
 * (hooks_read.ts etc.) only fire after the model has already reached for the
 * wrong tool. This hook re-surfaces the highest-leverage commands at every
 * SessionStart source Claude Code fires (startup, resume, clear, compact).
 *
 * Kept deliberately short (a handful of commands, not the full CLAUDE.md
 * block) since it costs tokens on every session start. Project-aware when
 * cheap: if the cwd resolves to an indexed project, names a concrete symbol
 * count instead of generic boilerplate. Gated on `hints.session_start_reminder`
 * (default true). Fails soft -- any error inside the handler returns `pass`,
 * never blocks session start.
 */

import { registerHook } from './hook_registry.js'
import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, contextOutput, getCwd } from './hooks_common.js'
import { loadConfig } from './config.js'
import { countSymbols } from './index_reader.js'
import { globalDbPath } from './constants.js'
import { checkSymbolBodySize } from './symbol_body_probe.js'
import { buildDeltaCapsule } from './evidence_cache.js'
import { ENV_KEYS } from './constants.js'
import { envBool, envInt } from './env.js'
import { DEFAULT_RECONCILE_BUDGET_MS, isReconcileClean, reconcileProject } from './reconcile.js'
import { countNoun } from './util.js'

/** Generic reminder used when the cwd is missing, unresolvable, or not indexed. */
const GENERIC_REMINDER =
  'token-goat: prefer surgical reads over the Read/Grep tools on this codebase; shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls` are just commands, not tool names -- `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::Heading"`, `token-goat semantic "description"`, `token-goat outline <file>`. Run `token-goat index .` if this project is not indexed yet.'

/**
 * Reminder used when the cwd resolves to an indexed project.
 *
 * Deliberately omits the exact symbol count: this string lands in the earliest, most
 * cacheable position of a SessionStart request (the part a provider's prompt/prefix cache
 * matches on), and `countSymbols()` drifts on every reindex -- a live number here would
 * invalidate that cache prefix every session, and every time the index changes mid-session.
 * "Is indexed" is the only signal an agent acts on; the count was decoration in the worst
 * possible position. Byte-identical across reindexes by construction: nothing in this
 * string depends on index state beyond the ok/not-ok branch already selected by the caller.
 */
const INDEXED_REMINDER =
  'token-goat: this project is indexed. Prefer `symbol <name>`, `read "file::symbol"`, ' +
  '`section "file::Heading"`, `semantic "description"`, or `outline <file>` over a full ' +
  'Read/Grep tool call; for JSON/YAML use `json-query file \'a.b.c\'` or `yaml-query` (nested keys are not symbols); ' +
  'shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls` are still just commands.'

/**
 * True when `cwd` resolves to a project with symbols in the index.
 *
 * Both the reminder text and the drift sweep branch on this, and it is computed once and passed
 * to both rather than derived twice: two `countSymbols` calls would double a DB round trip on the
 * session-start path, and a second call could disagree with the first if the worker committed a
 * reindex between them.
 */
function isIndexedProject(cwd: string | undefined): boolean {
  if (cwd === undefined) return false
  try {
    return countSymbols({ rootDir: cwd }, globalDbPath()) > 0
  } catch {
    return false
  }
}

/** Build the reminder string for `cwd`: distinguishes an indexed project from the generic fallback. */
function buildReminder(indexed: boolean): string {
  return indexed ? INDEXED_REMINDER : GENERIC_REMINDER
}

/**
 * Sweep the project for index drift and enqueue whatever no longer matches disk.
 *
 * Returns a one-line note when drift was found, or null when the index is already correct --
 * which is the overwhelmingly common case, and stays silent so the session-start context does not
 * grow a line that says nothing. Only runs against an already-indexed project: on an unindexed one
 * every tracked file is legitimately absent from the index, so the sweep would report the entire
 * repository as drift and enqueue it, which is `token-goat index .`'s job and not a hook's.
 *
 * Never throws. Its caller is a session-start hook, and a sweep that failed is a missed repair,
 * not a reason to degrade the reminder the hook exists to deliver.
 */
function reconcileNote(cwd: string, indexed: boolean): string | null {
  if (!indexed) return null
  if (!envBool(ENV_KEYS.RECONCILE, true)) return null
  try {
    const budgetMs = envInt(ENV_KEYS.RECONCILE_BUDGET_MS, DEFAULT_RECONCILE_BUDGET_MS, 0, 60_000)
    const result = reconcileProject({ cwd, budgetMs })
    if (isReconcileClean(result)) return null
    // The breakdown is only worth its bytes when there is more than one kind of drift: with a
    // single kind it restates the total it sits beside, and this line is paid for on every session
    // start that finds anything.
    const parts: string[] = []
    if (result.changed.length > 0) parts.push(`${result.changed.length} changed`)
    if (result.added.length > 0) parts.push(`${result.added.length} new`)
    if (result.removed.length > 0) parts.push(`${result.removed.length} removed`)
    const breakdown = parts.length > 1 ? ` (${parts.join(', ')})` : ''
    // The truncation is disclosed rather than smoothed over: a budget-limited sweep found the drift
    // it had time to find, and a caller reading "3 files drifted" as "3 files drifted in total"
    // would be reading a floor as a total.
    const truncated = result.budgetExhausted
      ? ` (sweep stopped at its time budget with ${countNoun(result.unscanned, 'file')} unchecked, so there may be more)`
      : ''
    const total = result.changed.length + result.added.length + result.removed.length
    return `token-goat: reindexing ${countNoun(total, 'file')} that changed outside this session${breakdown}${truncated}. Symbol lookups may be briefly stale.`
  } catch {
    return null
  }
}

/** session_start handler: inject the reminder as context, gated on hints.session_start_reminder. */
export function sessionStartHandler(event: HookEvent): HookOutput {
  try {
    if (!loadConfig().hints.session_start_reminder) return passOutput()
    const cwd = getCwd(event)
    const indexed = isIndexedProject(cwd)
    let context = buildReminder(indexed)
    if (cwd !== undefined) {
      // Runs before the capsule so a drifted file is already queued while the rest of the hook
      // finishes: the worker picks it up on its next 2 s drain rather than on the next command.
      const drift = reconcileNote(cwd, indexed)
      if (drift !== null) context += `\n\n${drift}`
      const capsule = buildDeltaCapsule(cwd)
      if (capsule !== null) context += `\n\n${capsule}`
    }
    try {
      const dbHealth = checkSymbolBodySize(globalDbPath())
      if (dbHealth.status === 'warn') {
        context += ` token-goat: ${dbHealth.message}`
      }
    } catch {
      // dodgy DB health check must never block the base reminder
    }
    return contextOutput(context)
  } catch {
    return passOutput()
  }
}

registerHook('session_start', sessionStartHandler)
