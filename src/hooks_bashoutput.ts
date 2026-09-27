/** BashOutput poll-delta caching hook, and the poll pipeline hooks_taskoutput.ts runs TaskOutput through. `BashOutput` polls the accumulated stdout/stderr of a `run_in_background` Bash command by `bash_id`. Each poll typically re-emits the ENTIRE output captured so far, not just what's new since the previous poll -- the caller already saw the earlier prefix on the prior poll, so repeating it is pure waste for a long-running or chatty background command. post_tool_use only: caches the last-seen output per `(sessionId, bash_id)` in the shared bash-output blob store (same disk-backed store `mcp_cache.ts` uses for the same reason -- each hook invocation is a fresh process, so only a cross-process store lets a later poll see what an earlier poll cached). On a repeat poll where the new output is the old output plus a suffix, rewrites the tool result to just that suffix via `rewriteOutput` -- mirroring `hooks_mcp.ts`'s compression rewrite, not `hooks_bash_post.ts`'s `summarizeOutputDelta` (that one emits an additive line-count *summary* alongside the untouched full text, because a rerun command's earlier output is a distinct, still-relevant prior result; here the accumulated prefix is the SAME text the caller already received, so it is genuinely redundant and safe to replace rather than merely annotate). No pre_tool_use handler: BashOutput's `tool_input` carries only `bash_id` (and an optional output-size-limiting `filter`), nothing worth denying or annotating before the poll runs -- the only useful work happens once the fresh output is known, in the post handler. */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, extractToolResultText, emitRewrite } from './hooks_common.js'
import { shortFingerprint } from './fingerprint.js'
import { storeBlob } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR, getBashOutput, type BashOutputEntry } from './bash_output_cache.js'
import { loadConfig } from './config.js'
import { redactSecrets } from './secret_redact.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes, pytestFilter, looksLikePytestOutput } from './tool_filters/index.js'
import { UNTRUSTED_TOOL_TAG } from './injection_scan.js'
import { fenceUntrusted } from './untrusted_fence.js'

interface PollToolShape {
  /** Snapshot blob-id prefix, distinct per tool so a `bash_id` and a `task_id` spelled alike never share a snapshot. */
  readonly blobPrefix: string
  /** The id argument the markers name. */
  readonly idArg: string
  /** Compaction for the part a repeat poll added. */
  readonly compactDelta: (delta: string) => string
}

/** A background-output poller run through {@link rewritePoll}. `channel` is the stat channel, and also the fingerprint tag and command prefix of the stored snapshot. Only TaskOutput compacts a first poll, the one poll with no snapshot to diff against, so only it carries `compactFirst`. */
export type PollTool = (PollToolShape & { readonly channel: 'bashoutput' }) | (PollToolShape & { readonly channel: 'taskoutput'; readonly compactFirst: (output: string) => string })

/** Deterministic, session-scoped recall id for a poll snapshot -- mirrors `mcpOutputId` in mcp_cache.ts. Fingerprinting `${sessionId}\x00${channel}\x00${pollId}` keeps the id within the blob store's id budget and scopes the cache per session, so two sessions polling the same id never cross-pollinate. */
function pollCacheId(tool: PollTool, sessionId: string, pollId: string): string {
  return `${tool.blobPrefix}_${shortFingerprint(`${sessionId}\x00${tool.channel}\x00${pollId}`)}`
}

/** Persist `output` as the last-seen snapshot under `id`. */
function storePollSnapshot(tool: PollTool, id: string, pollId: string, output: string): void {
  const entry: BashOutputEntry = {
    id,
    command: `${tool.channel}:${pollId}`,
    output,
    exitCode: 0,
    storedAt: Date.now(),
    sizeBytes: Buffer.byteLength(output, 'utf-8'),
  }
  storeBlob(BASH_OUTPUT_SUBDIR, id, entry)
}

