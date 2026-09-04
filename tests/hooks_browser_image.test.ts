import { tempConfigPath } from './helpers/temp-config.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const _testConfigPath = tempConfigPath('tg-hooks-browser-image-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { postBrowserImageHandler } from '../src/hooks_browser_image.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { lastTabContextMatches } from '../src/session.js'
import { summarize } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'
import type { HookEvent } from '../src/hook_registry.js'

// Random noise resists compression, guaranteeing a >512KB encoded size at 3000x3000 so the shrink path (downscale to 1568) has real bytes to save — same construction as tests/image_shrink.test.ts's largeJpeg fixture.
let largeJpegB64: string
let smallPngB64: string
let flatScreenshotB64: string
let flatScreenshotBytes: number

beforeAll(async () => {
  const side = 3000
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  const largeJpeg = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer()
  largeJpegB64 = largeJpeg.toString('base64')

  const smallPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer()
  smallPngB64 = smallPng.toString('base64')

  // What a real screenshot actually looks like: flat colour, so it compresses to a few kilobytes
  // on the wire, while still decoding to 1920 on its longest edge -- well past the 1568 vision
  // optimum the model is billed against. Small in bytes and oversized in pixels at the same time.
  const flatScreenshot = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: { r: 250, g: 250, b: 250 } },
  })
    .png()
    .toBuffer()
  flatScreenshotB64 = flatScreenshot.toString('base64')
  flatScreenshotBytes = flatScreenshot.length
})

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
})

afterAll(() => {
  invalidateConfigCache()
})

function imageEvent(dataB64: string, toolName = 'mcp__claude-in-chrome__computer', extraBlocks: unknown[] = []): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName,
    toolInput: {},
    sessionId: 'test',
    raw: {
      tool_response: {
        content: [
          { type: 'text', text: 'Took a screenshot of the current page.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataB64 } },
          ...extraBlocks,
        ],
      },
    },
  })
}

