/**
 * Shared helpers for hook handlers (Layers 5+).
 *
 * Ports the small accessor surface of Python's `hooks_common.py`: read tool
 * name / input / file path off a {@link HookEvent}, and build the four
 * {@link HookOutput} variants. The heavier `hooks_common.py` machinery
 * (watchdog, session mutation, stat recording) belongs to later layers.
 */

import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { countRedactionPlaceholders } from './secret_redact.js'
import { loadConfig } from './config.js'

/** Return the event's tool name, or `undefined` for non-tool events. */
export function getToolName(event: HookEvent): string | undefined {
  return event.toolName
}

/** Return the event's tool input object (already defaulted to `{}` upstream). */
export function getToolInput(event: HookEvent): Record<string, unknown> {
  return event.toolInput
}

/**
 * Extract the edited/read file path from the tool input.
 *
 * Checks `file_path` first (Read/Edit/Write and most other tools), then
 * falls back to `notebook_path` (NotebookEdit's actual tool-input key) when
 * `file_path` is absent. Returns the string value when present and
 * non-empty, otherwise `undefined`. A non-string value (malformed payload)
 * is treated as absent rather than coerced.
 */
export function getFilePath(event: HookEvent): string | undefined {
  const value = event.toolInput['file_path']
  if (typeof value === 'string' && value !== '') return value
  const notebookValue = event.toolInput['notebook_path']
  return typeof notebookValue === 'string' && notebookValue !== '' ? notebookValue : undefined
}

/** Extract the working directory a hook event's wire payload carries, validated as a string. Replaces six unchecked `event.raw['cwd']` cast sites across hooks_bash.ts/hooks_session.ts/hooks_read.ts (two used `as string | undefined` with no runtime check, so a non-string cwd would throw inside runGit() and be silently swallowed by the caller's try/catch). Returns `undefined` (never a baked-in fallback) so each caller keeps its own default -- hooks_bash.ts wants `null`, hooks_read.ts wants `process.cwd()`. */
export function getCwd(event: HookEvent): string | undefined {
  const value = event.raw && typeof event.raw === 'object' ? event.raw['cwd'] : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Extract a string body from a raw hook event's `tool_response`, trying
 * `keys` in order and returning the first string value found.
 *
 * `tool_response` shapes vary by tool and harness (`output`, `body`, `text`,
 * `content` are all used by different tools) -- callers pass their own
 * priority order rather than this helper guessing one, since a shared
 * default order could silently change which field wins for a caller that
 * genuinely depends on its own priority.
 *
 * A present-but-EMPTY string does not win. Claude Code always sends both `stdout` and `stderr` for
 * Bash, so a command that wrote only to stderr arrives as `{stdout: '', stderr: '...'}`; stopping at
 * the empty `stdout` returned '' and every output-gated post-Bash path did nothing. Measured on
 * recorded harness traffic: 24 of 186,335 real Bash results. Empty means "this field carried no
 * output", which is exactly the case a later key should be allowed to answer.
 */
export function extractToolResponseField(raw: Record<string, unknown>, keys: readonly string[]): string {
  const resp = raw['tool_response']
  if (typeof resp === 'string') return resp
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>
    for (const key of keys) {
      if (typeof r[key] === 'string' && r[key] !== '') return r[key] as string
    }
  }
  return ''
}

/**
 * Shared `extractToolResponseField` key order for Bash/Grep/Read, which all prefer `output` over `body`.
 *
 * `stdout` is last but is the key Claude Code itself actually uses: its Bash `tool_response` is
 * `{stdout, stderr, interrupted, isImage, noOutputExpected}`, carrying none of the four names ahead
 * of it. Without it every post-Bash path that needs the command's output (the bash-output cache,
 * the `gh api` scope/`--jq` hints, the failing-test-runner advisory, compound-command compression)
 * read an empty string and did nothing on the harness token-goat primarily targets. It is appended
 * rather than promoted so no harness that does send `output`/`content`/`text`/`body` changes which
 * field wins.
 *
 * `stderr` is last of all, so it only answers when every earlier field is missing or empty. A
 * command that writes only to stderr (a compiler diagnostic, a linter that reports on the error
 * stream) still produced real output the post-Bash paths should see; without this the whole result
 * read as empty.
 */
