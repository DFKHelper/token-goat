/** session_start hook: re-inject a short command-routing reminder every time a session starts, resumes, or restarts after compaction. install.ts's `buildClaudeMdBlock()` writes a one-time static routing block into ~/.claude/CLAUDE.md at install time, and `token-goat install` also drops a SKILL.md -- but neither is reinforced again during a session. Over a long session that one-time prose competes against a strong base-training prior toward the Read/Grep tools with zero reinforcement, and the reactive PreToolUse hints (hooks_read.ts etc.) only fire after the model has already reached for the wrong tool. This hook re-surfaces the highest-leverage commands at every SessionStart source Claude Code fires (startup, resume, clear, compact). On the one source that follows a compaction it also carries the resume packet -- see {@link postCompactRecovery}, which is why the handler is async. Kept deliberately short (a handful of commands, not the full CLAUDE.md block) since it costs tokens on every session start. Project-aware when cheap: if the cwd resolves to an indexed project, names a concrete symbol count instead of generic boilerplate. Gated on `hints.session_start_reminder` (default true). Fails soft -- any error inside the handler returns `pass`, never blocks session start. */

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
import { countNoun, extractErrorMessage } from './util.js'
import { recordStat } from './stats.js'
import { projectNotesFor } from './project_memory.js'

/** Generic reminder used when the cwd is missing, unresolvable, or not indexed. */
const GENERIC_REMINDER =
  'token-goat: prefer surgical reads over the Read/Grep tools on this codebase; shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls` are just commands, not tool names -- `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::Heading"`, `token-goat semantic "description"`, `token-goat outline <file>`. Run `token-goat index .` if this project is not indexed yet.'

/** Reminder used when the cwd resolves to an indexed project. Deliberately omits the exact symbol count: this string lands in the earliest, most cacheable position of a SessionStart request (the part a provider's prompt/prefix cache matches on), and `countSymbols()` drifts on every reindex -- a live number here would invalidate that cache prefix every session, and every time the index changes mid-session. "Is indexed" is the only signal an agent acts on; the count was decoration in the worst possible position. Byte-identical across reindexes by construction: nothing in this string depends on index state beyond the ok/not-ok branch already selected by the caller. */
const INDEXED_REMINDER =
  'token-goat: this project is indexed. Prefer `symbol <name>`, `read "file::symbol"`, ' +
  '`section "file::Heading"`, `semantic "description"`, or `outline <file>` over a full ' +
  'Read/Grep tool call; for JSON/YAML use `json-query file \'a.b.c\'` or `yaml-query` (nested keys are not symbols); ' +
  'shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls` are still just commands.'

/** Appended to either reminder: a finding kept only in the conversation is lost at the next compaction, and nothing else tells the model a note survives one. */
const NOTE_REMINDER = ' Record a finding that must outlive a compaction with `token-goat note set <key> "<finding>"`; notes come back at every session start.'

/** True when `cwd` resolves to a project with symbols in the index. Both the reminder text and the drift sweep branch on this, and it is computed once and passed to both rather than derived twice: two `countSymbols` calls would double a DB round trip on the session-start path, and a second call could disagree with the first if the worker committed a reindex between them. */
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
  return (indexed ? INDEXED_REMINDER : GENERIC_REMINDER) + NOTE_REMINDER
}

