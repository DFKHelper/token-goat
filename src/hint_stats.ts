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
 * "unbalanced shell quoting, use Write tool" hints), the emission is logged as resolved
 * immediately -- honestly counted as "no signal available" rather than invented. Which way that
 * no-signal row is booked depends on the category's polarity: a redirect hint books 0, because
 * the substitute command it named was never seen; a suppression hint books 1, because the
 * re-read it warned against was never seen either, and those are the same absence. See
 * {@link isSuppressionCategory}. `token-goat hint-stats --mark-effective/--mark-ineffective <category>` exists as a
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
 *
 * ## Probe recovery (`hints.backoff_thresholds`)
 *
 * A suppressed category would otherwise stay suppressed forever: {@link logHintEmission} is
 * only ever reached on the NOT-suppressed branch of {@link applyHintTracking}, so a fully
 * suppressed category can never accumulate the fresh acted-on signal that would lift it back
 * above `suppress_threshold_pct`. `hints.backoff_thresholds` (an ascending list of occasion
 * counts, e.g. `[1, 3, 10, 30]`) fixes this with a classic backoff-retry schedule: while a
 * category stays suppressed, {@link isProbeOccasion} counts consecutive suppressed occasions
 * since suppression began (persisted durably in the `hint_suppression_probes` table -- see
 * db.ts's schema comment -- because hook invocations are short-lived processes with no shared
 * in-memory counter, same reasoning as `shouldSuppress` above). At the 1st, 3rd, 10th, 30th, ...
 * matching occasion, the hint is let through as a genuine "probe": shown to the caller AND
 * logged via `logHintEmission` like any normal emission, so a real acted-on signal can move
 * `categoryStats` on the very next `shouldSuppress` check. A probe occasion does NOT reset the
 * streak counter by itself -- only a category actually exiting suppression (the top-level
 * `shouldSuppress` check returning `false` again) does, via {@link applyHintTracking}'s
 * not-suppressed branch. This is a deliberate reading of "count occasions since last shown": if
 * a probe firing reset the counter to 0 every time, the very next suppressed occasion would
 * immediately re-match the smallest configured threshold (1, by default), turning probing into
 * "show it every single time" and making the 3rd/10th/30th thresholds unreachable -- an
 * anchored-at-suppression-onset counter is the only reading under which all four configured
 * thresholds do anything. An empty `backoff_thresholds` (`[]`) means no probes at all --
 * suppression is permanent until a manual `--reset`, matching this array's pre-existing
 * round-trip-tested "empty means off" default-empty-list semantics in config.ts.
 */

import { getDb } from './db.js'
import { globalDbPath } from './constants.js'
import { getHarnessName } from './bridges/registry.js'
import { loadConfig } from './config.js'
import { registerHook, type HookEvent } from './hook_registry.js'
import { passOutput } from './hooks_common.js'
import { summarize, SOURCE_HINT } from './stats.js'
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
// names a real, specific tsconfig field in its hint text, not a fill-in-the-blank. `Heading`,
// `sectionName`, and `table_name` (hooks_bash.ts's extractNodeFileRead/markdown-heading-grep
// hints) were missing here for the same reason until this fix -- adding a new hint template
// with a fresh `::<Placeholder>` string is exactly the failure mode this set exists to catch,
// so grep the codebase for `::[A-Za-z][A-Za-z0-9_]*["'`]` in hint text before assuming it's
// covered.
const KNOWN_CORRELATOR_PLACEHOLDERS = new Set([
  'Heading',
  'HeadingName',
  'SectionHeading',
  'SectionName',
  'sectionName',
  'Symbol',
  'SymbolName',
  'table_name',
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
  // The `--file "<path>"` form (used by the tasks-output and Python-transcript hints) must be
  // matched before the bare-id form below: `[A-Za-z0-9_.-]+` includes `-`, so it would otherwise
  // capture the literal flag token `--file` itself as the correlator, and isActedOn's
  // `command.includes(correlator)` would then credit ANY later `bash-output --file <anything>`
  // call as having followed this hint, regardless of which file it actually points at.
  const fileMatch = /token-goat bash-output --file "([^"]+)"/.exec(text)
  if (fileMatch?.[1] !== undefined) {
    return { category: 'bash_recall', correlator: fileMatch[1] }
  }
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
 * Whether `occasion` (a 1-based count of consecutive suppressed occasions since a category last
 * had a hint actually shown) is a scheduled probe point under `thresholds`. `thresholds` need not
 * arrive pre-sorted or pre-filtered -- non-positive entries are dropped and the rest sorted
 * ascending before matching, since `hints.backoff_thresholds` is user-settable via `config set`
 * with no ordering guarantee. An empty (or all-non-positive) list never probes, preserving the
 * documented "no probes, suppression is permanent" behavior for `backoff_thresholds: []`. Once
 * `occasion` exceeds the largest configured threshold, it probes every multiple of that largest
 * threshold thereafter (e.g. every 30th occasion beyond an initial `[1, 3, 10, 30]` schedule).
 */