export const OUTPUT_FIRST_TOOL_RESPONSE_KEYS: readonly string[] = ['output', 'content', 'text', 'body', 'stdout', 'stderr']

/**
 * Shared `extractToolResponseField` key order for WebFetch/Skill, which prefer `body` over `content`.
 *
 * `result` is appended for the same reason `stdout` is above: Claude Code's WebFetch `tool_response`
 * is `{result, url, code, codeText, bytes, durationMs}`, so the fetched page body arrives under
 * `result` and nothing else. Without it the injection scan, the secret redaction and the body cache
 * all ran against an empty string on every real fetch.
 */
export const BODY_FIRST_TOOL_RESPONSE_KEYS: readonly string[] = ['output', 'body', 'text', 'content', 'result']

/**
 * Return true when a tool_response is an MCP `CallToolResult` carrying an in-band `isError: true`
 * -- a genuine tool-level failure ("tool not found", bad params, a downstream API error surfaced
 * through MCP) rather than a hard transport failure. Such a response is still a normal, successful
 * protocol round trip, so {@link extractToolResultText} happily returns its text; every caller
 * that caches into the session dedup store must exclude it, or a one-off or transient error is
 * served back to every identical retry until the dedup window ages out.
 *
 * Lives beside extractToolResultText, not in the one hook that first needed it: the rule is a
 * condition on that function's output, and hooks_websearch.ts cached past it into the same store
 * for exactly as long as the rule lived somewhere a second caller would not think to look.
 */
export function isMcpErrorResponse(raw: Record<string, unknown>): boolean {
  const tr = raw['tool_response']
  if (!tr || typeof tr !== 'object') return false
  return (tr as Record<string, unknown>)['isError'] === true
}

/** Pull the textual result out of a tool_response payload. Handles the plain string form, the Anthropic MCP `{ content: [{type:'text', text}] }` array (also what Agent/subagent tool results carry, since HookEvent.raw's wire shape is uniform across tool types, not MCP-specific), the common `{output|text|body|content}` string fields, and finally a JSON.stringify fallback so structured results still cache. */
export function extractToolResultText(raw: Record<string, unknown>): string {
  const tr = raw['tool_response']
  if (typeof tr === 'string') return tr
  if (!tr || typeof tr !== 'object') return ''
  const resp = tr as Record<string, unknown>
  const content = resp['content']
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const text = (block as Record<string, unknown>)['text']
        if (typeof text === 'string') parts.push(text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  for (const key of ['output', 'text', 'body']) {
    if (typeof resp[key] === 'string') return resp[key] as string
  }
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(resp)
  } catch {
    return ''
  }
}

/** Build a `pass` output — let the tool call proceed unchanged. */
export function passOutput(): HookOutput {
  return { hookType: 'pass' }
}

/** Build a `deny` output — block the tool call and surface `message`. */
export function denyOutput(message: string): HookOutput {
  return { hookType: 'deny', message }
}

/** Build a `context` output — let the call proceed but inject `context`. */
export function contextOutput(context: string): HookOutput {
  return { hookType: 'context', context }
}

/**
 * What a rewrite saved, for callers that replace tool output with something smaller.
 *
 * `originalBytes` is the size of the text the model WOULD have received; the helper subtracts the
 * emitted size itself rather than trusting a caller-computed delta, so the recorded saving can
 * never disagree with the string actually returned.
 */
export interface RewriteSavings {
  /** Registered stat kind. Must appear in `stats.ts`'s KIND_TO_SOURCE or it silently files as `other`. */
  kind: string
  originalBytes: number
}

/**
 * Whether this emit is the place that books its `secret_redacted` count.
 *
 * `'count-here'` is the default and what nearly every caller wants: the placeholders in the text
 * being emitted are counted and recorded now. `'counted-elsewhere'` exists because two handlers
 * book the same count at a point that covers branches this emit does not, and counting again here
 * would double-book the identical placeholders into a number the project asks readers to believe.
 * A caller passing it must say in a comment where the count is booked instead, because a silent
 * opt-out is indistinguishable from a forgotten one.
 */
