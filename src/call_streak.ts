/** Call-streak advisories: the two hints that judge a run of tool calls rather than one call. The batch hint notices read-only calls (Read, Grep, Glob, and Bash searches and file reads) going out one assistant turn at a time when they could have gone out together, and the search brake notices consecutive searches that each found nothing. Both are decided from one per-(sub)agent sidecar and both add tokens, so each speaks at most once per streak and at most a few times per session. relay.ts feeds every pre/post tool event through {@link applyCallStreak} after the handlers have answered, the one place that sees the final output: a denied call is skipped outright, and a line only ever joins a `pass` or `context` answer, never a rewrite. A failed call reaches this module from hooks_tool_failure.ts ({@link callStreakAfterFailure}), which has already classified it. Both hints are scored here rather than by hint_stats.ts's correlator window, because what they ask for is a pattern of calls: the batch hint counts as acted on when the first later turn that makes read-only calls makes at least two of them together, the brake when the next search from a later turn is `token-goat answer` or `token-goat semantic`. */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { splitShellSegments, stripLeadingAssignments } from './bash_extractors.js'
import { applyHintTracking, settleSelfScoredHints, uncorrelatedHint, type HintCategory } from './hint_stats.js'
import { sessionStateKey, type HookEvent } from './hook_registry.js'
import { extractCommand, PIPELINE_PASSTHROUGH_HEADS, pureFileReadPath, stripCommandPrefix, unwrapCompressCommand } from './hooks_bash_commands.js'
import { contextOutput, estimateResultCount, extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS, structuredResultCount } from './hooks_common.js'
import { sessionSidecarPath } from './session_store.js'
import { recordStat } from './stats.js'
import { SEARCH_COMMAND_RE } from './tool_error_class.js'
import type { HookOutput } from './types.js'
import { ensureDirSync } from './util.js'

/** A read-only call whose PreToolUse arrives more than this long after the previous read-only call's PostToolUse was sent in a later assistant turn, so the model waited for that result before asking. Captured on Claude Code 2.1.281: three Greps issued in one message ran pre,post,pre,post with 4 ms and 186 ms between one call's post and the next call's pre, while the next message's pre came 2,442 ms after the previous post (Haiku); the median gap between serial calls across 3,688 local transcripts is 11.1 s. One second sits five times above the slowest same-message gap and below the fastest cross-turn one. */
export const SERIAL_GAP_MS = 1_000

/** Consecutive serial read-only calls before the batch hint speaks. Two in a row are often a real dependency (read a file, then read what it names); the third is where a run stops looking like one. Measured over the same transcripts: 1,082 serial runs of 2+ read-only calls covered 2,927 calls, about 1,845 avoidable round trips. */
export const SERIAL_READS_BEFORE_HINT = 3

/** Consecutive zero-hit searches before the brake speaks: one empty search is ordinary, three in a row is a loop guessing at literals. */
export const ZERO_HIT_SEARCHES_BEFORE_BRAKE = 3

/** Batch hints per agent per session. The line costs about 30 tokens; a second showing covers a model that has since lost the first to a long turn or a compaction, and hint-stats scores the category so this can be tuned from its acted-on rate. */
export const MAX_BATCH_HINTS_PER_SESSION = 2

/** Search brakes per agent per session, on the same reasoning as {@link MAX_BATCH_HINTS_PER_SESSION}. */
export const MAX_SEARCH_BRAKES_PER_SESSION = 2

const STREAK_SUFFIX = '.call-streak'

/** token-goat's own search subcommands, the set the transcript census behind these constants counted as Bash searches. */
const TG_SEARCH_RE = /^(?:token-goat|tg)\s+(?:answer|semantic|symbol|refs|locate)\b/

/** The two searches the brake points at: search by meaning rather than by literal. */
const TG_MEANING_SEARCH_RE = /^(?:token-goat|tg)\s+(?:answer|semantic)\b/

