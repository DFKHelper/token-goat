/**
 * Efficacy tracking + auto-suppression for token-goat's discretionary hint hooks
 * (`token-goat hint-stats`).
 *
 * ## What counts as a "hint" here
 *
 * A hint is a *discretionary* nudge: a hook noticed the agent doing something wasteful
 * (re-reading a file, cat-ing a whole source file, re-running an already-cached command, ...)
 * and suggested a cheaper alternative via a `context` {@link HookOutput} (see contextOutput in
 * hooks_common.ts). This module deliberately does NOT track every `context` output in the
 * codebase -- only the ones wired through {@link applyHintTracking} below, which are exactly
 * the ones this feature's Step-2 discovery pass found to be conditional, behavior-triggered
 * nudges:
 *
 *   - `bash_redirect`  (hooks_bash.ts, preBashHandler) -- "you used an expensive/bypassing
 *     shell read pattern (cat/tail/head/sed/python open/node readFileSync/PowerShell
 *     Get-Content/find/grep chains/rg symbol search/...), use a token-goat surgical command
 *     (or fd) instead."
 *   - `bash_recall`    (hooks_bash.ts, preBashHandler) -- "this exact command/URL/output is
 *     already cached this session, reuse it via `token-goat bash-output <id>` instead of
 *     re-running it."
 *   - `read_reread_dedup` (hooks_read.ts, preReadHandler) -- "this file (or an overlapping
 *     line range) was already read this session (or by another session/agent), don't re-read
 *     it in full."
 *   - `read_structural_nav` (hooks_read.ts, preReadHandler + postReadHandler) -- "this file is
 *     large / has many lines, use `token-goat skeleton`/`outline`/`section` for structural
 *     navigation instead of a future full re-read."
 *   - `edit_reread_suggest` (hooks_edit.ts, postEditHandler) -- "you just edited this doc file,
 *     re-read one section via `token-goat section` instead of the whole file."
 *
 * Deliberately EXCLUDED, with the reason each is not a discretionary nudge:
 *   - hooks_compact.ts's `preCompactHandler` (pre_compact manifest) -- unconditional: it fires
 *     on every single pre_compact event with no "wasteful behavior" trigger, and IS the
 *     hook's entire job (feeding session continuity into compaction). Treating it as
 *     suppressible "hint efficacy" would risk auto-suppressing session continuity itself,
 *     which is a correctness regression, not a token-savings tradeoff -- an entirely
 *     different risk class from the other categories above.
 *   - hooks_session.ts's `userPromptSubmitHandler` (branch/summary context) -- same reason:
 *     unconditional informational context, not a "you did X, try Y instead" nudge.
 *   - image_shrink.ts's `preReadImageHandler` -- returns a `context` output, but the content
 *     IS the (already-shrunk) image payload substituting for the original read, not a
 *     suggestion to do something differently next time. Suppressing it would mean serving the
 *     full-size image instead, which is a regression, not a "was this tip useful" question.
 *   - hooks_mcp.ts's MCP output compression -- returns `rewriteOutput`, not `context`; the
 *     tool call already happened and this only changes what the model sees of a result already
 *     produced, not a suggestion about what to do differently.
 *   - hooks_agent_spawn.ts's subagent briefing -- returns `rewriteInput` (it rewrites the
 *     Agent tool's own prompt before the call), not a `context` hint.
 *
 * ## Honest signal design (see also the module's own emission/detection code below)
 *
 * Every one of the five tracked categories gets a REAL automatic "acted on" signal, not a
 * fabricated one: each hint's own text is mined (via {@link extractPathCorrelator} or the
 * bash-output-id regex in `classifyBashHint`) for the *specific* file path or cache id the hint
 * pointed at. A pending row is only created when that extraction succeeds. The subsequent
 * `post_tool_use` advisory handler at the bottom of this file then checks, for every tool call
 * in the same session for up to {@link ACTED_ON_WINDOW} further tool calls, whether a Bash
 * command was run that both mentions `token-goat` and mentions that exact correlator --
 * i.e. did the agent actually follow the specific pointer this hint gave, not just "did some
 * unrelated token-goat command happen to run afterward." This is a real, session-scoped,
 * hook-dispatch-order-based correlation, not guesswork.
 *
 * It is still a PROXY for causation, not proof: a match means the agent ran the suggested
 * command shortly after the hint, but cannot prove the hint caused that (the agent might have
 * been about to do it anyway). This is disclosed here and in the CLI output rather than
 * asserted as certainty. When no correlator can be extracted from a hint's text (a small
 * minority of branches with no path/id in their message, e.g. the "collapse grep|grep" or
 * "unbalanced shell quoting, use Write tool" hints), the emission is logged with `acted_on`
 * fixed at 0/resolved immediately -- honestly counted as "no signal available" rather than
 * invented. `token-goat hint-stats --mark-effective/--mark-ineffective <category>` exists as a
 * human override/supplement for exactly this gap; it is tracked as a SEPARATE counter
 * (hint_manual_marks) and never blended into the automatic acted_on/emitted percentage, so the
 * two signals are never silently conflated.
 *
 * ## "model" vs. harness
 *
 * The spec for this feature asked for a `(category, model, sessionId)` suppression key. This
 * codebase's {@link HookEvent} (hook_registry.ts) carries no LLM model identifier anywhere --
 * Claude Code's hook payload does not expose which model is running, and no other bridge in
 * src/bridges does either (verified: no `model` field exists on HookEvent, its `raw` payload,
 * or in any bridge normalizer). Rather than fabricate a model dimension, this module uses
 * {@link getHarnessName} (bridges/registry.ts) -- the harness/CLI driving the session (Claude
 * Code, Codex, Gemini, ...) -- as the closest real, already-existing analog. This is called out
 * explicitly here and in the CLI/README so "harness" is never mistaken for "LLM model."
 *
 * ## Suppression persistence
 *
 * `shouldSuppress` is re-evaluated by querying hint_emissions on every call (hook invocations
 * are short-lived CLI processes with no shared memory -- see db.ts's WAL/busy_timeout doc
 * comment -- so there is no in-process cache to hold a "suppressed this session" flag across
 * calls). Suppression is scoped to `(category, harness)`, not further split by session, because
 * the underlying data store is the one shared cross-session/cross-process `global.db` and a
 * single session rarely emits `min_sample_size` occurrences of one category on its own. In
 * practice this means: once a category's cumulative (category, harness) efficacy crosses the
 * threshold with enough samples, it stays suppressed for every session using that harness until
 * `token-goat hint-stats --reset` is run -- a deliberate, disclosed deviation from a literal
 * "resets every session" reading, chosen because nothing in this codebase's hook-process model
 * could implement true per-session-only suppression honestly.
 */

