/**
 * post_tool_use handler for browser-automation MCP tools whose results embed
 * an inline base64 screenshot with no destination-file option.
 *
 * `hooks_screenshot.ts::preScreenshotHandler` already covers any MCP tool
 * named `*screenshot` by denying the call and redirecting it to a
 * destination-file variant, whose subsequent Read gets shrunk by
 * `image_shrink.ts`'s existing pipeline. That pattern cannot cover
 * `mcp__claude-in-chrome__computer` or `mcp__claude-in-chrome__browser_batch`:
 * neither tool name matches `*screenshot`, and neither exposes a
 * destination-file parameter to redirect to — a `computer(screenshot)` or a
 * batched screenshot action always returns its image in-band, full
 * resolution, uncompressed. Measured against real session transcripts, these
 * two tools alone accounted for the large majority of all browser-automation
 * payload bytes in a heavy-Playwright/Claude-in-Chrome project.
 *
 * This handler runs after the call, so it cannot prevent the tool from
 * generating the image — but `rewriteOutput`'s `updatedToolOutput` replaces
 * the tool result text the model actually receives (see hook_registry.ts's
 * `serializeOutput` doc comment), so the raw image never reaches context.
 * Each embedded image block is decoded and passed through
 * `image_shrink.ts::shrinkImage` (the same resize/re-encode function
 * `preReadImageHandler` already uses for Read-intercepted images) and
 * replaced with a much smaller re-encoded data URL, following that same
 * handler's `summary\ndataUrl` convention.
 *
 * A second, unrelated duplication in the same tool family is fixed here too:
 * claude-in-chrome appends a `Tab Context:` text block listing every open tab
 * to nearly every `computer`/`browser_batch` result, resent verbatim even
 * when the tab list hasn't changed since the last call. An identical repeat
 * this session is shortened to a placeholder; a first-seen or changed one
 * passes through unchanged.
 */

import { createHash } from 'node:crypto'
import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, passOutput } from './hooks_common.js'
import { loadConfig } from './config.js'
import { formatShrinkSummary, imageQualifiesForShrink, shrinkImage } from './image_shrink.js'
import { BROWSER_TOOL_RE } from './mcp_compress_packs.js'
import { getLastTabContext, hasSeenImage, recordSeenImage, setLastTabContext } from './session.js'
import { recordStat } from './stats.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

interface ContentBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly source?: { readonly type?: unknown; readonly media_type?: unknown; readonly data?: unknown }
}

/** Pulls the MCP `tool_response.content` block array out of a raw post_tool_use payload, or null if the shape doesn't match. */
function getResponseContentBlocks(raw: Record<string, unknown>): ContentBlock[] | null {
  const tr = raw['tool_response']
  if (!tr || typeof tr !== 'object') return null
  const content = (tr as Record<string, unknown>)['content']
  return Array.isArray(content) ? (content as ContentBlock[]) : null
}

/** Matches the literal "Tab Context:" block claude-in-chrome appends to browser-automation tool results. */
const TAB_CONTEXT_RE = /^\n*Tab Context:/

/** Replaces a screenshot the model has already been shown, rather than sending the same pixels twice. */
const SCREENSHOT_REPEAT_NOTICE =
  '[token-goat: screenshot identical to one already shown this session; not re-sent. Nothing on the page has changed since.]'

/**
 * Fingerprint of a screenshot's decoded bytes.
 *
 * Taken on the bytes as they arrived, before any shrink, so two identical arrivals match no matter
 * what the re-encode would have done to either of them -- and a repeat costs one hash instead of a
 * second decode and encode.
 */
function screenshotFingerprint(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 32)
}