describe('postBrowserImageHandler', () => {
  it('shrinks an oversized inline screenshot and rewrites the output with a smaller data URL', async () => {
    const result = await postBrowserImageHandler(imageEvent(largeJpegB64))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toContain('token-goat shrank an inline browser screenshot')
      expect(result.updatedOutput).toContain('data:image/')
      const dataUrlMatch = /data:image\/\w+;base64,([A-Za-z0-9+/=]+)/.exec(result.updatedOutput)
      expect(dataUrlMatch).not.toBeNull()
      expect(dataUrlMatch![1]!.length).toBeLessThan(largeJpegB64.length)
    }
  })

  it('replaces a screenshot it has already shown this session instead of sending the same pixels twice', async () => {
    // The second screenshot of an unchanged page is the one case where no image beats a smaller
    // image: the notice answers the question the screenshot was taken to ask, in a hundred bytes.
    const first = await postBrowserImageHandler(imageEvent(largeJpegB64))
    expect(first.hookType).toBe('rewriteOutput')
    if (first.hookType === 'rewriteOutput') {
      expect(first.updatedOutput).toContain('data:image/')
      expect(first.updatedOutput).not.toContain('identical to one already shown')
    }

    const second = await postBrowserImageHandler(imageEvent(largeJpegB64))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      expect(second.updatedOutput).toContain('identical to one already shown')
      expect(second.updatedOutput).not.toContain('data:image/')
    }
  })

  // Provenance for the token figures below: HAND-DERIVED from Anthropic's published patch rule,
  // computed here rather than read out of visionTokens. The fixture is 3000x3000. On the standard
  // tier the API caps it at the largest square whose grid fits 1568 tokens, 39x39 = 1521, so 1521 is
  // what withholding it saves before the replacement notice is paid for. tests/vision_tokens.test.ts
  // pins the same arithmetic against the published table.
  it('credits a withheld repeat screenshot with the whole billed cost of the image, less the notice standing in for it', async () => {
    await postBrowserImageHandler(imageEvent(largeJpegB64))

    const before = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    const second = await postBrowserImageHandler(imageEvent(largeJpegB64))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return
    const delta = (summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0) - before

    // The replacement notice is 121 bytes, which this repository's text-token approximation prices at
    // round(121 / 4) = 30. Pixels go out and text comes back on this branch, so the two sides are
    // priced by their own rules rather than one rule applied to both.
    expect(second.updatedOutput).toContain('not re-sent')
    expect(delta).toBe(1521 - 30)

    // A guard against silently returning to a bytes-shaped figure: this fixture is megabytes of
    // incompressible noise, so bytes/4 books over a million tokens for the same event.
    expect(delta).toBeLessThan(2000)
  })

  it('prices a resized browser screenshot in visual tokens on the tier that would have paid for it', async () => {
    saveConfig({ ...defaultConfig(), image_shrink: { ...defaultConfig().image_shrink, vision_tier: 'high' } })
    invalidateConfigCache()

    const before = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    const out = await postBrowserImageHandler(imageEvent(largeJpegB64))
    expect(out.hookType).toBe('rewriteOutput')
    const delta = (summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0) - before

    // 3000x3000 is capped at 69x69 = 4761 on the high-resolution tier; the 1568x1568 resize fits
    // that tier untouched at 56x56 = 3136.
    expect(delta).toBe(4761 - 3136)
  })

  it('still sends a genuinely different screenshot after one it has already shown', async () => {
    // The failure this rules out is a dedup keyed on something every screenshot shares -- it would
    // pass the test above and silently blind the model to every page it visited afterwards.
    await postBrowserImageHandler(imageEvent(largeJpegB64))

    const other = await postBrowserImageHandler(imageEvent(flatScreenshotB64))
    expect(other.hookType).toBe('rewriteOutput')
    if (other.hookType === 'rewriteOutput') {
      expect(other.updatedOutput).toContain('data:image/')
      expect(other.updatedOutput).not.toContain('identical to one already shown')
    }
  })

  it('passes through a tool result with no image blocks', async () => {
    const event = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'mcp__claude-in-chrome__computer',
      toolInput: {},
      sessionId: 'test',
      raw: { tool_response: { content: [{ type: 'text', text: 'no images here' }] } },
    })
    const result = await postBrowserImageHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('leaves a below-threshold image untouched (no rewrite fires for that reason alone)', async () => {
    const result = await postBrowserImageHandler(imageEvent(smallPngB64))
    expect(result.hookType).toBe('pass')
  })

  it('shrinks a screenshot that is small in bytes but oversized in pixels, which the byte threshold alone would skip', async () => {
    // The regression this pins: shrinkImageBlock used to call shrinkImage with no options, so the
    // 512 KB byte gate decided on its own and a 1920px screenshot at a few KB went through at full
    // size. Vision bills pixels, not bytes, so that is the whole cost of the image left unpaid for.
    // The file-Read path had a dimension probe for exactly this and the browser path did not.
    expect(flatScreenshotBytes).toBeLessThan(512 * 1024)

    const result = await postBrowserImageHandler(imageEvent(flatScreenshotB64))

    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toContain('token-goat shrank an inline browser screenshot')
      const dataUrlMatch = /data:image\/\w+;base64,([A-Za-z0-9+/=]+)/.exec(result.updatedOutput)
      expect(dataUrlMatch).not.toBeNull()
      expect(dataUrlMatch![1]!.length).toBeLessThan(flatScreenshotB64.length)
    }
  })

  it('preserves an unrecognized content-block type (e.g. an MCP resource block) instead of silently dropping it when an image in the same result triggers a rewrite (regression: the loop only pushed image/text blocks to parts, so any other block type vanished from updatedOutput once anyChanged fired)', async () => {
    const resourceBlock = { type: 'resource', resource: { uri: 'file:///tmp/report.pdf', mimeType: 'application/pdf' } }
    const result = await postBrowserImageHandler(imageEvent(largeJpegB64, 'mcp__claude-in-chrome__computer', [resourceBlock]))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toContain('file:///tmp/report.pdf')
    }
  })

  it('ignores a non-browser MCP tool name', async () => {
    const result = await postBrowserImageHandler(imageEvent(largeJpegB64, 'mcp__plugin_github_github__search_issues'))
    expect(result.hookType).toBe('pass')
  })

  it('ignores non-MCP tool calls', async () => {
    const event = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: {},
      raw: { tool_response: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: largeJpegB64 } }] } },
    })
    const result = await postBrowserImageHandler(event)
    expect(result.hookType).toBe('pass')
  })

  describe('Tab Context dedup', () => {
    // Big enough (comfortably over the default min_net_savings_bytes=100 floor
    // once the ~34-byte placeholder notice is subtracted) so the dedup rewrite
    // clears the shared net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile).
    // A dedicated pair of tests further down covers the below-floor (untouched)
    // and above-floor (rewritten) boundary explicitly with small/large lists.
    const tabContextText =
      '\n\nTab Context:\n- Available tabs:\n' +
      Array.from({ length: 6 }, (_, i) => `  • tabId ${i + 1}: "Tab number ${i + 1}" (https://example.com/page-${i + 1})`).join('\n')

    it('passes a first-seen Tab Context block through verbatim and records it', async () => {
      const result = await postBrowserImageHandler(imageEvent(largeJpegB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(result.hookType).toBe('rewriteOutput')
      if (result.hookType === 'rewriteOutput') {
        expect(result.updatedOutput).toContain('Tab Context:')
      }
      expect(lastTabContextMatches(tabContextText)).toBe(true)
    })

    it('shortens an identical Tab Context repeat to a placeholder', async () => {
      await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      const result = await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(result.hookType).toBe('rewriteOutput')
      if (result.hookType === 'rewriteOutput') {
        expect(result.updatedOutput).not.toContain('Available tabs')
        expect(result.updatedOutput).toContain('(tabs unchanged since last check)')
      }
    })

    it('updates the cache for a changed Tab Context without forcing a rewrite it does not need', async () => {
      await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      const changed = '\n\nTab Context:\n- Available tabs:\n  • tabId 2: "Other Tab" (https://example.com/)'
      const result = await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: changed }]))
      // Below-threshold image + a non-repeat Tab Context (first-seen-or-changed passes through verbatim, which is a no-op) means nothing actually needs rewriting this call.
      expect(result.hookType).toBe('pass')
      expect(lastTabContextMatches(changed)).toBe(true)
    })

    it('leaves a below-floor repeated Tab Context untouched -- the placeholder would not clear the net-savings floor', async () => {
      // A tiny one-tab list: shrinking it to the ~34-byte placeholder saves too
      // few bytes to clear the default min_net_savings_bytes=100 floor.
      const tinyTabContext = '\n\nTab Context:\n- Available tabs:\n  • tabId 1: "New Tab" (chrome://newtab/)'
      await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tinyTabContext }]))
      const result = await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tinyTabContext }]))
      expect(result.hookType).toBe('pass')
    })

    // Proves the shared net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile,
    // resolveMinNetSavingsBytes) is actually wired into this path: cranking the same
    // config key/env var bash_runner already used (TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES)
    // to an impossible floor flips an otherwise-rewritable repeat back to a pass-through.
    it('leaves an otherwise-shortenable repeated Tab Context untouched when TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES is set impossibly high', async () => {
      const prevFloor = process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
      process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = '10000000'
      try {
        await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
        const result = await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
        expect(result.hookType).toBe('pass')
      } finally {
        if (prevFloor === undefined) delete process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
        else process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = prevFloor
      }
    })

    it('shortens an above-floor repeated Tab Context to the placeholder', async () => {
      await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      const result = await postBrowserImageHandler(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(result.hookType).toBe('rewriteOutput')
      if (result.hookType === 'rewriteOutput') {
        expect(result.updatedOutput).not.toContain('Available tabs')
        expect(result.updatedOutput).toContain('(tabs unchanged since last check)')
      }
    })
  })

  it('image_shrink.enabled=false disables the whole hook', async () => {
    const cfg = defaultConfig()
    cfg.image_shrink.enabled = false
    saveConfig(cfg)
    invalidateConfigCache()

    const result = await postBrowserImageHandler(imageEvent(largeJpegB64))
    expect(result.hookType).toBe('pass')
  })
})