/** Sweep the project for index drift and enqueue whatever no longer matches disk. Returns a one-line note when drift was found, or null when the index is already correct -- which is the overwhelmingly common case, and stays silent so the session-start context does not grow a line that says nothing. Only runs against an already-indexed project: on an unindexed one every tracked file is legitimately absent from the index, so the sweep would report the entire repository as drift and enqueue it, which is `token-goat index .`'s job and not a hook's. Never throws. Its caller is a session-start hook, and a sweep that failed is a missed repair, not a reason to degrade the reminder the hook exists to deliver. */
function reconcileNote(cwd: string, indexed: boolean): string | null {
  if (!indexed) return null
  if (!envBool(ENV_KEYS.RECONCILE, true)) return null
  try {
    const budgetMs = envInt(ENV_KEYS.RECONCILE_BUDGET_MS, DEFAULT_RECONCILE_BUDGET_MS, 0, 60_000)
    const result = reconcileProject({ cwd, budgetMs })
    // isReconcileClean only looks at changed/added/removed, all three of which come back empty when the sweep never reached the files that would have populated them -- a budget-exhausted pass over a large project can find zero drift purely because it ran out of time before it got past the first few tracked files, not because the rest of the project agrees with the index. Gating the early return on isReconcileClean alone reported that as silence, the same "confident wrong answer over a partial scan" runReconcile's CLI text output already refuses to give (see its own "clean or not" comment) -- this note must refuse it too.
    if (isReconcileClean(result) && !result.budgetExhausted) return null
    // The breakdown is only worth its bytes when there is more than one kind of drift: with a single kind it restates the total it sits beside, and this line is paid for on every session start that finds anything. Files reindexed only because an upgrade changed the parser or the chunker never changed on disk, so calling them "changed outside this session" tells the model to distrust every file it has already read; they get their own clause.
    const upgraded = result.parserStale + result.embedStale
    const edited = result.changed.length - upgraded
    const parts: string[] = []
    if (edited > 0) parts.push(`${edited} changed`)
    if (result.added.length > 0) parts.push(`${result.added.length} new`)
    if (result.removed.length > 0) parts.push(`${result.removed.length} removed`)
    const breakdown = parts.length > 1 ? ` (${parts.join(', ')})` : ''
    // The truncation is disclosed rather than smoothed over: a budget-limited sweep found the drift it had time to find, and a caller reading "3 files drifted" as "3 files drifted in total" would be reading a floor as a total.
    const truncated = result.budgetExhausted
      ? ` (sweep stopped at its time budget with ${countNoun(result.unscanned, 'file')} unchecked, so there may be more)`
      : ''
    const total = result.changed.length + result.added.length + result.removed.length
    if (total === 0) {
      // budgetExhausted with nothing found yet: say the sweep was incomplete instead of nothing at all.
      return `token-goat: index drift check${truncated} found nothing in the part it had time to scan. Symbol lookups may be briefly stale.`
    }
    const drifted = total - upgraded
    const clauses: string[] = []
    if (drifted > 0) clauses.push(`${countNoun(drifted, 'file')} that changed outside this session${breakdown}`)
    if (upgraded > 0) clauses.push(`${countNoun(upgraded, 'file')} unchanged on disk but indexed by an older version of token-goat`)
    return `token-goat: reindexing ${clauses.join(' and ')}${truncated}. Symbol lookups may be briefly stale.`
  } catch (e) {
    recordStat('reconcile_note_failed', 0, 0, undefined, extractErrorMessage(e))
    return null
  }
}

/** session_start handler: inject the reminder as context, gated on hints.session_start_reminder. */
/** The resume packet, injected automatically when this SessionStart is the one that follows a compaction. `token-goat resume <session>` built exactly this and was never called by anything: a user had to know the command existed, know their session id, and think to run it at the one moment they have just lost the context that would have reminded them. Claude Code fires SessionStart with `source: "compact"` immediately after a compaction, which is that moment, so the packet is emitted there instead of waiting to be asked for. It is not a second copy of the compaction manifest. The manifest goes to the model that writes the summary and names files; this names the skills the session loaded, the last bash commands, the fetched URLs and the uncommitted diff -- state the summarizer was never given and could not have preserved. Imported dynamically so the other four SessionStart sources (startup, resume, clear, fork) keep the cold start this module's header describes: `resume.ts` pulls in the skill cache, the bash-output cache and a `git diff` spawn, none of which belong on a plain session start. Gated on `compact_assist.enabled` -- the key that governs whether token-goat assists compaction at all -- and fails soft, since a missing session blob is the normal case for a session that compacted before token-goat was installed. */
async function postCompactRecovery(event: HookEvent): Promise<string | null> {
  if (event.raw['source'] !== 'compact' || event.sessionId === undefined) return null
  if (!loadConfig().compact_assist.enabled) return null
  try {
    const { buildResumePacket } = await import('./resume.js')
    return await buildResumePacket(event.sessionId)
  } catch {
    return null
  }
}

export async function sessionStartHandler(event: HookEvent): Promise<HookOutput> {
  // Recovery is resolved before the reminder gate and appended after it, because the two answer different questions: `hints.session_start_reminder` turns off a routing reminder an experienced user does not need, and it must not also turn off the restoration of state that has just been compacted away. A user who silenced the reminder still gets the packet, alone.
  const recovery = await postCompactRecovery(event)
  const cwd = getCwd(event)
  // Resolved outside the reminder gate for the same reason as the packet: notes are findings the session recorded on purpose, not routing advice a user opts out of.
  const tail = [projectNotesFor(cwd), recovery].filter((part): part is string => part !== null).join('\n\n')
  const tailOnly = (): HookOutput => (tail === '' ? passOutput() : contextOutput(tail))
  try {
    if (!loadConfig().hints.session_start_reminder) return tailOnly()
    const indexed = isIndexedProject(cwd)
    let context = buildReminder(indexed)
    if (cwd !== undefined) {
      // Runs before the capsule so a drifted file is already queued while the rest of the hook finishes: the worker picks it up on its next 2 s drain rather than on the next command.
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
    if (tail !== '') context += `\n\n${tail}`
    return contextOutput(context)
  } catch {
    return tailOnly()
  }
}

registerHook('session_start', sessionStartHandler)
