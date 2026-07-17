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

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, passOutput } from './hooks_common.js'
import { loadConfig } from './config.js'
import { shrinkImage } from './image_shrink.js'
import { BROWSER_TOOL_RE } from './mcp_compress_packs.js'
import { getLastTabContext, setLastTabContext } from './session.js'
import { recordStat } from './stats.js'
import { toKB } from './util.js'

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

  const result = await shrinkImage(buffer)
  if (result === null) return { text: originalDataUrl, changed: false, savedBytes: 0 }

  const saved = result.originalBytes - result.shrunkBytes
  const pct = Math.round((saved / result.originalBytes) * 100)
  const summary =
    `token-goat shrank an inline browser screenshot: ` +
    `${toKB(result.originalBytes)}kb -> ${toKB(result.shrunkBytes)}kb ` +
    `(${pct}% smaller, ${result.width}x${result.height} ${result.format}).`
  const dataUrl = `data:image/${result.format};base64,${result.data.toString('base64')}`
  return { text: `${summary}\n${dataUrl}`, changed: true, savedBytes: saved }
}

function dedupTabContext(text: string): { text: string; changed: boolean } {
  if (!TAB_CONTEXT_RE.test(text)) return { text, changed: false }
  const isRepeat = getLastTabContext() === text
  setLastTabContext(text)
  if (!isRepeat) return { text, changed: false }
  return { text: '(tabs unchanged since last check)', changed: true }
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
        if (changed) anyChanged = true
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

registerHook('post_tool_use', postBrowserImageHandler)
