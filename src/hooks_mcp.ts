/** MCP read-tool caching hooks. post_tool_use: persist a read-only `mcp__*` result into the shared bash-output store. pre_tool_use: when an identical read-only `mcp__*` call was already cached this session, deny it and point at `token-goat bash-output <id>` so the model recalls a slice instead of paying the round trip again. Both handlers register with no toolName filter (MCP tool names are dynamic) and self-gate on {@link isMcpReadOnly} plus a present sessionId, so they are inert for every non-MCP and mutating tool. */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, denyOutput, extractToolResultText, isMcpErrorResponse, emitRewrite, emitRewriteIfChanged, mcpContentBlocks, isTextualContentBlock, withPreservedBlocks } from './hooks_common.js'
import { isMcpReadOnly, getMcpOutput, mcpOutputBytes, storeMcpOutput, MCP_READ_TOOL_PATTERN } from './mcp_cache.js'
import { PER_FILE_COUNTERFACTUAL_CEILING } from './util.js'
import { loadConfig } from './config.js'
import { compressMcpResult, MCP_COMPRESS_MIN_BYTES } from './mcp_compress.js'
import { compressMcpResultWithPacks } from './mcp_compress_packs.js'
import { redactSecrets } from './secret_redact.js'
import { UNTRUSTED_TOOL_TAG } from './injection_scan.js'
import { scanAndRecord, fenceWithMatches } from './untrusted_fence.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'
import { bashOutputCapBytes, fitToDeliveryCap } from './delivery_cap.js'
import { MCP_TOOL_PATTERN, PLAYWRIGHT_TOOL_RE } from './mcp_tool_pattern.js'
import { hintTarget } from './hint_target.js'
import { quotedArg } from './hint_suggestion_guard.js'
import { browserResultBlocks } from './hooks_browser_image.js'

export const MCP_OVERSIZED_THRESHOLD_BYTES = 25_000

/** Appended inside the fence when an MCP preview had to be cut to stay under {@link MCP_OVERSIZED_THRESHOLD_BYTES}. */
const MCP_PREVIEW_NOTE = '\n\n...[preview truncated by token-goat; use mcp-output above to query full payload]...'

/** The most bytes an MCP rewrite may come to, wherever the harness has a measured cap: one under the size at which it spills an MCP result and keeps only a preview, which would end before the fence's closing tag. Both oversized previews are framed and measured through fitToDeliveryCap against this, notice, fence and truncation note included, rather than priced with a fixed 500 bytes for the fence: escaping a body dense in markers can double it, and a 60 KB result of `[tg]` lines shipped at 34,920 bytes. */
function mcpSpillBytes(): number | null {
  // TOKEN_GOAT_MCP_COMPRESS=0 turns off every rewrite here that shortens a result, and the whole-result fence must keep honouring it.
  if (process.env['TOKEN_GOAT_MCP_COMPRESS'] === '0') return null
  return bashOutputCapBytes() === null ? null : MCP_OVERSIZED_THRESHOLD_BYTES - 1
}

const TOKEN_GOAT_MCP_TOOL_NAMES = new Set([
  'read',
  'symbol',
  'section',
  'outline',
  'skeleton',
  'refs',
  'brief',
  'map',
  'changed',
  'grep',
  'imports',
  'exports',
  'semantic',
  'index_status',
  'handoff_create',
  'handoff_apply',
  'retrieve_text',
])

/** Returns true if the tool belongs to token-goat's own local MCP server. Token-goat is a local companion process indexing the user's workspace files, not an external third-party remote API. Its tool results must not be fenced as untrusted remote payloads, which triggers prompt-injection refusals in LLMs. */
export function isTokenGoatMcpTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  let rest = lower
  if (rest.startsWith('mcp__')) {
    rest = rest.slice(5)
  } else if (rest.startsWith('mcp_')) {
    rest = rest.slice(4)
  } else {
    if (lower.startsWith('token_goat_') || lower.startsWith('token-goat-') || lower.startsWith('tg_')) {
      const tool = lower.replace(/^(token_goat_|token-goat-|tg_)/, '')
      return TOKEN_GOAT_MCP_TOOL_NAMES.has(tool)
    }
    return false
  }

  const sepIdx = rest.indexOf('__')
  let server = ''
  let tool = ''
  if (sepIdx !== -1) {
    server = rest.slice(0, sepIdx)
    tool = rest.slice(sepIdx + 2)
  } else {
    const singleIdx = rest.indexOf('_')
    if (singleIdx !== -1) {
      server = rest.slice(0, singleIdx)
      tool = rest.slice(singleIdx + 1)
    }
  }

  const isTgServer =
    server === 'token_goat' ||
    server === 'token-goat' ||
    server === 'tg' ||
    server === 'token_goat_mcp' ||
    server === 'token-goat-mcp'

  return isTgServer && TOKEN_GOAT_MCP_TOOL_NAMES.has(tool)
}