/** token-goat's surgical reads. */
const TG_READ_RE = /^(?:token-goat|tg)\s+(?:read|section|outline|skeleton|brief)\b/

/** An output redirection that writes a file; `2>&1` and `>/dev/null` do not. Deliberately loose, so a `>` inside a quoted pattern also disqualifies a command: that only costs a hint, never invents one. */
const WRITE_REDIRECT_RE = /\d?>>?(?!\s*(?:&\d|\/dev\/null\b))/

/** Where a pending acted-on verdict for the batch hint stands: waiting for the first read-only call of a later turn, or for the call after it. */
type BatchVerdict = 'none' | 'next_turn' | 'second_call'

interface StreakState {
  /** The harness's `prompt_id` the counters belong to; a new user prompt starts every streak over. */
  promptId: string
  /** Unix ms of the latest read-only call's post (or failure), 0 when none since the last break. */
  lastReadPostAt: number
  /** A read-only pre was seen and its post has not arrived. A pre that finds one in flight is treated as batched: calls run concurrently, or an async-detached post (shim_common.ts) has not written yet. */
  inFlight: boolean
  serialRun: number
  batchShownInRun: boolean
  batchShown: number
  batchVerdict: BatchVerdict
  zeroHits: number
  brakeShownInRun: boolean
  brakeShown: number
  /** A shown brake awaits the next search from a later turn. */
  brakeVerdict: boolean
}

function freshState(): StreakState {
  return { promptId: '', lastReadPostAt: 0, inFlight: false, serialRun: 0, batchShownInRun: false, batchShown: 0, batchVerdict: 'none', zeroHits: 0, brakeShownInRun: false, brakeShown: 0, brakeVerdict: false }
}

function readState(target: string): StreakState {
  const state = freshState()
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return state
    const p = parsed as Record<string, unknown>
    for (const key of Object.keys(state) as (keyof StreakState)[]) {
      if (typeof p[key] === typeof state[key]) (state as unknown as Record<string, unknown>)[key] = p[key]
    }
    if (!['none', 'next_turn', 'second_call'].includes(state.batchVerdict)) state.batchVerdict = 'none'
  } catch {
    // Missing, unreadable or corrupt: a fresh state, which is the silent direction.
  }
  return state
}

function writeState(target: string, state: StreakState): void {
  try {
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify(state), 'utf8')
  } catch {
    // Best-effort: a state that cannot be stored forgets its streak, which can only withhold a hint.
  }
}

interface CallKind {
  readonly readOnly: boolean
  readonly search: boolean
  /** A `token-goat answer` or `token-goat semantic` call: what the brake asks for. */
  readonly meaningSearch: boolean
}

const MUTATING: CallKind = { readOnly: false, search: false, meaningSearch: false }

function isPassThroughStage(stage: string): boolean {
  const head = (stage.split(/\s/, 1)[0] ?? '').replace(/^.*[/\\]/, '')
  return head !== 'tee' && PIPELINE_PASSTHROUGH_HEADS.has(head)
}

/** Classify a Bash command. Read-only means a file read the read gates recognise, or a pipeline whose every stage is a search, a pass-through or a token-goat read with no file-writing redirection. Anything else, `find`/`fd` included (`-exec`, `-delete`, `-x` all mutate), counts as a call that may change what the next one sees. */
function bashCallKind(event: HookEvent): CallKind {
  const raw = extractCommand(event)
  if (raw === undefined) return MUTATING
  const cmd = stripCommandPrefix(unwrapCompressCommand(raw) ?? raw)
  const stages = splitShellSegments(cmd).map((s) => stripLeadingAssignments(s.trim())).filter((s) => s !== '')
  if (stages.length === 0 || stages.some((s) => WRITE_REDIRECT_RE.test(s))) return MUTATING
  const searches = stages.filter((s) => SEARCH_COMMAND_RE.test(s) || TG_SEARCH_RE.test(s))
  const readOnly = pureFileReadPath(cmd) !== null || stages.every((s) => SEARCH_COMMAND_RE.test(s) || TG_SEARCH_RE.test(s) || TG_READ_RE.test(s) || isPassThroughStage(s))
  if (!readOnly) return MUTATING
  return { readOnly, search: searches.length > 0, meaningSearch: TG_MEANING_SEARCH_RE.test(stages[0] ?? '') }
}

