/** The browser-automation pass over an MCP tool result, run by `hooks_mcp.ts::postMcpHandler` before it fences and compresses the result's text. `hooks_screenshot.ts::preScreenshotHandler` already covers any MCP tool named `*screenshot` by denying the call and redirecting it to a destination-file variant, whose subsequent Read gets shrunk by `image_shrink.ts`'s existing pipeline. That pattern cannot cover `mcp__claude-in-chrome__computer` or `mcp__claude-in-chrome__browser_batch`: neither tool name matches `*screenshot`, and neither exposes a destination-file parameter to redirect to — a `computer(screenshot)` or a batched screenshot action always returns its image in-band, full resolution, uncompressed. Measured against real session transcripts, these two tools alone accounted for the large majority of all browser-automation payload bytes in a heavy-Playwright/Claude-in-Chrome project. Each embedded image block is decoded, passed through `image_shrink.ts::shrinkImage` (the same resize/re-encode function `preReadImageHandler` already uses for Read-intercepted images) and put back as a smaller image block of the same shape, with a one-line summary of token-goat's own beside it. A second, unrelated duplication in the same tool family is fixed here too: claude-in-chrome appends a `Tab Context:` text block listing every open tab to nearly every `computer`/`browser_batch` result, resent verbatim even when the tab list hasn't changed since the last call. An identical repeat this session is shortened to a placeholder; a first-seen or changed one passes through unchanged. This used to be a post_tool_use handler of its own, registered after postMcpHandler; the registry stops at the first handler that rewrites, and postMcpHandler fences every MCP result that carries text, so it never ran for a screenshot that came with a caption or a tab list. */

import { createHash } from 'node:crypto'
import type { HookEvent } from './hook_registry.js'
import { getToolName, mcpContentBlocks } from './hooks_common.js'
import { detectHarness } from './bridges/registry.js'
import { loadConfig } from './config.js'
import { formatShrinkSummary, imageQualifiesForShrink, probeImageMeta, shrinkImage, visionTokens, visionTokensSaved } from './image_shrink.js'
import { BROWSER_TOOL_RE } from './mcp_compress_packs.js'
import { hasSeenImage, lastTabContextMatches, recordSeenImage, setLastTabContext } from './session.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

/** Matches the literal "Tab Context:" block claude-in-chrome appends to browser-automation tool results. */
const TAB_CONTEXT_RE = /^\n*Tab Context:/

/** Replaces a screenshot the model has already been shown, rather than sending the same pixels twice. */
const SCREENSHOT_REPEAT_NOTICE =
  '[token-goat: screenshot identical to one already shown this session; not re-sent. Nothing on the page has changed since.]'

/** Fingerprint of a screenshot's decoded bytes. Taken on the bytes as they arrived, before any shrink, so two identical arrivals match no matter what the re-encode would have done to either of them -- and a repeat costs one hash instead of a second decode and encode. */
function screenshotFingerprint(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 32)
}

/** An image block's base64 payload and media type, in either shape one arrives in: the Anthropic `source` object or MCP's own `data`/`mimeType` fields. Null for anything else, including a `source` that is a URL rather than inline bytes. */
function inlineImage(block: Record<string, unknown>): { data: string; mediaType: string } | null {
  const source = block['source']
  if (source !== null && typeof source === 'object') {
    const src = source as Record<string, unknown>
    if (src['type'] !== 'base64' || typeof src['data'] !== 'string' || src['data'] === '') return null
    return { data: src['data'], mediaType: typeof src['media_type'] === 'string' ? src['media_type'] : 'image/png' }
  }
  if (typeof block['data'] !== 'string' || block['data'] === '') return null
  return { data: block['data'], mediaType: typeof block['mimeType'] === 'string' ? block['mimeType'] : 'image/png' }
}

/** `block` carrying `data` as `mediaType`, in the shape it arrived in. */
function withImageData(block: Record<string, unknown>, data: string, mediaType: string): Record<string, unknown> {
  const source = block['source']
  if (source !== null && typeof source === 'object') return { ...block, source: { ...(source as Record<string, unknown>), media_type: mediaType, data } }
  return { ...block, data, mimeType: mediaType }
}