/** Rewrite one poll of `tool` against the snapshot the previous poll of `pollId` left. A first poll passes through (TaskOutput compacts it first), an unchanged repeat becomes a one-line marker, and a repeat that extends the snapshot is cut to the part it added; anything else passes through. Every poll becomes the next one's snapshot. */
export function rewritePoll(tool: PollTool, sessionId: string, pollId: string, rawOutput: string): HookOutput {
  if (!rawOutput) return passOutput()
  // Redact before any comparison/storage, not just at the storeBlob() choke point: storeBlob (disk_cache.ts) already redacts secret-shaped tokens before persisting, so a `prior` value recovered from disk on a later poll (a near-certainty -- hooks run as a fresh process per call, so there is no living in-memory cache to hit instead) is always the REDACTED text. Diffing that against a still-raw `output` desyncs the startsWith()/slice() append-check the instant a secret-shaped token appears anywhere in the accumulated output, permanently falling through to the "buffer reset" branch on every later poll for this id. Redacting here keeps both sides of every comparison on equal footing, mirroring the redact-before-compare pattern `storeBashOutput` already applies for the same reason.
  const output = redactSecrets(rawOutput).text
  if (!output) return passOutput()
  // originalBytes is the RAW length, not the redacted one: a `pass` hands the model the harness's own untouched output, so raw-minus-emitted is what this rewrite actually kept out of the context. The redacted length is the wrong baseline in the over-reporting direction, because a placeholder is frequently longer than the secret it replaces (`[REDACTED:aws_access_key]` is 25 bytes for a 20-byte key), which would credit this handler for bytes the redaction added.
  const originalBytes = Buffer.byteLength(rawOutput, 'utf-8')
  const outputBytes = Buffer.byteLength(output, 'utf-8')

  const id = pollCacheId(tool, sessionId, pollId)
  const prior = getBashOutput(id)
  const minBytes = loadConfig().bash_compress.cache_min_bytes
  storePollSnapshot(tool, id, pollId, output)

  if (prior === null) {
    // First poll ever seen for this id this session -- nothing to diff against yet. A TaskOutput payload can still carry a within-payload line-repeat storm (a single warning line repeated 247 times has been observed in one poll), so it gets the same collapse its deltas do. The snapshot above keeps the uncollapsed output, since the next poll diffs against what the tool actually sent.
    if (tool.channel === 'bashoutput') return passOutput()
    const collapsed = tool.compactFirst(output)
    if (collapsed === output) return passOutput()
    const collapsedBytes = Buffer.byteLength(collapsed, 'utf-8')
    if (outputBytes - collapsedBytes < minBytes) return passOutput()
    // Net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, shared with bash_runner's filter pipeline): the collapse has no separate notice/marker text (the collapsed body IS the replacement), so noticeBytes is 0, but routing through the same shared check keeps this path's "worth it" decision identical in shape to every other one.
    if (!isRewriteWorthwhile({ originalBytes: outputBytes, rewrittenBytes: collapsedBytes, noticeBytes: 0, minNetSavingsBytes: resolveMinNetSavingsBytes() })) return passOutput()
    return emitRewrite(collapsed, 'taskoutput', { kind: 'taskoutput:collapse', originalBytes })
  }

  // The floor asks whether the output being replaced is big enough to bother, and never how much is new: both rewrites below drop the whole snapshot, so a 20-byte addition to a 50 KB output is the largest saving a delta sees, not the smallest.
  if (outputBytes < minBytes) return passOutput()

  if (output === prior.output) {
    // Unchanged since the last poll: the caller gains nothing from seeing the same accumulated text again, so it becomes a short no-new-output marker instead -- see the module docstring for why replacing (not just annotating) is safe here.
    const unchangedNotice = `[token-goat: ${tool.idArg} ${pollId} unchanged since last poll -- no new output]`
    // Net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, shared with bash_runner's filter pipeline): cache_min_bytes above only answers "is the input big enough to bother" -- this separately confirms the marker itself doesn't eat the whole saving before shipping the rewrite.
    if (!isRewriteWorthwhile({ originalBytes: outputBytes, rewrittenBytes: 0, noticeBytes: Buffer.byteLength(unchangedNotice, 'utf-8'), minNetSavingsBytes: resolveMinNetSavingsBytes() })) return passOutput()
    // Each kind is spelled out whole at its emit site, which is where the stat-kind guards read it.
    return tool.channel === 'bashoutput'
      ? emitRewrite(unchangedNotice, 'bashoutput', { kind: 'bashoutput:unchanged', originalBytes })
      : emitRewrite(unchangedNotice, 'taskoutput', { kind: 'taskoutput:unchanged', originalBytes })
  }

  // The new output isn't a simple append of the cached snapshot (e.g. the harness rotated or reset the buffer) -- a suffix diff would misrepresent the result, so the fresh output passes through untouched as the new baseline.
  if (!output.startsWith(prior.output)) return passOutput()

  const deltaNotice = `[token-goat: ${tool.idArg} ${pollId} delta since last poll]\n`
  // The delta is the poller's own bytes and the notice above them is ours, so the two need a boundary the model can see: without one, a background process (or a subagent that read a hostile page) that prints a line in the marker's shape is writing text the model reads as token-goat's. The notice stays outside the opening tag, matching every other substitution site -- our voice never rides inside the fence, both because that is the ambiguity the fence exists to remove and because the marker neutraliser would escape it.
  const fenced = fenceUntrusted(tool.compactDelta(output.slice(prior.output.length)), UNTRUSTED_TOOL_TAG)
  const body = `${deltaNotice}${fenced}`
  // Priced on the string actually emitted rather than on the delta plus the notice: the fence is ~120 bytes this rewrite spends, and pricing it as though it were free is how a rewrite ships that costs more than it saves.
  if (!isRewriteWorthwhile({ originalBytes: outputBytes, rewrittenBytes: Buffer.byteLength(body, 'utf-8'), noticeBytes: 0, minNetSavingsBytes: resolveMinNetSavingsBytes() })) return passOutput()
  return tool.channel === 'bashoutput'
    ? emitRewrite(body, 'bashoutput', { kind: 'bashoutput:delta', originalBytes })
    : emitRewrite(body, 'taskoutput', { kind: 'taskoutput:delta', originalBytes })
}