export function isProbeOccasion(occasion: number, thresholds: readonly number[]): boolean {
  const sorted = [...new Set(thresholds.filter((t) => t > 0))].sort((a, b) => a - b)
  if (sorted.length === 0) return false
  if (sorted.includes(occasion)) return true
  const last = sorted[sorted.length - 1]!
  return occasion > last && occasion % last === 0
}

/**
 * Increment and return the durable `(category, harness)` suppressed-occasion streak backing
 * {@link isProbeOccasion} -- see hint_suppression_probes' schema comment in db.ts and this
 * module's "Probe recovery" doc-comment section for why this counter exists and how it's scoped.
 * Fail-soft like every other hook-path DB write here: a failure returns 0, which
 * {@link isProbeOccasion} never treats as a probe match for any non-empty threshold list, so a
 * transient DB error degrades to "stay suppressed" rather than accidentally probing.
 */
function bumpSuppressionStreak(category: HintCategory): number {
  try {
    const db = getDb(globalDbPath())
    const harness = getHarnessName()
    db.prepare(
      `INSERT INTO hint_suppression_probes (category, harness, streak) VALUES (@category, @harness, 1)
       ON CONFLICT(category, harness) DO UPDATE SET streak = streak + 1`,
    ).run({ category, harness })
    const row = db.prepare(`SELECT streak FROM hint_suppression_probes WHERE category = ? AND harness = ?`).get(category, harness) as
      | { streak: number }
      | undefined
    return row?.streak ?? 0
  } catch {
    return 0
  }
}

/** Reset the streak counter for `(category, harness)` back to 0 -- called whenever a category is NOT currently suppressed, so a later suppression episode's backoff schedule starts fresh from occasion 1. A no-op (not an error) when no row exists yet for this category/harness. */
function resetSuppressionStreak(category: HintCategory): void {
  try {
    const db = getDb(globalDbPath())
    db.prepare(`UPDATE hint_suppression_probes SET streak = 0 WHERE category = ? AND harness = ?`).run(category, getHarnessName())
  } catch {
    // Fail-soft, same contract as logHintEmission.
  }
}

/**
 * Wrap a hook handler's already-computed {@link HookOutput}: non-`context` outputs pass through
 * untouched (deny/pass/rewrite* are not hints in this module's sense -- see the module doc
 * comment). A `context` output is classified via `classify`, checked against
 * {@link shouldSuppress}. When suppressed, this occasion's streak is bumped and checked against
 * `hints.backoff_thresholds` via {@link isProbeOccasion}: a matching occasion is let through and
 * logged as a genuine probe (see the module doc comment's "Probe recovery" section); any other
 * suppressed occasion is swapped for a silent `passOutput()`, same as before probing existed.
 * When not suppressed, the streak is reset (a fresh suppression episode later starts its backoff
 * schedule over from occasion 1) and the emission is logged via {@link logHintEmission} as
 * always.
 *
 * Called from each instrumented hook file's thin public wrapper (e.g. hooks_bash.ts's
 * `preBashHandler` calling into the renamed `preBashHandlerInner`) rather than from inside the
 * ~30-branch handler bodies themselves, so none of those branches' own logic needed touching --
 * every `context` output they can possibly produce is intercepted at the one return boundary.
 */
export function applyHintTracking(event: HookEvent, output: HookOutput, classify: (text: string) => Classification): HookOutput {
  if (output.hookType !== 'context') return output
  const { category, correlator } = classify(output.context)
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
  const compensateSelfResolve = event.eventName === 'pre_tool_use'
  if (shouldSuppress(category, event.sessionId)) {
    const occasion = bumpSuppressionStreak(category)
    const thresholds = loadConfig().hints.backoff_thresholds
    if (!isProbeOccasion(occasion, thresholds)) {
      return passOutput()
    }
    // Probe occasion: let it through and log it exactly like a normal (non-suppressed) emission
    // -- see the module doc comment for why the streak is deliberately NOT reset here.
    logHintEmission(category, event.sessionId, correlator, compensateSelfResolve, output.context.length)
    return output
  }
  resetSuppressionStreak(category)
  logHintEmission(category, event.sessionId, correlator, compensateSelfResolve, output.context.length)
  return output
}