import { getDb } from './db.js'
import { globalDbPath } from './constants.js'
import { getHarnessName } from './bridges/registry.js'
import { loadConfig } from './config.js'
import { registerHook, type HookEvent } from './hook_registry.js'
import { passOutput } from './hooks_common.js'
import type { HookOutput } from './types.js'

export const HINT_CATEGORIES = [
  'bash_redirect',
  'bash_recall',
  'read_reread_dedup',
  'read_structural_nav',
  'edit_reread_suggest',
] as const

export type HintCategory = (typeof HINT_CATEGORIES)[number]

export function isHintCategory(value: string): value is HintCategory {
  return (HINT_CATEGORIES as readonly string[]).includes(value)
}

// How many subsequent tool-use events (any tool) a pending hint stays eligible for
// auto-detected credit before it's given up on as "not acted on." 5 is deliberately small: the
// categories tracked here are all "do the narrower thing right now instead" nudges, so a
// genuine follow-through should show up within the immediate next couple of tool calls, not
// dozens of turns later where crediting it to this specific hint would stop being credible.
const ACTED_ON_WINDOW = 5

interface Classification {
  category: HintCategory
  correlator: string | null
}

/**
 * Best-effort extraction of the specific file path a hint's text points at, so the acted-on
 * check can require the SAME path to reappear in a later command rather than crediting any
 * unrelated token-goat invocation. Matches a Windows drive-letter path or a POSIX/relative path
 * run of non-whitespace/non-quote characters; trims trailing punctuation a hint's own sentence
 * structure might have appended (a period, closing backtick/quote, etc.).
 */
