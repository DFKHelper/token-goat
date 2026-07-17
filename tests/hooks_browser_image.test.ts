import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'

const _testConfigPath = path.join(os.tmpdir(), `tg-hooks-browser-image-config-${process.pid}.toml`)
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { postBrowserImageHandler } from '../src/hooks_browser_image.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { getLastTabContext } from '../src/session.js'
import { makeHookEvent } from './helpers/hook-event.js'
import type { HookEvent } from '../src/hook_registry.js'

// Random noise resists compression, guaranteeing a >512KB encoded size at 3000x3000 so the
// shrink path (downscale to 1568) has real bytes to save — same construction as
// tests/image_shrink.test.ts's largeJpeg fixture.
let largeJpegB64: string
let smallPngB64: string

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
    const tabContextText = '\n\nTab Context:\n- Available tabs:\n  • tabId 1: "New Tab" (chrome://newtab/)'

    it('passes a first-seen Tab Context block through verbatim and records it', async () => {
      const result = await postBrowserImageHandler(imageEvent(largeJpegB64, 'mcp__claude-in-chrome__computer', [{ type: 'text', text: tabContextText }]))
      expect(result.hookType).toBe('rewriteOutput')
      if (result.hookType === 'rewriteOutput') {
        expect(result.updatedOutput).toContain('Tab Context:')
      }
      expect(getLastTabContext()).toBe(tabContextText)
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
      // Below-threshold image + a non-repeat Tab Context (first-seen-or-changed passes through
      // verbatim, which is a no-op) means nothing actually needs rewriting this call.
      expect(result.hookType).toBe('pass')
      expect(getLastTabContext()).toBe(changed)
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
