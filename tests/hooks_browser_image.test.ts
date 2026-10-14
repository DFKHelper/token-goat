import { tempConfigPath } from './helpers/temp-config.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const _testConfigPath = tempConfigPath('tg-hooks-browser-image-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { browserResultBlocks, type BrowserBlocks } from '../src/hooks_browser_image.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { lastTabContextMatches } from '../src/session.js'
import { summarize } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { withHarnessOverride } from './helpers/harness-env.js'
import { bareArrayImagePayload } from './fixtures/mcp_bare_array_payloads.js'
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

  // What a real screenshot actually looks like: flat colour, so it compresses to a few kilobytes on the wire, while still decoding to 1920 on its longest edge -- well past the 1568 vision optimum the model is billed against. Small in bytes and oversized in pixels at the same time.
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

/** The base64 payload of every image block the pass handed back. */
function imageData(out: BrowserBlocks | null): string[] {
  return (out?.blocks ?? []).filter((b) => b['type'] === 'image').map((b) => String((b['source'] as Record<string, unknown> | undefined)?.['data'] ?? b['data']))
}

/** token-goat's own notes, the blocks the caller keeps outside the fence. */
function notes(out: BrowserBlocks | null): string[] {
  return out === null ? [] : [...out.own].map((b) => String(b['text']))
}

/** Every text block's text, own notes included. */
function texts(out: BrowserBlocks | null): string {
  return (out?.blocks ?? []).filter((b) => b['type'] === 'text').map((b) => String(b['text'])).join('\n')
}