async function shrinkImageBlock(block: ContentBlock): Promise<{ text: string; changed: boolean; savedBytes: number }> {
  const source = block.source
  const mediaType = typeof source?.media_type === 'string' ? source.media_type : 'image/png'
  const data = typeof source?.data === 'string' ? source.data : ''
  const originalDataUrl = `data:${mediaType};base64,${data}`
  if (source?.type !== 'base64' || data === '') return { text: originalDataUrl, changed: false, savedBytes: 0 }

  let buffer: Buffer
  try {
    buffer = Buffer.from(data, 'base64')
  } catch {
    return { text: originalDataUrl, changed: false, savedBytes: 0 }
  }

  // A screenshot the model has already been shown is the one case where the cheapest thing to
  // send is no image at all. "Identical to the last one" is not a lossy summary of those pixels --
  // it is strictly more informative than the pixels, because it answers the question the second
  // screenshot was taken to ask. Same shape as dedupTabContext below, on the block beside this one.
  const fingerprint = screenshotFingerprint(data)
  const alreadyShown = hasSeenImage(fingerprint)
  recordSeenImage(fingerprint)
  if (alreadyShown) {
    const worthwhile = isRewriteWorthwhile({
      originalBytes: originalDataUrl.length,
      rewrittenBytes: 0,
      noticeBytes: Buffer.byteLength(SCREENSHOT_REPEAT_NOTICE, 'utf-8'),
      minNetSavingsBytes: resolveMinNetSavingsBytes(),
    })
    if (worthwhile) {
      return {
        text: SCREENSHOT_REPEAT_NOTICE,
        changed: true,
        // Decoded image bytes, not base64 characters. Both branches of this function file under the same `image_shrink` kind, and the shrink branch below credits `result.originalBytes - result.shrunkBytes` -- decoded bytes, the convention documented at image_shrink.ts's own recordStat call. Base64 inflates by 4/3, so crediting `originalDataUrl.length` here booked roughly 33% more for a repeat screenshot than an identical shrink of the same image, and the ledger summed the two units into one row. The gate above deliberately still measures the data URL: it decides whether the rewrite pays off on the wire, where base64 characters are what is actually sent.
        savedBytes: buffer.length - Buffer.byteLength(SCREENSHOT_REPEAT_NOTICE, 'utf-8'),
      }
    }
  }

  // sizeThresholdBytes: 0 because imageQualifiesForShrink has already applied the byte test, and
  // applying it a second time inside shrinkImage would throw away every screenshot that qualified
  // on dimensions instead -- which is most of them, since a screenshot is flat colour and
  // compresses far below the byte threshold while still decoding well past the vision optimum.
  const result = (await imageQualifiesForShrink(buffer)) ? await shrinkImage(buffer, { sizeThresholdBytes: 0 }) : null
  if (result === null) return { text: originalDataUrl, changed: false, savedBytes: 0 }

  const saved = result.originalBytes - result.shrunkBytes
  const { summary, dataUrl } = formatShrinkSummary(result, 'an inline browser screenshot')
  return { text: `${summary}\n${dataUrl}`, changed: true, savedBytes: saved }
}

const TAB_CONTEXT_UNCHANGED_NOTICE = '(tabs unchanged since last check)'

function dedupTabContext(text: string): { text: string; changed: boolean } {
  if (!TAB_CONTEXT_RE.test(text)) return { text, changed: false }
  const isRepeat = getLastTabContext() === text
  setLastTabContext(text)
  if (!isRepeat) return { text, changed: false }
  // Net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, shared with
  // bash_runner's filter pipeline): a short tab list repeated verbatim could
  // be smaller than the placeholder itself, in which case shipping the
  // original tab list untouched beats "shrinking" it into something bigger.
  const worthwhile = isRewriteWorthwhile({
    originalBytes: Buffer.byteLength(text, 'utf-8'),
    rewrittenBytes: 0,
    noticeBytes: Buffer.byteLength(TAB_CONTEXT_UNCHANGED_NOTICE, 'utf-8'),
    minNetSavingsBytes: resolveMinNetSavingsBytes(),
  })
  if (!worthwhile) return { text, changed: false }
  return { text: TAB_CONTEXT_UNCHANGED_NOTICE, changed: true }
}

export async function postBrowserImageHandler(event: HookEvent): Promise<HookOutput> {
  try {
    if (!loadConfig().image_shrink.enabled) return passOutput()
    const toolName = getToolName(event)
    if (!toolName || !BROWSER_TOOL_RE.test(toolName)) return passOutput()

    const blocks = getResponseContentBlocks(event.raw)
    if (blocks === null || blocks.length === 0) return passOutput()

    let anyChanged = false
    const parts: string[] = []
    for (const block of blocks) {
      if (block.type === 'image') {
        const { text, changed, savedBytes } = await shrinkImageBlock(block)
        if (changed) {
          anyChanged = true
          recordStat('image_shrink', savedBytes, Math.round(savedBytes / 4), undefined, toolName)
        }
        parts.push(text)
      } else if (block.type === 'text' && typeof block.text === 'string') {
        const { text, changed } = dedupTabContext(block.text)
        if (changed) {
          anyChanged = true
          // Measured against the string this loop actually emits, the same way emitRewrite computes its savings, rather than from the notice constant: a hand-written figure beside an emit is the per-branch fragility that has produced a wrong credit here before. Without this the tab-context dedup shipped a real saving and recorded nothing at all, so `token-goat stats` showed a total that omitted the whole mechanism while the image branch beside it was credited.
          const savedBytes = Buffer.byteLength(block.text, 'utf-8') - Buffer.byteLength(text, 'utf-8')
          if (savedBytes > 0) recordStat('browser_tab_dedup', savedBytes, Math.round(savedBytes / 4), undefined, toolName)
        }
        parts.push(text)
      } else {
        // Any block type this loop doesn't shrink/dedup (MCP resource/audio blocks, or a text block with a non-string .text) must still round-trip through rewriteOutput once anyChanged fires elsewhere in the same result, or it silently vanishes from what the model sees.
        try {
          parts.push(JSON.stringify(block))
        } catch {
          parts.push(String(block))
        }
      }
    }

    if (!anyChanged) return passOutput()
    return { hookType: 'rewriteOutput', updatedOutput: parts.join('\n') }
  } catch {
    return passOutput()
  }
}

// BROWSER_TOOL_RE is anchored at `^mcp__`, so that prefix is a safe (wider)
// matcher fragment for installHooks -- the handler's own regex still decides.
registerHook('post_tool_use', postBrowserImageHandler, { toolPattern: '^mcp__' })
