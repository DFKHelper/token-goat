/**
 * post_tool_use / pre_tool_use handlers for the Grep tool.
 *
 * Grep has no other output-side treatment anywhere in the codebase: unlike Read/Bash/WebFetch,
 * a repeated identical Grep just silently re-runs. This records each Grep's match count keyed by
 * (pattern, path, output_mode, glob) so an identical repeat later in the session, once the last
 * known match count meets hints.grep_dedup_min_matches, gets a recall-style advisory instead.
 */
import { registerHook } from './hook_registry.js'
import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { makeDedupHintHandlers, passOutput, getToolName, getToolInput, extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS } from './hooks_common.js'
import { recordGrepQuery, getGrepMatchCount } from './session.js'
import { recordStat } from './stats.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'
import { redactSecrets } from './secret_redact.js'

/** Reads a numeric Grep tool-input param (`-A`/`-B`/`-C`/`context`/`head_limit`/`offset`), tolerating
 *  a numeric string. Mirrors hooks_read.ts's readIntToolInput. */
function grepIntInput(toolInput: Record<string, unknown>, key: string): number | undefined {
  const value = toolInput[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Session-scoped identity for a Grep call: two calls with the same signature searched the
 *  same thing the same way. Returns null when there is no pattern to key on. Keys on every
 *  param that can change the output: two Greps with the same pattern/path/output_mode/glob but
 *  different case-sensitivity, context lines, or head_limit are NOT the same call. */
function grepSignature(toolInput: Record<string, unknown>): string | null {
  const pattern = toolInput['pattern']
  if (typeof pattern !== 'string' || pattern === '') return null
  const path = typeof toolInput['path'] === 'string' ? toolInput['path'] : ''
  const outputMode = typeof toolInput['output_mode'] === 'string' ? toolInput['output_mode'] : 'files_with_matches'
  const glob = typeof toolInput['glob'] === 'string' ? toolInput['glob'] : ''
  const type = typeof toolInput['type'] === 'string' ? toolInput['type'] : ''
  const caseInsensitive = toolInput['-i'] === true
  const onlyMatching = toolInput['-o'] === true
  const multiline = toolInput['multiline'] === true
  const lineNumbers = toolInput['-n'] !== false
  const contextA = grepIntInput(toolInput, '-A')
  const contextB = grepIntInput(toolInput, '-B')
  const contextC = grepIntInput(toolInput, '-C') ?? grepIntInput(toolInput, 'context')
  const headLimit = grepIntInput(toolInput, 'head_limit')
  const offset = grepIntInput(toolInput, 'offset')
  return JSON.stringify([
    pattern, path, outputMode, glob, type, caseInsensitive, onlyMatching, multiline,
    lineNumbers, contextA, contextB, contextC, headLimit, offset,
  ])
}

const { post: dedupPostHandler, pre: preGrepDedupHandler } = makeDedupHintHandlers({
  toolName: 'Grep',
  buildSignature: grepSignature,
  recordQuery: recordGrepQuery,
  getMatchCount: getGrepMatchCount,
  minMatchesConfigKey: 'grep_dedup_min_matches',
  statName: 'grep_dedup_hint',
})

/** Strict `path:lineNo:` match-line shape required of every non-empty line before content-mode
 *  folding is attempted. One line failing this bails the whole rewrite (guard 5). */
const CONTENT_LINE_RE = /^(.+?):(\d+):(.*)$/s

/** Lossless re-layout of Grep `content`-mode output: groups consecutive-in-source match lines
 *  under a single `path:` header instead of repeating the path on every line, e.g.
 *  `src/a.ts:12:x` + `src/a.ts:40:y` -> `src/a.ts` + `  12: x` + `  40: y`. Every matched line and
 *  line number survives verbatim -- this only removes the repeated path prefix, never a match.
 *  Bails to passOutput() unchanged if any of the mandatory safety guards fails (see module docs /
 *  task spec): non-`content` output_mode, `multiline`, any context flag (`-A`/`-B`/`-C`/`context`),
 *  `-n: false`, an unparseable line, fewer than 2 lines sharing a file, or the net-benefit floor. */
function foldGrepContentHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Grep') return passOutput()
    const toolInput = getToolInput(event)
    if (toolInput['output_mode'] !== 'content') return passOutput()
    if (toolInput['multiline'] === true) return passOutput()
    if (toolInput['-A'] !== undefined || toolInput['-B'] !== undefined || toolInput['-C'] !== undefined || toolInput['context'] !== undefined) {
      return passOutput()
    }
    if (toolInput['-n'] === false) return passOutput()

    // Redact at the point the match text arrives, not beside the return that emits it. The fold below replaces the tool's own result with text this handler composes, and every sibling handler that rewrites (bashoutput, taskoutput, mcp, websearch, fetch, agent) already redacts what it composes -- a lone exception here is one a future reader would trust or copy. Placing it at the entry rather than next to the single `rewriteOutput` is the whole lesson of this defect class: a second emit branch added later inherits the redaction for free, whereas one attached to a branch is exactly how the same bug has now shipped seven times. Measured at ~19 us/KB, linear -- 0.4-1.6 ms on realistic grep output, against the ~250 ms of process startup a hook invocation already pays.
    const rawText = extractToolResponseField(event.raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
    if (!rawText) return passOutput()
    const redacted = redactSecrets(rawText)
    const text = redacted.text

    const rawLines = text.split(/\r\n|\r|\n/)
    const parsed: Array<{ file: string; lineNo: string; rest: string }> = []
    for (const line of rawLines) {
      if (line.trim() === '') continue
      const m = CONTENT_LINE_RE.exec(line)
      if (!m) return passOutput()
      parsed.push({ file: m[1]!, lineNo: m[2]!, rest: m[3]! })
    }
    if (parsed.length === 0) return passOutput()

    // Group by file, preserving first-appearance order (never sorted).
    const order: string[] = []
    const groups = new Map<string, Array<{ lineNo: string; rest: string }>>()
    for (const p of parsed) {
      let group = groups.get(p.file)
      if (group === undefined) {
        group = []
        groups.set(p.file, group)
        order.push(p.file)
      }
      group.push({ lineNo: p.lineNo, rest: p.rest })
    }

    const hasSharedFile = order.some((f) => groups.get(f)!.length >= 2)
    if (!hasSharedFile) return passOutput()

    const foldedLines: string[] = []
    for (const f of order) {
      foldedLines.push(f)
      for (const { lineNo, rest } of groups.get(f)!) {
        foldedLines.push(`  ${lineNo}: ${rest}`)
      }
    }
    const rewritten = foldedLines.join('\n')

    const originalBytes = Buffer.byteLength(text, 'utf-8')
    const rewrittenBytes = Buffer.byteLength(rewritten, 'utf-8')
    if (
      !isRewriteWorthwhile({
        originalBytes,
        rewrittenBytes,
        noticeBytes: 0,
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
    ) {
      return passOutput()
    }

    const bytesDelta = originalBytes - rewrittenBytes
    recordStat('grep:fold', bytesDelta, Math.round(bytesDelta / 4))
    // The redaction itself belongs at the entry point above, so a later branch inherits it. The COUNT belongs here, because whether a redaction actually protected anything is branch- dependent in a way the redaction is not: on the `pass` returns above, the harness's own raw output is what reaches the model, so crediting a redaction there would report a protection that did not apply to what was actually shown. Only this branch emits the redacted text.
    if (redacted.count > 0) recordStat('secret_redacted', 0, redacted.count, undefined, 'grep')
    return { hookType: 'rewriteOutput', updatedOutput: rewritten }
  } catch {
    return passOutput()
  }
}

/** Combines the dedup-count recorder (unconditional side effect, always passes) with the
 *  content-mode path-folding rewrite above: the fold's rewrite wins when it fires, otherwise
 *  this falls back to whatever the dedup handler returned (always `pass`). */
function postGrepHandler(event: HookEvent): HookOutput {
  const dedupResult = dedupPostHandler(event)
  const foldResult = foldGrepContentHandler(event)
  if (foldResult.hookType === 'rewriteOutput') return foldResult
  return dedupResult
}

export { postGrepHandler, preGrepDedupHandler }

// Registered after hooks_read.ts's preReadHandler (see relay.ts import order) so a correctness-relevant deny there (node_modules, oversized file) always takes priority over this purely advisory recall hint.
registerHook('pre_tool_use', preGrepDedupHandler, { toolName: 'Grep' })
registerHook('post_tool_use', postGrepHandler, { toolName: 'Grep' })