/** BashOutput's tool_input `bash_id` field (per Claude Code's documented BashOutput schema -- the only other producer of this key is the Copilot CLI shim, which mirrors read_bash/read_powershell's `shellId` onto it deliberately, so this is still the best-understood wire shape for Claude Code rather than a verified one). Returns undefined for anything missing/non-string/empty. */
function getBashId(toolInput: Record<string, unknown>): string | undefined {
  const value = toolInput['bash_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A long-running pytest run polled repeatedly delivers each delta as more dots/percentage rows, never the whole run again -- so a delta goes through the same pytest filter real `pytest` commands compress through, gated on a content sniff (no argv is available here to match ToolFilter.matches against) so this only fires on a delta that actually looks like pytest progress noise, not an arbitrary background command's output. */
function compactPytestDelta(delta: string): string {
  if (!looksLikePytestOutput(delta)) return delta
  const compressed = pytestFilter.apply(delta, '', 0, [])
  return compressed.worthApplying(resolveMinNetSavingsBytes()) ? compressed.withMarker(resolveMinNetSavingsBytes()) : delta
}

const BASH_OUTPUT_POLL: PollTool = { channel: 'bashoutput', blobPrefix: 'bgpoll', idArg: 'bash_id', compactDelta: compactPytestDelta }

export function postBashOutputHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'BashOutput' || !event.sessionId) return passOutput()
    const bashId = getBashId(getToolInput(event))
    if (bashId === undefined) return passOutput()
    return rewritePoll(BASH_OUTPUT_POLL, event.sessionId, bashId, extractToolResultText(event.raw))
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use', postBashOutputHandler, { toolName: 'BashOutput' })