// Defined in hooks_common.ts alongside extractToolResultText, whose output the rule is about, and re-exported here because this module was its only caller for a while.
export { isMcpErrorResponse } from './hooks_common.js'

function preMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !event.sessionId || isTokenGoatMcpTool(toolName)) return passOutput()
  const toolInput = getToolInput(event)
  if (!isMcpReadOnly(toolName, toolInput)) return passOutput()
  const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
  const id = getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)
  if (!id) return passOutput()
  // The denied call never runs, so its result never reaches the model a second time. Credit that blocked re-arrival the way preSkillHandler credits a blocked skill re-load: the cached entry's stored (redacted) size, capped at PER_FILE_COUNTERFACTUAL_CEILING because the counterfactual being priced is a response that would itself have been truncated. The full raw result is the right counterfactual here specifically because postMcpHandler returns early on a cache hit (see its getMcpOutput guard), so the allowed second call would have shipped the result uncompressed. No sibling stat double-counts these bytes: mcp:compress only ever fires on a call that actually ran, which this deny prevents.
  const denyCredit = Math.min(mcpOutputBytes(id), PER_FILE_COUNTERFACTUAL_CEILING)
  recordStat('mcp:recall', denyCredit, savedTokensFromBytes(denyCredit))
  return denyOutput(
    'Identical read-only MCP call already cached this session. Use `token-goat bash-output ' +
      id +
      '` to recall the result (add `--grep PATTERN`, `--tail N`, or `--head N` to slice) instead of repeating the call.',
  )
}

/** `raw` with its result's block array replaced by `blocks`, keeping the wrapper object (and its `isError` flag) when the result arrived wrapped. */
function withResultBlocks(raw: Record<string, unknown>, blocks: readonly Record<string, unknown>[]): Record<string, unknown> {
  const tr = raw['tool_response']
  return { ...raw, tool_response: Array.isArray(tr) ? blocks : { ...(tr as Record<string, unknown>), content: blocks } }
}