describe('browserResultBlocks', () => {
  it('shrinks an oversized inline screenshot into a smaller image block of the same shape, with its note beside it', async () => {
    const out = await browserResultBlocks(imageEvent(largeJpegB64))
    expect(notes(out)).toEqual([expect.stringContaining('token-goat shrank an inline browser screenshot')])
    const [data] = imageData(out)
    expect(data).toBeDefined()
    expect(data!.length).toBeLessThan(largeJpegB64.length)
    const image = out!.blocks.find((b) => b['type'] === 'image')!
    expect(image['source']).toMatchObject({ type: 'base64', media_type: expect.stringMatching(/^image\//) })
    expect(texts(out)).not.toContain('data:image/')
  })

  it('shrinks an image block in MCP\'s own data/mimeType shape and hands it back in that shape', async () => {
    const event = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'mcp__playwright__browser_take_screenshot',
      toolInput: {},
      sessionId: 'test',
      raw: { tool_response: [{ type: 'image', data: largeJpegB64, mimeType: 'image/jpeg' }] },
    })
    const out = await browserResultBlocks(event)
    const image = out!.blocks.find((b) => b['type'] === 'image')!
    expect(image['source']).toBeUndefined()
    expect(image['mimeType']).toMatch(/^image\//)
    expect(String(image['data']).length).toBeLessThan(largeJpegB64.length)
  })

  it('shrinks a screenshot delivered as a bare block array, with no content wrapper around it', async () => {
    // A bare `tool_response` array is a shape real MCP servers send (see tests/fixtures/mcp_bare_array_payloads.ts for the captured one). It passes a `typeof tr === 'object'` check and then has no `.content`, so reading only the wrapped shape returned null here and skipped image handling for the whole result without erroring.
    const raw = bareArrayImagePayload('mcp__claude-in-chrome__computer', largeJpegB64)
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'mcp__claude-in-chrome__computer', toolInput: {}, sessionId: 'test', raw })
    const out = await browserResultBlocks(event)
    expect(notes(out)).toEqual([expect.stringContaining('token-goat shrank an inline browser screenshot')])
    expect(texts(out)).toContain('Took a screenshot of the current page')
    expect(imageData(out)[0]!.length).toBeLessThan(largeJpegB64.length)
  })

  it('replaces a screenshot it has already shown this session instead of sending the same pixels twice', async () => {
    // The second screenshot of an unchanged page is the one case where no image beats a smaller image: the notice answers the question the screenshot was taken to ask, in a hundred bytes.
    const first = await browserResultBlocks(imageEvent(largeJpegB64))
    expect(imageData(first)).toHaveLength(1)
    expect(texts(first)).not.toContain('identical to one already shown')

    const second = await browserResultBlocks(imageEvent(largeJpegB64))
    expect(notes(second)).toEqual([expect.stringContaining('identical to one already shown')])
    expect(imageData(second)).toEqual([])
  })

  // Provenance for the token figures below: HAND-DERIVED from Anthropic's published patch rule, computed here rather than read out of visionTokens. The fixture is 3000x3000. On the standard tier the API caps it at the largest square whose grid fits 1568 tokens, 39x39 = 1521, so 1521 is what withholding it saves before the replacement notice is paid for. tests/vision_tokens.test.ts pins the same arithmetic against the published table.
  it('credits a withheld repeat screenshot with the whole billed cost of the image, less the notice standing in for it', async () => {
    await browserResultBlocks(imageEvent(largeJpegB64))

    const before = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    const second = await browserResultBlocks(imageEvent(largeJpegB64))
    const delta = (summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0) - before

    // The replacement notice is 121 bytes, which this repository's text-token approximation prices at round(121 / 4) = 30. Pixels go out and text comes back on this branch, so the two sides are priced by their own rules rather than one rule applied to both.
    expect(notes(second).join('')).toContain('not re-sent')
    expect(delta).toBe(1521 - 30)

    // A guard against silently returning to a bytes-shaped figure: this fixture is megabytes of incompressible noise, so bytes/4 books over a million tokens for the same event.
    expect(delta).toBeLessThan(2000)
  })

  it('prices a resized browser screenshot in visual tokens on the tier that would have paid for it', async () => {
    saveConfig({ ...defaultConfig(), image_shrink: { ...defaultConfig().image_shrink, vision_tier: 'high' } })
    invalidateConfigCache()

    const before = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    const out = await browserResultBlocks(imageEvent(largeJpegB64))
    expect(out).not.toBeNull()
    const delta = (summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0) - before

    // 3000x3000 is capped at 69x69 = 4761 on the high-resolution tier; the 1568x1568 resize fits that tier untouched at 56x56 = 3136.
    expect(delta).toBe(4761 - 3136)
  })

  it('still sends a genuinely different screenshot after one it has already shown', async () => {
    // The failure this rules out is a dedup keyed on something every screenshot shares -- it would pass the test above and silently blind the model to every page it visited afterwards.
    await browserResultBlocks(imageEvent(largeJpegB64))

    const other = await browserResultBlocks(imageEvent(flatScreenshotB64))
    expect(imageData(other)).toHaveLength(1)
    expect(texts(other)).not.toContain('identical to one already shown')
  })

  it('changes nothing in a tool result with no image blocks', async () => {
    const event = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'mcp__claude-in-chrome__computer',
      toolInput: {},
      sessionId: 'test',
      raw: { tool_response: { content: [{ type: 'text', text: 'no images here' }] } },
    })
    expect(await browserResultBlocks(event)).toBeNull()
  })

  it('leaves a below-threshold image untouched', async () => {
    expect(await browserResultBlocks(imageEvent(smallPngB64))).toBeNull()
  })

  it('shrinks a screenshot that is small in bytes but oversized in pixels, which the byte threshold alone would skip', async () => {
    // The regression this pins: shrinkImageBlock used to call shrinkImage with no options, so the 512 KB byte gate decided on its own and a 1920px screenshot at a few KB went through at full size. Vision bills pixels, not bytes, so that is the whole cost of the image left unpaid for. The file-Read path had a dimension probe for exactly this and the browser path did not.
    expect(flatScreenshotBytes).toBeLessThan(512 * 1024)

    const out = await browserResultBlocks(imageEvent(flatScreenshotB64))
    expect(notes(out)).toEqual([expect.stringContaining('token-goat shrank an inline browser screenshot')])
    expect(imageData(out)[0]!.length).toBeLessThan(flatScreenshotB64.length)
  })

  it('keeps an unrecognized content-block type (e.g. an MCP resource block) when an image in the same result is shrunk', async () => {
    const resourceBlock = { type: 'resource', resource: { uri: 'file:///tmp/report.pdf', mimeType: 'application/pdf' } }
    const out = await browserResultBlocks(imageEvent(largeJpegB64, 'mcp__claude-in-chrome__computer', [resourceBlock]))
    expect(out?.blocks).toContainEqual(resourceBlock)
  })

  it('ignores a non-browser MCP tool name', async () => {
    expect(await browserResultBlocks(imageEvent(largeJpegB64, 'mcp__plugin_github_github__search_issues'))).toBeNull()
  })

  it('ignores non-MCP tool calls', async () => {
    const event = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: {},
      raw: { tool_response: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: largeJpegB64 } }] } },
    })
    expect(await browserResultBlocks(event)).toBeNull()
  })

  it('leaves the image alone on a harness that reads the rewrite as one string, where it could only arrive as base64 text', async () => {
    const out = await withHarnessOverride('copilot_cli', () => browserResultBlocks(imageEvent(largeJpegB64)))
    expect(out).toBeNull()
  })

  describe('Tab Context dedup', () => {
    // Big enough (comfortably over the default min_net_savings_bytes=100 floor once the ~34-byte placeholder notice is subtracted) so the dedup rewrite clears the shared net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile). A dedicated pair of tests further down covers the below-floor (untouched) and above-floor (rewritten) boundary explicitly with small/large lists.
    const tabContextText =
      '\n\nTab Context:\n- Available tabs:\n' +
      Array.from({ length: 6 }, (_, i) => `  • tabId ${i + 1}: "Tab number ${i + 1}" (https://example.com/page-${i + 1})`).join('\n')

    it('passes a first-seen Tab Context block through verbatim and records it', async () => {
      const out = await browserResultBlocks(imageEvent(largeJpegB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(texts(out)).toContain('Tab Context:')
      expect(lastTabContextMatches(tabContextText)).toBe(true)
    })

    it('shortens an identical Tab Context repeat to a placeholder', async () => {
      await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      const out = await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(texts(out)).not.toContain('Available tabs')
      expect(texts(out)).toContain('(tabs unchanged since last check)')
    })

    it('updates the cache for a changed Tab Context without forcing a rewrite it does not need', async () => {
      await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      const changed = '\n\nTab Context:\n- Available tabs:\n  • tabId 2: "Other Tab" (https://example.com/)'
      const out = await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: changed }]))
      // Below-threshold image + a non-repeat Tab Context (first-seen-or-changed passes through verbatim, which is a no-op) means nothing actually needs rewriting this call.
      expect(out).toBeNull()
      expect(lastTabContextMatches(changed)).toBe(true)
    })

    it('leaves a below-floor repeated Tab Context untouched -- the placeholder would not clear the net-savings floor', async () => {
      // A tiny one-tab list: shrinking it to the ~34-byte placeholder saves too few bytes to clear the default min_net_savings_bytes=100 floor.
      const tinyTabContext = '\n\nTab Context:\n- Available tabs:\n  • tabId 1: "New Tab" (chrome://newtab/)'
      await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tinyTabContext }]))
      expect(await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tinyTabContext }]))).toBeNull()
    })

    // Proves the shared net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, resolveMinNetSavingsBytes) is actually wired into this path: cranking the same config key/env var bash_runner already used (TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES) to an impossible floor flips an otherwise-rewritable repeat back to a pass-through.
    it('leaves an otherwise-shortenable repeated Tab Context untouched when TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES is set impossibly high', async () => {
      const prevFloor = process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
      process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = '10000000'
      try {
        await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
        expect(await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))).toBeNull()
      } finally {
        if (prevFloor === undefined) delete process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
        else process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = prevFloor
      }
    })

    it('shortens an above-floor repeated Tab Context to the placeholder', async () => {
      await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      const out = await browserResultBlocks(imageEvent(smallPngB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(texts(out)).not.toContain('Available tabs')
      expect(texts(out)).toContain('(tabs unchanged since last check)')
      expect(notes(out)).toEqual([])
    })
  })

  it('image_shrink.enabled=false disables the whole pass', async () => {
    const cfg = defaultConfig()
    cfg.image_shrink.enabled = false
    saveConfig(cfg)
    invalidateConfigCache()

    expect(await browserResultBlocks(imageEvent(largeJpegB64))).toBeNull()
  })
})