// Literal `::<placeholder>` suffixes this codebase's own hint text templates splice onto a real
// path (e.g. hooks_edit.ts's `... + '::HeadingName"` ...`, hooks_read.ts's `::SectionName`,
// `::<field>`, `::Symbol`) so a human reads them as "put a heading/symbol name here" -- not
// real values. An agent that actually follows the hint substitutes its own concrete heading or
// symbol, so the command it runs shares the path but never this exact placeholder text, and
// isActedOn's `command.includes(correlator)` check can then never match: acted_on is
// permanently 0 for every hint text that embeds one of these, silently pinning the category's
// efficacy at 0% until it crosses shouldSuppress's threshold and gets auto-suppressed despite
// perfect real-world follow-through. `::compilerOptions` is deliberately excluded -- that one
// names a real, specific tsconfig field in its hint text, not a fill-in-the-blank.
const KNOWN_CORRELATOR_PLACEHOLDERS = new Set([
  'HeadingName',
  'SectionHeading',
  'SectionName',
  'Symbol',
  'SymbolName',
  'name',
])

export function extractPathCorrelator(text: string): string | null {
  const m = /(?:[A-Za-z]:[\\/]|\.{1,2}\/|\/)[^\s"'`]+/.exec(text)
  if (m === null) return null
  const cleaned = m[0].replace(/[`"'.,;:)]+$/, '')
  const sepIdx = cleaned.indexOf('::')
  if (sepIdx === -1) return cleaned
  const suffix = cleaned.slice(sepIdx + 2)
  if (/^<[^<>]*>$/.test(suffix) || KNOWN_CORRELATOR_PLACEHOLDERS.has(suffix)) {
    return cleaned.slice(0, sepIdx)
  }
  return cleaned
}

/** Classifier for hooks_bash.ts's preBashHandler hints. */
export function classifyBashHint(text: string): Classification {
  const idMatch = /token-goat bash-output ([A-Za-z0-9_.-]+)/.exec(text)
  if (idMatch?.[1] !== undefined) {
    return { category: 'bash_recall', correlator: idMatch[1] }
  }
  return { category: 'bash_redirect', correlator: extractPathCorrelator(text) }
}

/** Classifier for hooks_read.ts's preReadHandler/postReadHandler hints. */
export function classifyReadHint(text: string): Classification {
  const category: HintCategory = /already read|already been read/i.test(text) ? 'read_reread_dedup' : 'read_structural_nav'
  return { category, correlator: extractPathCorrelator(text) }
}

/** Classifier for hooks_edit.ts's postEditHandler hint. */
export function classifyEditHint(text: string): Classification {
  return { category: 'edit_reread_suggest', correlator: extractPathCorrelator(text) }
}

/**
 * Wrap a hook handler's already-computed {@link HookOutput}: non-`context` outputs pass through
 * untouched (deny/pass/rewrite* are not hints in this module's sense -- see the module doc
 * comment). A `context` output is classified via `classify`, checked against
 * {@link shouldSuppress} (swapped for a silent `passOutput()` if suppressed), logged via
 * {@link logHintEmission} otherwise, and returned unchanged.
 *
 * Called from each instrumented hook file's thin public wrapper (e.g. hooks_bash.ts's
 * `preBashHandler` calling into the renamed `preBashHandlerInner`) rather than from inside the
 * ~30-branch handler bodies themselves, so none of those branches' own logic needed touching --
 * every `context` output they can possibly produce is intercepted at the one return boundary.
 */
export function applyHintTracking(event: HookEvent, output: HookOutput, classify: (text: string) => Classification): HookOutput {
  if (output.hookType !== 'context') return output
  const { category, correlator } = classify(output.context)
  if (shouldSuppress(category, event.sessionId)) {
    return passOutput()
  }
  // A pre_tool_use-emitted hint (bash_redirect/bash_recall from preBashHandler,
  // read_structural_nav/read_reread_dedup from preReadHandler) is always followed, in a
  // guaranteed-next, separate `token-goat hook post_tool_use` process invocation, by
  // resolvePendingHintsForEvent processing that SAME tool call's own post_tool_use event before
  // any genuinely later tool call can occur -- consuming one calls_remaining unit against the
  // very command the hint was warning about, not a "further" call. A post_tool_use-emitted hint
  // (edit_reread_suggest from postEditHandler, or any hint from postReadHandler) does not have
  // this problem: resolvePendingHintsForEvent is registered before those handlers (hint_stats.ts
  // is pulled in transitively by hooks_read.ts, the first hook module relay.ts imports), so it
  // runs earlier in the same runHook pass and never sees a row that handler hasn't inserted yet.
  // Compensate only for the pre_tool_use case so both paths get the documented ACTED_ON_WINDOW
  // worth of genuinely subsequent chances.
  logHintEmission(category, event.sessionId, correlator, event.eventName === 'pre_tool_use')
  return output
}

/** Fail-soft: never throws, matching every other hook-path DB write in this codebase (see recall_index.ts's indexRecallEntry doc comment). */
export function logHintEmission(category: HintCategory, sessionId: string, correlator: string | null, compensateSelfResolve = false): void {
  try {
    const db = getDb(globalDbPath())
    const resolved = correlator === null ? 1 : 0
    const window = ACTED_ON_WINDOW + (compensateSelfResolve ? 1 : 0)
    db.prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining)
       VALUES (@category, @sessionId, @harness, @correlator, @emittedAt, @resolved, 0, @callsRemaining)`,
    ).run({
      category,
      sessionId,
      harness: getHarnessName(),
      correlator,
      emittedAt: Date.now(),
      resolved,
      callsRemaining: correlator === null ? 0 : window,
    })
  } catch {
    // Fail-soft: a hint-tracking failure must never block the hint (or the tool call) it accompanies.
  }
}

/** True when a subsequent Bash `command` honestly demonstrates the agent followed this specific hint's pointer: it invokes token-goat AND mentions the exact correlator the hint text gave. */
function isActedOn(category: HintCategory, correlator: string, command: string): boolean {
  if (category === 'bash_recall') {
    return command.includes('token-goat') && command.includes('bash-output') && command.includes(correlator)
  }
  return command.includes('token-goat') && command.includes(correlator)
}

/**
 * Advance every unresolved pending hint for this session by one tool-use event: mark
 * `acted_on` when this event's Bash command demonstrates follow-through (see {@link isActedOn}),
 * otherwise decrement its remaining window and resolve it (still not acted on) once that
 * window is exhausted. Every tool call in the session consumes one unit of window for every
 * pending row, not just Bash calls, since the window models "how soon after the hint," not
 * "how many Bash calls specifically."
 */
export function resolvePendingHintsForEvent(event: HookEvent): void {
  try {
    const db = getDb(globalDbPath())
    const command = event.toolName === 'Bash' && typeof event.toolInput['command'] === 'string' ? event.toolInput['command'] : ''
    const pending = db
      .prepare(`SELECT id, category, correlator, calls_remaining FROM hint_emissions WHERE session_id = ? AND resolved = 0`)
      .all(event.sessionId) as Array<{ id: number; category: string; correlator: string | null; calls_remaining: number }>

    for (const row of pending) {
      if (!isHintCategory(row.category) || row.correlator === null) {
        db.prepare(`UPDATE hint_emissions SET resolved = 1 WHERE id = ?`).run(row.id)
        continue
      }
      if (command !== '' && isActedOn(row.category, row.correlator, command)) {
        db.prepare(`UPDATE hint_emissions SET acted_on = 1, resolved = 1 WHERE id = ?`).run(row.id)
        continue
      }
      const remaining = row.calls_remaining - 1
      if (remaining <= 0) {
        db.prepare(`UPDATE hint_emissions SET resolved = 1 WHERE id = ?`).run(row.id)
      } else {
        db.prepare(`UPDATE hint_emissions SET calls_remaining = ? WHERE id = ?`).run(remaining, row.id)
      }
    }
  } catch {
    // Fail-soft, same contract as logHintEmission.
  }
}

// Advisory (never short-circuits another handler — see hook_registry.ts's Registration.advisory
// doc comment) and unfiltered by toolName so every tool call in a session gets a chance to
// resolve pending hints, not just Bash calls (a Read/Edit/Grep/etc. call still consumes one unit
// of window even though it can never itself satisfy isActedOn's Bash-command check).
registerHook(
  'post_tool_use',
  (event) => {
    resolvePendingHintsForEvent(event)
    return passOutput()
  },
  { advisory: true },
)

export interface CategoryEfficacy {
  category: HintCategory
  emitted: number
  actedOn: number
  efficacyPct: number | null
  suppressed: boolean
  manualEffective: number
  manualIneffective: number
}

interface EmissionRow {
  emitted: number
  actedOn: number | null
}

function categoryStats(category: HintCategory): EmissionRow {
  const db = getDb(globalDbPath())
  const row = db
    .prepare(`SELECT COUNT(*) AS emitted, SUM(acted_on) AS actedOn FROM hint_emissions WHERE category = ? AND harness = ?`)
    .get(category, getHarnessName()) as EmissionRow | undefined
  return row ?? { emitted: 0, actedOn: 0 }
}

/**
 * True once (category, current harness) has at least `hint_stats.min_sample_size` emissions AND
 * its acted-on percentage is below `hint_stats.suppress_threshold_pct` — see the module doc
 * comment's "Suppression persistence" section for why this is not literally scoped to only the
 * current `sessionId` despite accepting it as a parameter (kept for interface honesty/future
 * use and because it is the natural key this feature was specified against).
 */
export function shouldSuppress(category: HintCategory, _sessionId: string): boolean {
  try {
    const cfg = loadConfig().hint_stats
    const { emitted, actedOn } = categoryStats(category)
    if (emitted < cfg.min_sample_size) return false
    const pct = (100 * (actedOn ?? 0)) / emitted
    return pct < cfg.suppress_threshold_pct
  } catch {
    return false
  }
}

function manualMarks(category: HintCategory): { effective: number; ineffective: number } {
  try {
    const db = getDb(globalDbPath())
    const row = db.prepare(`SELECT effective_count, ineffective_count FROM hint_manual_marks WHERE category = ?`).get(category) as
      | { effective_count: number; ineffective_count: number }
      | undefined
    return { effective: row?.effective_count ?? 0, ineffective: row?.ineffective_count ?? 0 }
  } catch {
    return { effective: 0, ineffective: 0 }
  }
}

/** Full per-category summary for `token-goat hint-stats`, one row per known category (even categories never emitted this harness get a zeroed row, so the report is a stable, complete shape). */
export function getHintStatsSummary(): CategoryEfficacy[] {
  return HINT_CATEGORIES.map((category) => {
    const { emitted, actedOn } = categoryStats(category)
    const marks = manualMarks(category)
    return {
      category,
      emitted,
      actedOn: actedOn ?? 0,
      efficacyPct: emitted === 0 ? null : Math.round((1000 * (actedOn ?? 0)) / emitted) / 10,
      suppressed: shouldSuppress(category, ''),
      manualEffective: marks.effective,
      manualIneffective: marks.ineffective,
    }
  })
}

/** Clear every tracked emission and manual mark — `token-goat hint-stats --reset`. */
export function resetHintStats(): void {
  const db = getDb(globalDbPath())
  db.exec('DELETE FROM hint_emissions')
  db.exec('DELETE FROM hint_manual_marks')
}

function bumpManualMark(category: HintCategory, column: 'effective_count' | 'ineffective_count'): void {
  const db = getDb(globalDbPath())
  db.prepare(
    `INSERT INTO hint_manual_marks (category, effective_count, ineffective_count) VALUES (?, 0, 0)
     ON CONFLICT(category) DO NOTHING`,
  ).run(category)
  db.prepare(`UPDATE hint_manual_marks SET ${column} = ${column} + 1 WHERE category = ?`).run(category)
}

/** Record a human's vote that `category`'s hints are worth keeping — supplements (never blends into) the automatic acted_on/emitted signal; see the module doc comment. */
export function markCategoryEffective(category: HintCategory): void {
  bumpManualMark(category, 'effective_count')
}

/** Record a human's vote that `category`'s hints are not worth keeping. */
export function markCategoryIneffective(category: HintCategory): void {
  bumpManualMark(category, 'ineffective_count')
}