interface ImageOutcome {
  /** token-goat's own line about what it did, delivered in place of or beside the image. */
  readonly note: string
  /** The smaller image, or undefined when the image is withheld altogether. */
  readonly image?: Record<string, unknown>
  readonly savedBytes: number
  readonly savedTokens: number
}

async function shrinkImageBlock(block: Record<string, unknown>): Promise<ImageOutcome | null> {
  const inline = inlineImage(block)
  if (inline === null) return null
  const { data } = inline

  let buffer: Buffer
  try {
    buffer = Buffer.from(data, 'base64')
  } catch {
    return null
  }

  // A screenshot the model has already been shown is the one case where the cheapest thing to send is no image at all. "Identical to the last one" is not a lossy summary of those pixels -- it is strictly more informative than the pixels, because it answers the question the second screenshot was taken to ask. Same shape as dedupTabContext below, on the block beside this one. Decoded once here rather than inside each branch below: the repeat-screenshot notice and the resize both price their saving from the original's dimensions, and this is a header-only read.
  const meta = await probeImageMeta(buffer)
  const tier = loadConfig().image_shrink.vision_tier

  const fingerprint = screenshotFingerprint(data)
  const alreadyShown = hasSeenImage(fingerprint)
  recordSeenImage(fingerprint)
  if (alreadyShown) {
    const worthwhile = isRewriteWorthwhile({
      originalBytes: data.length,
      rewrittenBytes: 0,
      noticeBytes: Buffer.byteLength(SCREENSHOT_REPEAT_NOTICE, 'utf-8'),
      minNetSavingsBytes: resolveMinNetSavingsBytes(),
    })
    if (worthwhile) {
      return {
        note: SCREENSHOT_REPEAT_NOTICE,
        // Decoded image bytes, not base64 characters. Both branches of this function file under the same `image_shrink` kind, and the shrink branch below credits `result.originalBytes - result.shrunkBytes` -- decoded bytes, the convention documented at image_shrink.ts's own recordStat call. Base64 inflates by 4/3, so crediting the data URL's length here booked roughly 33% more for a repeat screenshot than an identical shrink of the same image, and the ledger summed the two units into one row. The gate above deliberately still measures the base64: it decides whether the rewrite pays off on the wire, where base64 characters are what is actually sent.
        savedBytes: buffer.length - Buffer.byteLength(SCREENSHOT_REPEAT_NOTICE, 'utf-8'),
        // The whole image is withheld here rather than resized, so the visual tokens saved are its entire billed cost less the notice standing in for it. Billed cost, not raw patch count: an oversized screenshot would have been capped by the API's own downscale, so pricing the untouched dimensions would credit a bill that was never going to be sent.
        savedTokens: Math.max(0, visionTokens(meta?.width ?? 0, meta?.height ?? 0, tier) - savedTokensFromBytes(Buffer.byteLength(SCREENSHOT_REPEAT_NOTICE, 'utf-8'))),
      }
    }
  }

  // sizeThresholdBytes: 0 because imageQualifiesForShrink has already applied the byte test, and applying it a second time inside shrinkImage would throw away every screenshot that qualified on dimensions instead -- which is most of them, since a screenshot is flat colour and compresses far below the byte threshold while still decoding well past the vision optimum.
  const result = (await imageQualifiesForShrink(buffer)) ? await shrinkImage(buffer, { sizeThresholdBytes: 0 }) : null
  if (result === null) return null

  const saved = result.originalBytes - result.shrunkBytes
  const { summary } = formatShrinkSummary(result, 'an inline browser screenshot')
  // A browser tool_result image is the one case the API does NOT downscale: it rejects an oversized one with a validation error instead. So where the original is past the tier limits, the true counterfactual is a failed request rather than a bigger bill, and that is not a token quantity at all. Pricing it at the capped cost is the conservative reading: it under-credits a resize that actually rescued the call, and never over-credits one that did not.
  const savedTokens = visionTokensSaved(result.originalWidth, result.originalHeight, result.width, result.height, tier)
  return { note: summary, image: withImageData(block, result.data.toString('base64'), `image/${result.format}`), savedBytes: saved, savedTokens }
}