export type RedactionAccounting = 'count-here' | 'counted-elsewhere'

/**
 * Emit a `rewriteOutput` and record its accounting -- both the secrets the redaction stripped from
 * the emitted text and, when the caller passes `savings`, the bytes the rewrite removed.
 *
 * Both live here for the same reason. `postBashOutputHandler` has two rewrite returns and
 * `postTaskOutputHandler` three, and a hand-written `recordStat` beside each is the same
 * per-branch fragility in the accounting that the redaction-bypass class is in the security: the
 * branch someone adds next is the one that forgets. Routing every emit through one function means
 * a new branch accounts for itself. Both poll-diff handlers shipped with literally zero stat calls
 * of any kind, so their entire savings were invisible -- exactly that failure, already realised.
 *
 * The two halves belong in different places and this is the second one. The redaction itself goes
 * at the point the risky value ARRIVES, so a later branch inherits it -- placing it beside a single
 * emit is how the same leak has shipped seven times. But the COUNT belongs at the emit, because
 * whether a redaction protected anything is branch-dependent in a way the redaction is not: on a
 * `pass` the harness's own raw output is what reaches the model, so crediting a redaction there
 * would report a protection that did not apply to what was actually shown.
 *
 * The count comes from the emitted text rather than from the redaction's own return value, because
 * most of these branches emit only part of it -- a suffix delta, a truncated prefix, or a notice
 * that replaces the output outright. See `countRedactionPlaceholders` for why that is the honest
 * number and what it deliberately gets wrong.
 *
 * `detail` is the stat's source label (`'bashoutput'`, `'taskoutput'`, ...), matching the `subdir`
 * argument the disk-cache path passes so both surfaces group the same way in `token-goat stats`.
 */
export function emitRewrite(
  updatedOutput: string,
  detail: string,
  savings?: RewriteSavings,
  redaction: RedactionAccounting = 'count-here',
): HookOutput {
  if (redaction === 'count-here') {
    const count = countRedactionPlaceholders(updatedOutput)
    if (count > 0) recordStat('secret_redacted', 0, count, undefined, detail)
  }
  if (savings !== undefined) {
    const bytesSaved = savings.originalBytes - Buffer.byteLength(updatedOutput, 'utf-8')
    // Only a positive delta is recorded. Every caller sits behind an `isRewriteWorthwhile` gate so this should always hold, but a stat kind that can log a negative saving silently corrupts every total that sums it, and the gate is a separate line a future edit could reorder.
    if (bytesSaved > 0) recordStat(savings.kind, bytesSaved, savedTokensFromBytes(bytesSaved))
  }
  return { hookType: 'rewriteOutput', updatedOutput }
}

/**
 * {@link emitRewrite}, except a rewrite that would emit exactly `original` passes through instead.
 *
 * The fence and the redaction are both unconditional now, so the third-party-content hooks build
 * their emitted string first and only then know whether anything actually changed. Rewriting the
 * harness's output with a byte-identical copy is not free: it makes a larger hook response, it
 * stops `hookType` distinguishing "we changed this" from "we looked at this", and it would defeat
 * the `injection.enabled` opt-out, whose whole point is that a user who switches the subsystem off
 * gets the untouched output back.
 */
export function emitRewriteIfChanged(original: string, emitted: string, detail: string): HookOutput {
  if (emitted === original) return passOutput()
  return emitRewrite(emitted, detail)
}

/** Non-empty lines in `text`, used as a match-count proxy for tools whose output is a flat
 *  newline-separated list (one line per matched file/line/path). Shared by Grep and Glob's
 *  dedup-hint handlers via {@link makeDedupHintHandlers}. */
export function countNonEmptyLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length
}