/** Fail-soft: never throws, matching every other hook-path DB write in this codebase (see recall_index.ts's indexRecallEntry doc comment). `bytesEmitted` is the hint text's own length (the real cost of injecting it into context) -- left `null` (never defaulted to 0) when the caller has no figure to give, so a legacy/untracked emission stays honestly distinguishable from a genuine zero-byte spend; see hint_emissions.bytes_emitted's schema comment in db.ts. */
export function logHintEmission(category: HintCategory, sessionId: string, correlator: string | null, compensateSelfResolve = false, bytesEmitted: number | null = null): void {
  try {
    const db = getDb(globalDbPath())
    const resolved = correlator === null ? 1 : 0
    // A suppression hint resolved on the spot for want of a correlator was never contradicted; see
    // SUPPRESSION_HINT_CATEGORIES for why an unobservable row must not be booked as a failure.
    const actedOn = resolved === 1 && isSuppressionCategory(category) ? 1 : 0
    const window = ACTED_ON_WINDOW + (compensateSelfResolve ? 1 : 0)
    db.prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining, bytes_emitted)
       VALUES (@category, @sessionId, @harness, @correlator, @emittedAt, @resolved, @actedOn, @callsRemaining, @bytesEmitted)`,
    ).run({
      category,
      sessionId,
      harness: getHarnessName(),
      correlator,
      emittedAt: Date.now(),
      resolved,
      actedOn,
      callsRemaining: correlator === null ? 0 : window,
      bytesEmitted,
    })
  } catch {
    // Fail-soft: a hint-tracking failure must never block the hint (or the tool call) it accompanies.
  }
}

// Matches "token-goat" only when it appears as a standalone command/argument token (bounded by
// start-of-string, whitespace, or a shell operator on the left and whitespace/end-of-string on the
// right) -- NOT when it's merely a path segment, e.g. `cat C:/Projects/token-goat/src/foo.ts`. This
// project's own working directory is literally named "token-goat", so a naive `.includes('token-goat')`
// would be trivially satisfied by any command whose target path lies inside this repo, defeating the
// whole point of checking that the CLI was actually invoked.
const TOKEN_GOAT_INVOCATION_RE = /(?:^|[\s;&|])(?:token-goat|tg)(?=[\s]|$)/

/** True when `command` contains `correlator` as a whole path/id token, not merely as a prefix or
 * suffix of a longer, unrelated one (e.g. correlator `foo.ts` must not match `foo.tsx`, id `ab12`
 * must not match `ab1234`, and correlator `1234abcd` must not match `x1234abcd`) -- mirrors the
 * boundary check other prefix/suffix-matching code in this codebase (e.g.
 * read_commands.ts's endsWithPathBoundary / coverage_query.ts's endsWithPathBoundaryLocal, and
 * skill_cache.ts's session-fragment guard) already applies. Requires the character immediately
 * before AND after every match to be absent or not a path/id-continuation character
 * (alphanumeric, `_`, `.`, `-`) -- a correlator extracted from a hint's own text always starts and
 * ends at such a boundary there, but that says nothing about whether a later, unrelated command
 * happens to embed the same substring glued onto a longer token, so both sides of every match in
 * `command` must be checked independently. */
function commandMentionsCorrelator(command: string, correlator: string): boolean {
  let idx = command.indexOf(correlator)
  while (idx !== -1) {
    const before = idx > 0 ? command[idx - 1] : undefined
    const after = command[idx + correlator.length]
    const beforeOk = before === undefined || !/[A-Za-z0-9_.-]/.test(before)
    const afterOk = after === undefined || !/[A-Za-z0-9_.-]/.test(after)
    if (beforeOk && afterOk) return true
    idx = command.indexOf(correlator, idx + 1)
  }
  return false
}

/**
 * Categories whose hint asks the agent NOT to do something ("you already read this file, recall it
 * instead of re-reading"). Compliance with one of these is an *absence*: the agent reads nothing and
 * moves on, so there is no command to observe. The redirect categories are the opposite -- they name
 * a cheaper command to run instead, and running it is the observable proof.
 *
 * Measuring both with the same presence test made these two structurally unable to score: every row
 * resolved `acted_on = 0` no matter how well the hint worked, efficacy sat at exactly 0%, and
 * `shouldSuppress` muted the category for good once `min_sample_size` rows had accrued. So the
 * hints that save the most -- the ones that stop a whole re-read -- were the first to turn
 * themselves off, on evidence that could not exist. Polarity is therefore inverted for these:
 * assume compliance, and count only observed defiance against them.
 */
const SUPPRESSION_HINT_CATEGORIES: ReadonlySet<HintCategory> = new Set<HintCategory>([
  'read_reread_dedup',
  'edit_reread_suggest',
])

/** True when this category's hint asks for an absence rather than a substitute command. */
export function isSuppressionCategory(category: HintCategory): boolean {
  return SUPPRESSION_HINT_CATEGORIES.has(category)
}

/** Tool-input keys that name the file a non-Bash read/edit tool is about, across harnesses. */
const EVENT_PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'path'] as const

/**
 * The text of this event that a correlator can be looked for in: the Bash command, or the file path
 * a Read/Edit-shaped tool was pointed at. A suppression hint is defied by a plain `Read` just as
 * much as by a `cat`, so both shapes have to be visible here.
 */
function eventTargetText(event: HookEvent): string {
  if (event.toolName === 'Bash') {
    const c = event.toolInput['command']
    return typeof c === 'string' ? c : ''
  }
  for (const key of EVENT_PATH_KEYS) {
    const v = event.toolInput[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return ''
}

/**
 * True when this event re-reads the very path a suppression hint just said was already in hand,
 * by a route that costs the full file. A token-goat invocation is excluded: taking the surgical
 * route is following the hint, not defying it.
 */
function isDefiance(correlator: string, target: string): boolean {
  if (target === '') return false
  if (TOKEN_GOAT_INVOCATION_RE.test(target)) return false
  return commandMentionsCorrelator(target, correlator)
}

/** True when a subsequent Bash `command` honestly demonstrates the agent followed this specific hint's pointer: it invokes token-goat AND mentions the exact correlator the hint text gave. */
function isActedOn(category: HintCategory, correlator: string, command: string): boolean {
  if (!TOKEN_GOAT_INVOCATION_RE.test(command)) return false
  if (category === 'bash_recall') {
    return command.includes('bash-output') && commandMentionsCorrelator(command, correlator)
  }
  return commandMentionsCorrelator(command, correlator)
}

/**
 * Advance every unresolved pending hint for this session by one tool-use event: mark
 * `acted_on` when this event's Bash command demonstrates follow-through (see {@link isActedOn}),
 * otherwise decrement its remaining window and resolve it (still not acted on) once that
 * window is exhausted. Every tool call token-goat observes consumes one unit of window for
 * every pending row, not just Bash calls, since the window models "how soon after the hint," not
 * "how many Bash calls specifically."
 */
export function resolvePendingHintsForEvent(event: HookEvent): void {
  try {
    const db = getDb(globalDbPath())
    const command = event.toolName === 'Bash' && typeof event.toolInput['command'] === 'string' ? event.toolInput['command'] : ''
    const target = eventTargetText(event)
    const pending = db
      .prepare(`SELECT id, category, correlator, calls_remaining FROM hint_emissions WHERE session_id = ? AND resolved = 0`)
      .all(event.sessionId) as Array<{ id: number; category: string; correlator: string | null; calls_remaining: number }>

    for (const row of pending) {
      if (!isHintCategory(row.category) || row.correlator === null) {
        // Nothing observable to wait for. A suppression hint that named no path was never
        // contradicted, so resolving it as a failure would be the same false negative this
        // category's inverted polarity exists to avoid.
        const unobservable = isHintCategory(row.category) && isSuppressionCategory(row.category) ? 1 : 0
        db.prepare(`UPDATE hint_emissions SET acted_on = ?, resolved = 1 WHERE id = ?`).run(unobservable, row.id)
        continue
      }
      if (isSuppressionCategory(row.category)) {
        // Inverted polarity: a re-read of the named path is the only thing that counts against
        // this hint. Anything else -- including the window simply running out because the agent
        // read nothing -- is the compliance the hint asked for.
        if (isDefiance(row.correlator, target)) {
          db.prepare(`UPDATE hint_emissions SET acted_on = 0, resolved = 1 WHERE id = ?`).run(row.id)
          continue
        }
        if (command !== '' && isActedOn(row.category, row.correlator, command)) {
          db.prepare(`UPDATE hint_emissions SET acted_on = 1, resolved = 1 WHERE id = ?`).run(row.id)
          continue
        }
        const left = row.calls_remaining - 1
        if (left <= 0) {
          db.prepare(`UPDATE hint_emissions SET acted_on = 1, resolved = 1 WHERE id = ?`).run(row.id)
        } else {
          db.prepare(`UPDATE hint_emissions SET calls_remaining = ? WHERE id = ?`).run(left, row.id)
        }
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
// doc comment) and unfiltered by toolName so every observed tool call gets a chance to resolve
// pending hints, not just Bash calls (a Read/Edit/Grep/etc. call still consumes one unit of
// window even though it can never itself satisfy isActedOn's Bash-command check).
//
// followsMatcher: this is the one handler that would otherwise force PostToolUse to a catch-all
// matcher, making every unrelated tool call spawn a whole hook process (~90% of which is Node
// startup plus bundle evaluation) purely to tick a counter. Accepting the installed matcher means
// the window counts tool calls token-goat *observes* rather than every tool call in the session —
// roughly 15% fewer in practice, so a pending hint survives slightly longer in wall-clock terms.
// That is within ACTED_ON_WINDOW's own stated tolerance (5 is a deliberately rough "the immediate
// next couple of tool calls"), and it cannot change which hints are creditable: only a Bash call
// ever satisfies isActedOn, and Bash is always in the matcher.
registerHook(
  'post_tool_use',
  (event) => {
    resolvePendingHintsForEvent(event)
    return passOutput()
  },
  { advisory: true, followsMatcher: true },
)

export interface CategoryEfficacy {
  category: HintCategory
  emitted: number
  actedOn: number
  efficacyPct: number | null
  suppressed: boolean
  /**
   * True only when this category is suppressed *and* `hints.backoff_thresholds` is empty, so no
   * probe occasion will ever let it through again and the suppression can only be lifted by a
   * manual `token-goat hint-stats --reset`. False when the category is not suppressed, and also
   * when it is suppressed but probes are configured, where suppression is a self-healing throttle
   * rather than an off switch. Those two states are operationally opposite and used to render
   * identically; see the config comment on `backoff_thresholds` for why `[]` is a supported value.
   */
  suppressionPermanent: boolean
  manualEffective: number
  manualIneffective: number
  /** Sum of bytes_emitted across this category's tracked (non-legacy) emissions -- `null` when none of its emissions carry a spend figure (either zero emissions, or every one predates spend tracking; see `legacyEmissions`), never a fake 0. */
  bytesEmitted: number | null
  /** Count of this category's emissions with no bytes_emitted figure recorded -- pre-migration rows (see hint_emissions.bytes_emitted's schema comment in db.ts) plus any emission a caller logged without one. */
  legacyEmissions: number
}

interface EmissionRow {
  emitted: number
  actedOn: number | null
  bytesEmitted: number | null
  legacyEmissions: number | null
}

function categoryStats(category: HintCategory): EmissionRow {
  const db = getDb(globalDbPath())
  const row = db
    .prepare(
      `SELECT COUNT(*) AS emitted, SUM(acted_on) AS actedOn, SUM(bytes_emitted) AS bytesEmitted,
              SUM(CASE WHEN bytes_emitted IS NULL THEN 1 ELSE 0 END) AS legacyEmissions
       FROM hint_emissions WHERE category = ? AND harness = ?`,
    )
    .get(category, getHarnessName()) as EmissionRow | undefined
  return row ?? { emitted: 0, actedOn: 0, bytesEmitted: null, legacyEmissions: 0 }
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

/**
 * True when a specific hint emission's own quantified byte savings meet
 * `hints.min_session_hint_savings_bytes`. Unlike {@link shouldSuppress} (a cross-session,
 * per-category historical-efficacy signal backed by `hint_emissions`), this is a cheap, local,
 * per-call floor: "is THIS hint's savings big enough to be worth the friction of showing it,
 * right now" — no persistence, no sampling, just the one number the caller already computed.
 * Callers that already derive a concrete bytesSaved figure immediately before emitting a
 * `context` hint should gate on this the same way they gate on {@link shouldSuppress} results —
 * swap the hint for a silent `passOutput()` (or let the underlying command run normally) when
 * it returns false.
 */
export function meetsSavingsFloor(bytesSaved: number): boolean {
  return bytesSaved >= loadConfig().hints.min_session_hint_savings_bytes
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
  const probeThresholds = loadConfig().hints.backoff_thresholds.filter((t) => t > 0)
  return HINT_CATEGORIES.map((category) => {
    const { emitted, actedOn, bytesEmitted, legacyEmissions } = categoryStats(category)
    const marks = manualMarks(category)
    const suppressed = shouldSuppress(category, '')
    return {
      category,
      emitted,
      actedOn: actedOn ?? 0,
      efficacyPct: emitted === 0 ? null : Math.round((1000 * (actedOn ?? 0)) / emitted) / 10,
      suppressed: suppressed,
      suppressionPermanent: suppressed && probeThresholds.length === 0,
      manualEffective: marks.effective,
      manualIneffective: marks.ineffective,
      bytesEmitted,
      legacyEmissions: legacyEmissions ?? 0,
    }
  })
}

export interface HintStatsTotals {
  /** All-time bytes saved across every hint kind (see stats.ts's KIND_TO_SOURCE) already recorded via the pre-existing `stats` ledger -- unaffected by this feature, just read here. This is a much larger population than `spentBytes`: it covers every hint-emitting call site across the whole codebase, while `hint_emissions` (the source of `spentBytes`) only tracks emissions from the categories in {@link HINT_CATEGORIES}. The two are NOT comparable and must never be subtracted from one another -- see the regression note on {@link getHintStatsTotals}. */
  savedBytes: number
  /** All-time sum of hint_emissions.bytes_emitted across every category and harness -- `null` when nothing has been tracked yet (an empty store or a store made up entirely of legacy emissions; see `legacyEmissions`), never a fake 0. */
  spentBytes: number | null
  /** All-time count of emissions with no bytes_emitted figure, across every category and harness -- non-zero here means `spentBytes` is computed from a subset of real emissions, not the full history. */
  legacyEmissions: number
}

/**
 * All-time saved/spent totals for `token-goat hint-stats`'s summary line — see {@link getHintStatsSummary} for
 * the per-category breakdown this rolls up. Deliberately NOT harness-scoped, unlike the per-category rows above
 * it: `savedBytes` comes from the `stats` ledger, which has no `harness` column at all (see stats.ts's
 * GLOBAL_SCHEMA_SQL) and therefore spans every harness.
 *
 * Regression note: this used to also return a `netBytes = savedBytes - spentBytes` figure. `savedBytes` is an
 * all-time aggregate over every kind stats.ts maps to `SOURCE_HINT` (session_hint, diff_hint,
 * evidence_cache_hit, etc. -- tens of thousands of events), while `spentBytes` sums only the much smaller
 * `hint_emissions` ledger (a handful of tracked rows, since that table only started recording spend
 * post-migration). Those are disjoint populations: subtracting one from the other produced a "net" figure in
 * the billions that implied a few dozen tracked emissions netted gigabytes, which they never did. Report the
 * two figures separately, each labelled with its own population, and never combine them into a difference.
 */
export function getHintStatsTotals(): HintStatsTotals {
  const db = getDb(globalDbPath())
  const row = db
    .prepare(
      `SELECT SUM(bytes_emitted) AS spentBytes, SUM(CASE WHEN bytes_emitted IS NULL THEN 1 ELSE 0 END) AS legacyEmissions
       FROM hint_emissions`,
    )
    .get() as { spentBytes: number | null; legacyEmissions: number | null } | undefined
  const spentBytes = row?.spentBytes ?? null
  const legacyEmissions = row?.legacyEmissions ?? 0
  const savedBytes = summarize(0).by_source[SOURCE_HINT]?.bytes_saved ?? 0
  return {
    savedBytes,
    spentBytes,
    legacyEmissions,
  }
}

/** Clear every tracked emission, manual mark, and probe-recovery streak — `token-goat hint-stats --reset`. */
export function resetHintStats(): void {
  const db = getDb(globalDbPath())
  db.exec('DELETE FROM hint_emissions')
  db.exec('DELETE FROM hint_manual_marks')
  db.exec('DELETE FROM hint_suppression_probes')
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