const TAB_CONTEXT_UNCHANGED_NOTICE = '(tabs unchanged since last check)'

function dedupTabContext(text: string): { text: string; changed: boolean } {
  if (!TAB_CONTEXT_RE.test(text)) return { text, changed: false }
  const isRepeat = lastTabContextMatches(text)
  setLastTabContext(text)
  if (!isRepeat) return { text, changed: false }
  // Net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, shared with bash_runner's filter pipeline): a short tab list repeated verbatim could be smaller than the placeholder itself, in which case shipping the original tab list untouched beats "shrinking" it into something bigger.
  const worthwhile = isRewriteWorthwhile({
    originalBytes: Buffer.byteLength(text, 'utf-8'),
    rewrittenBytes: 0,
    noticeBytes: Buffer.byteLength(TAB_CONTEXT_UNCHANGED_NOTICE, 'utf-8'),
    minNetSavingsBytes: resolveMinNetSavingsBytes(),
  })
  if (!worthwhile) return { text, changed: false }
  return { text: TAB_CONTEXT_UNCHANGED_NOTICE, changed: true }
}

/** What {@link browserResultBlocks} made of one result. `blocks` is the result's block array with each screenshot shrunk in place or withheld and each repeated Tab Context shortened; `own` holds the blocks carrying token-goat's own words about that, which the caller keeps outside the untrusted-content fence it puts around the server's text. */
export interface BrowserBlocks {
  readonly blocks: readonly Record<string, unknown>[]
  readonly own: ReadonlySet<Record<string, unknown>>
}

/** The browser pass over `event`'s result, or null when it is not a browser tool's block-shaped result or nothing in it changed. Records its own savings: visual tokens for a shrunk or withheld image, bytes over four for a shortened text block. */
export async function browserResultBlocks(event: HookEvent): Promise<BrowserBlocks | null> {
  try {
    if (!loadConfig().image_shrink.enabled) return null
    const toolName = getToolName(event)
    if (!toolName || !BROWSER_TOOL_RE.test(toolName)) return null
    const blocks = mcpContentBlocks(event.raw)
    if (blocks === null || blocks.length === 0) return null
    // Only Claude Code takes a block array in place of an MCP result (serializeOutput in hook_registry.ts); every other harness reads the rewrite as one string, so a shrunk screenshot could reach it only as base64 text, far more tokens than the image and nothing a text model can look at. The image is left to the harness there.
    const images = detectHarness() === 'claudecode'

    let anyChanged = false
    const out: Record<string, unknown>[] = []
    const own = new Set<Record<string, unknown>>()
    for (const block of blocks) {
      if (block['type'] === 'image' && images) {
        const outcome = await shrinkImageBlock(block)
        if (outcome === null) {
          out.push(block)
          continue
        }
        anyChanged = true
        recordStat('image_shrink', outcome.savedBytes, outcome.savedTokens, undefined, toolName)
        const note = { type: 'text', text: outcome.note }
        own.add(note)
        out.push(note)
        if (outcome.image !== undefined) out.push(outcome.image)
      } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
        const original = block['text']
        const { text, changed } = dedupTabContext(original)
        if (!changed) {
          out.push(block)
          continue
        }
        anyChanged = true
        // Measured against the string this loop actually emits, the same way emitRewrite computes its savings, rather than from the notice constant: a hand-written figure beside an emit is the per-branch fragility that has produced a wrong credit here before. Without this the tab-context dedup shipped a real saving and recorded nothing at all, so `token-goat stats` showed a total that omitted the whole mechanism while the image branch beside it was credited.
        const savedBytes = Buffer.byteLength(original, 'utf-8') - Buffer.byteLength(text, 'utf-8')
        if (savedBytes > 0) recordStat('browser_tab_dedup', savedBytes, savedTokensFromBytes(savedBytes), undefined, toolName)
        out.push({ ...block, text })
      } else {
        out.push(block)
      }
    }
    return anyChanged ? { blocks: out, own } : null
  } catch {
    return null
  }
}