/**
 * Estimate the number of results (files/matches) in a Grep/Glob tool_response body, for the
 * session dedup-hint recall count (see {@link makeDedupHintHandlers}).
 *
 * Claude Code's Grep tool prefixes `files_with_matches`-mode output with a `Found N file(s)` /
 * `No files found` summary line -- confirmed against real transcript logs, e.g. `"Found 4
 * files\nsrc\\a.ts\nsrc\\b.ts\n..."` and `"No files found"`/`"Found 1 file\nsrc\\a.ts"`. That
 * summary line is not itself a match: counting it via {@link countNonEmptyLines} silently
 * inflated every non-empty `files_with_matches` result by exactly one, and misreported a
 * genuinely empty result ("No files found", one line) as "1 match" -- the tests backing this
 * dedup hint only ever fed it a synthetic bare file list with no header line, so the mismatch
 * with Claude Code's real wire format went uncaught (the same injected-seam trap CLAUDE.md's
 * "Critical path" section warns about). When present, the summary line's own count is
 * authoritative and used directly, immune to any other line Claude Code adds after it;
 * everything else (Grep's `content`/`count`-mode output, Glob's plain path list -- neither has
 * this header) falls back to {@link countNonEmptyLines} unchanged.
 */
export function estimateResultCount(text: string): number {
  const firstLine = text.split(/\r\n|\r|\n/).find((line) => line.trim().length > 0)
  if (firstLine !== undefined) {
    const trimmed = firstLine.trim()
    if (/^No (?:files|matches) found\.?$/i.test(trimmed)) return 0
    const found = /^Found (\d+) (?:files?|matches?)\.?$/i.exec(trimmed)
    if (found) return Number.parseInt(found[1]!, 10)
  }
  return countNonEmptyLines(text)
}

/**
 * Build the `post_tool_use` / `pre_tool_use` handler pair backing a tool's session-scoped
 * "you already ran this exact query, here's the recall count" advisory hint.
 *
 * Factors out the identical handler bodies shared by Grep and Glob (see hooks_grep.ts /
 * hooks_glob.ts): both record each call's match count keyed by a tool-specific signature, then on
 * a later identical call whose recorded match count meets a tool-specific config threshold, emit
 * a context advisory instead of letting the call silently re-run. The signature shape itself
 * (`buildSignature`) stays genuinely tool-specific and is supplied by the caller, not shared.
 */
export function makeDedupHintHandlers(opts: {
  toolName: string
  buildSignature: (toolInput: Record<string, unknown>) => string | null
  recordQuery: (signature: string, matchCount: number) => void
  getMatchCount: (signature: string) => number | null
  minMatchesConfigKey: 'grep_dedup_min_matches' | 'glob_dedup_min_matches'
  statName: string
}): { post: (event: HookEvent) => HookOutput; pre: (event: HookEvent) => HookOutput } {
  const post = (event: HookEvent): HookOutput => {
    try {
      if (getToolName(event) !== opts.toolName) return passOutput()
      const signature = opts.buildSignature(getToolInput(event))
      if (signature === null) return passOutput()
      const text = extractToolResponseField(event.raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
      opts.recordQuery(signature, estimateResultCount(text))
      return passOutput()
    } catch {
      return passOutput()
    }
  }

  const pre = (event: HookEvent): HookOutput => {
    try {
      if (getToolName(event) !== opts.toolName) return passOutput()
      const toolInput = getToolInput(event)
      const signature = opts.buildSignature(toolInput)
      if (signature === null) return passOutput()
      const priorCount = opts.getMatchCount(signature)
      if (priorCount === null) return passOutput()
      if (priorCount < loadConfig().hints[opts.minMatchesConfigKey]) return passOutput()

      recordStat(opts.statName, 0, 0)
      const pattern = typeof toolInput['pattern'] === 'string' ? toolInput['pattern'] : ''
      return contextOutput(
        'Note: an identical ' + opts.toolName + ' for "' + pattern + '" already ran this session and returned ' +
          priorCount + (priorCount === 1 ? ' match' : ' matches') +
          '. If that result already answers this, you can skip re-running it.',
      )
    } catch {
      return passOutput()
    }
  }

  return { post, pre }
}