async function postMcpHandler(event: HookEvent): Promise<HookOutput> {
  const toolName = getToolName(event)
  if (!toolName || !toolName.startsWith('mcp__') || isTokenGoatMcpTool(toolName)) return passOutput()
  const toolInput = getToolInput(event)
  // The browser pass runs first, on the blocks as they arrived: it shrinks or withholds each screenshot and shortens a repeated tab list, and everything below then fences and compresses the text that is left. It used to be a handler of its own registered after this one, and this one claims every result that carries text, so a screenshot with a caption or a tab list beside it was never shrunk.
  const browser = await browserResultBlocks(event)
  const raw = browser === null ? event.raw : withResultBlocks(event.raw, browser.blocks.filter((b) => !browser.own.has(b)))
  const resultText = extractToolResultText(raw)
  if (!resultText) {
    if (browser === null) return passOutput()
    // An image-only result: nothing of the server's to fence, only token-goat's notes and the smaller images. Its textual blocks are dropped by the same filter the fenced path uses below: one can still reach here carrying words blocksToText does not read (a resource_link whose only text is its `title`), and shipping the block array whole put those words in front of the model outside any fence.
    const notes = emitRewrite([...browser.own].map((b) => String(b['text'])).join('\n'), 'mcp')
    return notes.hookType === 'rewriteOutput' ? { ...notes, updatedBlocks: browser.blocks.filter((b) => browser.own.has(b) || !isTextualContentBlock(b)) } : notes
  }
  // An MCP result is a remote server's output: the least trusted text in the pipeline, and the one surface a page-only injection scan never covered. Scanned before every early return below, because each of those returns was a way for the same hostile text to reach the model unmarked: an in-band error response carries text just as a success does, a harness that omits the session id still shows the model the result, and the read-only dedup return fires on the SECOND of two identical calls -- whose result a hostile or time-varying server is free to make different from the first. Caching is what those guards exist to gate; the fence is not.
  const injectionMatches = scanAndRecord(resultText)
  // Redact secrets on this same live path, computed once here ahead of every early-return guard below -- an MCP result carrying a bare credential (an API key in an env-dump tool's output, a PAT sitting in a commit message) trips no injection pattern at all, so gating redaction on injectionMatches (as fenced() alone used to) would leave every non-fenced return -- no session id, an in-band MCP error, a dedup cache hit, and the terminal "compression did not fire or did not pay off" return below -- shipping it unredacted. Mirrors postWebSearchHandler's and postFetchHandler's fix for the same gap.
  const redactedResult = redactSecrets(resultText)
  // Every block whose payload no string can stand in for. The rewrite below replaces the tool result with one fenced text block, which represents each textual block completely (see isTextualContentBlock) but would drop an image, an audio clip or a blob resource outright -- measured: a mixed text+image MCP result came back as a bare string with its 220 KB picture simply gone. Computed once here, beside the text every branch shares, so a branch added later inherits it rather than forgetting it.
  // token-goat's own notes from the browser pass ride here too, beside the image each describes, so they stay outside the fence.
  const preserved = (browser?.blocks ?? mcpContentBlocks(event.raw) ?? []).filter((b) => browser?.own.has(b) === true || !isTextualContentBlock(b))
  const preserve = (output: HookOutput): HookOutput => withPreservedBlocks(output, preserved)
  // Fitted under the spill size like both previews below: a server that flags its own reply as an error, a repeated read-only call and a result too large to cache all came back fenced whole, a 60 KB result of `[tg]` lines at 100,912 bytes, where a spill keeps a preview that ends before the closing tag. The note on a cut sits outside the closing tag and names the cached copy when there is one.
  const fenced = (cachedId: string | null): HookOutput => {
    const note =
      cachedId === null
        ? '\n[token-goat: result cut to fit under the size the harness spills an MCP result at; it was not cached, so the rest cannot be recalled]'
        : `\n[token-goat: result cut to fit under the size the harness spills an MCP result at; the cached copy of this call is ${cachedId}, and \`token-goat mcp-output ${cachedId} --head 50\` reads it in slices]`
    return preserve(
      emitRewriteIfChanged(
        resultText,
        fitToDeliveryCap(redactedResult.text, (body, clipped) => fenceWithMatches(body, injectionMatches, UNTRUSTED_TOOL_TAG) + (clipped ? note : ''), mcpSpillBytes()),
        'mcp',
      ),
    )
  }
  // Unconditional: an MCP result is a remote server's output by provenance, so it is fenced whether or not the eight deliberately-narrow patterns matched. It used to pass through unfenced on a clean scan, which meant any payload those patterns miss reached the model unmarked -- the fence's whole job is to survive a miss. The scan result now only decides whether the notice names pattern(s).
  const passOrFence = (cachedId: string | null = null): HookOutput => fenced(cachedId)

  if (!event.sessionId) return passOrFence()
  const compressionEnabled = process.env['TOKEN_GOAT_MCP_COMPRESS'] !== '0'
  // Computed ahead of the error and dedup returns below, though only the compression branch uses it, because the Playwright pass also records the `Open tabs` list this result carries as the last one shown. Each of those returns ships this list in full, so a record taken only on the compression branch would miss a list the model did see, and the next result could then be collapsed as "unchanged" against an older list. Fed the redacted text, like every other compression step here.
  // Imported only for a Playwright tool, which keeps the pass out of the hook entry's eager set: every other MCP result, and every non-MCP tool call, would parse it and never run it. A failed import skips the pass rather than throwing: a resident hook server outlives the rebuild that renames its chunks, and a throw here would hand the result through unfenced.
  const playwright = compressionEnabled && PLAYWRIGHT_TOOL_RE.test(toolName) ? await import('./mcp_compress_playwright.js').catch(() => null) : null
  const sectioned = playwright ? playwright.compressPlaywrightResult(toolName, toolInput, redactedResult.text) : null
  // An in-band MCP error is a valid response, not a cacheable one - never let a transient or now-resolved failure block every later identical retry.
  if (isMcpErrorResponse(event.raw)) return passOrFence()
  const readOnly = isMcpReadOnly(toolName, toolInput)
  // Caching/dedup remains strictly read-only-gated: a mutating or non-idempotent call (e.g. a browser-automation `take_snapshot`, which trips MUTATING_VERBS_RE's `snapshot` token even though its result is compressible) must never be served back to a later identical pre_tool_use call, since its output can legitimately differ call to call.
  let id: string | null = null
  if (readOnly) {
    const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
    // Idempotent: a re-fired post for an already-cached, still-fresh call writes nothing.
    const cachedId = getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)
    if (cachedId !== null) return passOrFence(cachedId)
    id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
  }
  // Deterministic structural compression (see mcp_compress.ts and mcp_compress_packs.ts) is gated on compressibility, not on cache-eligibility: it used to require id !== null (i.e. the call was already read-only-cached), which silently excluded every non-idempotent tool a compression pack was written for -- e.g. chrome-devtools-mcp's take_snapshot, which trips MUTATING_VERBS_RE's `snapshot` token, never reached mcp_compress_packs.ts's dedicated browser-snapshot pack in production even though that pack exists specifically for it. Size-gated so small results are never touched, and opt-out (not opt-in) via TOKEN_GOAT_MCP_COMPRESS=0 to match TOKEN_GOAT_BASH_COMPRESS's existing convention elsewhere in this codebase. Per-server packs run first (GitHub, browser-automation): a schema-aware pack strips known boilerplate before handing the result to the same generic table-ifying pass. When no pack matches or pays off, the generic pass runs on the untransformed text exactly as before the packs existed.
  if (compressionEnabled) {
    // Compress the already-redacted text (redactedResult, computed above before every early return), not raw resultText. mcp_compress_packs.ts's truncateSnapshotLine (and any other per-field truncation inside a pack or the generic compressor) can cut a credential mid-value; if that truncation runs on raw text before redaction, the surviving fragment can fall under a pattern's minimum-length floor and ship raw on this live, model-visible rewrite -- the same mechanism as the confirmed mcpInputPreview/tool_filters bugs. Feeding compression the pre-redacted text means every truncation point inside it only ever cuts placeholder text. The packs and the generic pass keep the size floor and run on the Playwright pass's output when it fired; the Playwright pass alone does not, since what it removes is a repeat of what the model already holds, worth dropping at any size.
    const base = sectioned ?? redactedResult.text
    const packed = resultText.length >= MCP_COMPRESS_MIN_BYTES ? (compressMcpResultWithPacks(toolName, base) ?? compressMcpResult(base)) : null
    const compressed = packed ?? sectioned
    if (compressed !== null) {
      // A mutating/non-idempotent call was never cached above (readOnly is false), but the "full via mcp-output <id>" label still needs somewhere to resolve, so store it now purely for recall -- this never feeds preMcpHandler's dedup check, which independently re-gates on isMcpReadOnly.
      if (id === null) id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
      if (id !== null) {
        // Defense-in-depth re-pass, normally a no-op now that compression consumes already-redacted text above: neither mcp_compress.ts nor mcp_compress_packs.ts run their own redaction, so this still catches any redaction-shaped text a pack's own transform might introduce.
        const redactedBody = redactSecrets(compressed).text
        const notice = `[token-goat: compressed, full via mcp-output ${id}]\n`
        // Net-benefit gate (shared with bash_runner's filter pipeline, see tool_filters/base.ts::isRewriteWorthwhile): a rewrite that barely beats the original after paying for its own notice destabilises bytes that could otherwise be served from the provider's cached prefix for no real gain -- below the floor, ship resultText untouched instead.
        const originalBytes = Buffer.byteLength(resultText, 'utf-8')
        const worthwhile = isRewriteWorthwhile({
          originalBytes,
          rewrittenBytes: Buffer.byteLength(redactedBody, 'utf-8'),
          noticeBytes: Buffer.byteLength(notice, 'utf-8'),
          minNetSavingsBytes: resolveMinNetSavingsBytes(),
        })
        if (worthwhile) {
          // If the compressed output is still oversized for the harness, clip the preview to avoid tool spill to content.json
          // MCP compression shipped for releases without recording anything, so the whole mechanism was invisible in `token-goat stats` even though the `mcp:` prefix was already registered in KIND_TO_SOURCE. Credited through emitRewrite's savings parameter rather than a hand-written recordStat beside the emit, because that parameter measures the emitted string itself -- notice, fence and redaction placeholders included -- which is the only figure that describes what the model was actually spared. A recordStat here would have to re-derive that per branch and would drift the moment either branch changed, which is exactly how the WebFetch over-report happened. Fenced on the same unconditional provenance rule as passOrFence above: a compressed result is still the remote server's text, and a clean scan is not evidence it is safe.
          return preserve(
            emitRewrite(
              fitToDeliveryCap(redactedBody, (body, clipped) => `${notice}${fenceWithMatches(clipped ? body + MCP_PREVIEW_NOTE : body, injectionMatches, UNTRUSTED_TOOL_TAG)}`, mcpSpillBytes()),
              'mcp',
              { kind: 'mcp:compress', originalBytes },
            ),
          )
        }
      }
    }
  }
  // Reached when compression did not fire or did not pay off. Oversized MCP result recovery: when a raw result is >= MCP_OVERSIZED_THRESHOLD_BYTES, Claude Code's internal harness will spill it to disk (e.g. content.json) and recommend reading it with read_file, bypassing surgical read discipline. Intercept by storing the full raw payload in the cache and returning a recovery notice with exact mcp-output query commands plus a clipped preview.
  const rawBytes = Buffer.byteLength(resultText, 'utf-8')
  if (rawBytes >= MCP_OVERSIZED_THRESHOLD_BYTES && process.env['TOKEN_GOAT_MCP_COMPRESS'] !== '0') {
    if (id === null) id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
    if (id !== null) {
      // A heading or top-level key the payload really carries, double-quoted as hint_target.ts vetted it; this rewrite never passes the relay's suggestion guard, so the vetting is the only check it gets. A slice with nothing real to name is left out: the `'<path>'`, `'<heading>'` and `'<regex>'` stand-ins it used to print ran as queries for parts no payload holds.
      const heading = hintTarget('', 'section', { content: redactedResult.text })
      const key = hintTarget('payload.json', 'key', { content: redactedResult.text })
      const notice =
        `[token-goat: oversized MCP result (${rawBytes} bytes) cached as ${id}]\n` +
        `The full payload was cached to prevent harness context spill. Slicing commands:\n` +
        (key.real && /^[\w-]+$/.test(key.name) ? `  token-goat mcp-output ${id} --json-query ${quotedArg(key.name)}\n` : '') +
        (heading.real ? `  token-goat mcp-output ${id} --section ${quotedArg(heading.name)}\n` : '') +
        `  token-goat mcp-output ${id} --head 50\n\n`
      return preserve(
        emitRewrite(
          fitToDeliveryCap(redactedResult.text, (body, clipped) => `${notice}${fenceWithMatches(clipped ? body + MCP_PREVIEW_NOTE : body, injectionMatches, UNTRUSTED_TOOL_TAG)}`, mcpSpillBytes()),
          'mcp',
          { kind: 'mcp:oversized', originalBytes: rawBytes },
        ),
      )
    }
  }

  // The fence is a security action, not a compression one, so it must not inherit the size floor, the opt-out env var, or the net-benefit gate above -- a short hostile result is exactly the case those would drop.
  return passOrFence(id)
}

// preMcpHandler acts only on a call isMcpReadOnly passes, and MCP_READ_TOOL_PATTERN matches every such name (see its doc comment), so PreToolUse no longer starts a hook process for each navigate, click or create_draft: all 1,409 measured PreToolUse runs on mcp__* tools under the bare prefix printed `{}`. postMcpHandler fences and compresses nearly every MCP result, so it keeps the whole `mcp__` prefix.
registerHook('pre_tool_use', preMcpHandler, { toolPattern: MCP_READ_TOOL_PATTERN })
registerHook('post_tool_use', postMcpHandler, { toolPattern: MCP_TOOL_PATTERN })