function callKind(event: HookEvent): CallKind {
  switch (event.toolName) {
    case 'Read':
      return { readOnly: true, search: false, meaningSearch: false }
    case 'Grep':
    case 'Glob':
      return { readOnly: true, search: true, meaningSearch: false }
    case 'Bash':
      return bashCallKind(event)
    default:
      return MUTATING
  }
}

/** How many results a successful search returned, or null when the response says nothing either way. A Bash search that reached the ordinary post event exited 0 (Claude Code sends a non-zero exit to PostToolUseFailure instead), so only an empty output counts as nothing found there: a pipeline such as `rg x | head` exits 0 on no match. */
function searchResultCount(event: HookEvent): number | null {
  const structured = structuredResultCount(event.raw)
  if (structured !== null) return structured
  const text = extractToolResponseField(event.raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
  if (event.toolName === 'Bash') return text.trim() === '' ? 0 : 1
  return text === '' ? null : estimateResultCount(text)
}

function batchHintText(run: number): string {
  return `[token-goat] ${run} reads/searches in a row each waited a full turn. Issue independent reads and searches together in one message.`
}

function searchBrakeText(misses: number): string {
  return `[token-goat] ${misses} searches in a row found nothing. Search by meaning instead of guessing literals: \`token-goat answer "<question>"\` or \`token-goat semantic "<description>"\`.`
}

/** Emit one line through the hint ledger (which may suppress it), returning the text actually shown or null. The row's correlator is this agent's key, the one {@link settleSelfScoredHints} matches, since a subagent shares its parent's session_id. */
function trackedLine(event: HookEvent, category: HintCategory, text: string): string | null {
  const out = applyHintTracking(event, contextOutput(text, [sessionStateKey(event)]), uncorrelatedHint(category))
  if (out.hookType !== 'context') return null
  recordStat('session_hint', 0, 0)
  return out.context
}

/** A mutating call, or a new user prompt: whatever came next may depend on it, so both streaks start over. */
function breakStreaks(event: HookEvent, state: StreakState): void {
  if (state.batchVerdict === 'second_call') {
    // The first turn after the hint made one read-only call and moved on.
    settleSelfScoredHints('read_batch', event, false)
    state.batchVerdict = 'none'
  }
  Object.assign(state, { lastReadPostAt: 0, inFlight: false, serialRun: 0, batchShownInRun: false, zeroHits: 0, brakeShownInRun: false })
}

function onReadOnlyPre(event: HookEvent, state: StreakState, kind: CallKind, now: number, canSpeak: boolean): string | null {
  const serial = !state.inFlight && (state.lastReadPostAt === 0 || now - state.lastReadPostAt > SERIAL_GAP_MS)
  state.inFlight = true
  // Verdicts first, judged only on calls from a turn after the one the line was attached to: a call batched with that one was issued before the model could have read it.
  if (state.batchVerdict === 'second_call') {
    settleSelfScoredHints('read_batch', event, !serial)
    state.batchVerdict = 'none'
  } else if (state.batchVerdict === 'next_turn' && serial) {
    state.batchVerdict = 'second_call'
  }
  if (state.brakeVerdict && kind.search && serial) {
    settleSelfScoredHints('search_brake', event, kind.meaningSearch)
    state.brakeVerdict = false
  }
  if (!serial) {
    state.serialRun = 0
    state.batchShownInRun = false
    return null
  }
  state.serialRun += 1
  if (state.serialRun < SERIAL_READS_BEFORE_HINT || state.batchShownInRun || state.batchShown >= MAX_BATCH_HINTS_PER_SESSION || !canSpeak) return null
  state.batchShownInRun = true
  const line = trackedLine(event, 'read_batch', batchHintText(state.serialRun))
  if (line === null) return null
  state.batchShown += 1
  state.batchVerdict = 'next_turn'
  return line
}

function onSearchMiss(event: HookEvent, state: StreakState, canSpeak: boolean): string | null {
  state.zeroHits += 1
  if (state.zeroHits < ZERO_HIT_SEARCHES_BEFORE_BRAKE || state.brakeShownInRun || state.brakeShown >= MAX_SEARCH_BRAKES_PER_SESSION || !canSpeak) return null
  state.brakeShownInRun = true
  const line = trackedLine(event, 'search_brake', searchBrakeText(state.zeroHits))
  if (line === null) return null
  state.brakeShown += 1
  state.brakeVerdict = true
  return line
}

function onReadOnlyPost(event: HookEvent, state: StreakState, kind: CallKind, now: number, canSpeak: boolean): string | null {
  state.inFlight = false
  state.lastReadPostAt = now
  if (!kind.search) return null
  const count = searchResultCount(event)
  if (count === null) return null
  if (count === 0) return onSearchMiss(event, state, canSpeak)
  state.zeroHits = 0
  state.brakeShownInRun = false
  return null
}

/** Load this agent's streak state, let `update` advance it, and store it only if it changed. */
function withStreakState(event: HookEvent, update: (state: StreakState) => string | null): string | null {
  if (!event.sessionId) return null
  const target = sessionSidecarPath(sessionStateKey(event), STREAK_SUFFIX)
  if (target === null) return null
  const state = readState(target)
  const before = JSON.stringify(state)
  const promptId = event.raw['prompt_id']
  if (typeof promptId === 'string' && promptId !== state.promptId) {
    breakStreaks(event, state)
    state.promptId = promptId
  }
  const line = update(state)
  if (JSON.stringify(state) !== before) writeState(target, state)
  return line
}

/** Advance the streaks with one pre/post tool event and return `output`, with at most one streak line appended. `now` is when the hook process started handling the event, taken before the handlers ran so their own time never stretches a gap. */
export function applyCallStreak(event: HookEvent, output: HookOutput, now: number): HookOutput {
  if (event.eventName !== 'pre_tool_use' && event.eventName !== 'post_tool_use') return output
  // A refused call never ran: it is neither part of a streak nor somewhere to speak.
  if (output.hookType === 'deny') return output
  try {
    const canSpeak = output.hookType === 'pass' || output.hookType === 'context'
    const kind = callKind(event)
    const line = withStreakState(event, (state) => {
      if (!kind.readOnly) {
        breakStreaks(event, state)
        return null
      }
      return event.eventName === 'pre_tool_use' ? onReadOnlyPre(event, state, kind, now, canSpeak) : onReadOnlyPost(event, state, kind, now, canSpeak)
    })
    if (line === null) return output
    return output.hookType === 'context' ? { ...output, context: `${output.context}\n${line}` } : contextOutput(line)
  } catch {
    return output
  }
}

/** Advance the streaks with a failed call, given the reason hooks_tool_failure.ts already classified it with; returns the brake line when a Bash search's empty exit completes a zero-hit streak. On Claude Code that exit only ever arrives here, never on PostToolUse. */
export function callStreakAfterFailure(event: HookEvent, reason: string): HookOutput | null {
  try {
    const kind = callKind(event)
    const line = withStreakState(event, (state) => {
      if (!kind.readOnly) {
        breakStreaks(event, state)
        return null
      }
      state.inFlight = false
      state.lastReadPostAt = Date.now()
      return reason === 'search_no_match' ? onSearchMiss(event, state, true) : null
    })
    return line === null ? null : contextOutput(line)
  } catch {
    return null
  }
}
