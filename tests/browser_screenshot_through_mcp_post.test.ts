/** A browser tool's screenshot is shrunk on the real post_tool_use dispatch path, not only when its pass is called by hand. The pass used to be a handler of its own registered after postMcpHandler, and runHook stops at the first handler that rewrites: postMcpHandler fences every MCP result that carries any text, so a screenshot that came with a caption, Playwright's `### Result` section or claude-in-chrome's tab list reached the model at full size and a repeat was resent, while every unit test called the pass directly and stayed green. These cases go through relay's buildEvent and the registry, then through the built bundle. The Playwright payload is HAND-DERIVED: its text block follows the `### Result` / `### Ran Playwright code` layout captured from `mcp__playwright__browser_take_screenshot` results in this machine's Claude Code transcripts (which carried no image block, since those calls passed `filename`), and the image block uses MCP's own `{type, data, mimeType}` fields. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { UNTRUSTED_TOOL_TAG } from '../src/injection_scan.js'
import type { HookOutput } from '../src/types.js'
import { BUNDLE } from './helpers/bundle.js'
import { withoutFenceNonces } from './helpers/fence_nonce.js'
import { HARNESS_DETECTION_ENV_KEYS, withHarnessOverride } from './helpers/harness-env.js'

const PLAYWRIGHT_TEXT =
  '### Result\n- [Screenshot of viewport](./page-2026-10-12.png)\n### Ran Playwright code\n```js\n// Screenshot viewport and save it as ./page-2026-10-12.png\nawait page.screenshot({\n  path: \'./page-2026-10-12.png\',\n  scale: \'css\',\n  type: \'png\'\n});\n```'

const TAB_CONTEXT =
  '\n\nTab Context:\n- Available tabs:\n' + Array.from({ length: 6 }, (_, i) => `  • tabId ${i + 1}: "Tab number ${i + 1}" (https://example.com/page-${i + 1})`).join('\n')

let screenshotB64: string
let tmpHome: string
let prevHome: string | undefined
let sessionId: string
let page = 0

beforeEach(async () => {
  // Flat colour, the way a page screenshot is: a few kilobytes on the wire, 1920 pixels on its longest edge, past the 1568 the model is billed against. A different page per case, because the screenshots already shown are remembered per process, so a case that reused another's image would see a repeat.
  page += 1
  const png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 250 - page, g: 250, b: 250 } } }).png().toBuffer()
  screenshotB64 = png.toString('base64')
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-browser-post-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `browser-post-${path.basename(tmpHome)}`
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function playwrightPayload(session: string): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    session_id: session,
    tool_name: 'mcp__playwright__browser_take_screenshot',
    tool_input: { type: 'png' },
    tool_response: [
      { type: 'text', text: PLAYWRIGHT_TEXT },
      { type: 'image', data: screenshotB64, mimeType: 'image/png' },
    ],
  }
}

function chromePayload(session: string): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    session_id: session,
    tool_name: 'mcp__claude-in-chrome__computer',
    tool_input: { action: 'screenshot' },
    tool_response: {
      content: [
        { type: 'text', text: 'Took a screenshot of the current page.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
        { type: 'text', text: TAB_CONTEXT },
      ],
    },
  }
}

function post(payload: Record<string, unknown>): Promise<HookOutput> {
  return withHarnessOverride('claudecode', () => runHook(buildEvent('post_tool_use', payload)))
}

function blocksOf(out: HookOutput): readonly Record<string, unknown>[] {
  expect(out.hookType).toBe('rewriteOutput')
  return out.hookType === 'rewriteOutput' ? (out.updatedBlocks ?? []) : []
}

function imageData(blocks: readonly Record<string, unknown>[]): string[] {
  return blocks.filter((b) => b['type'] === 'image').map((b) => String((b['source'] as Record<string, unknown> | undefined)?.['data'] ?? b['data']))
}

function textOf(blocks: readonly Record<string, unknown>[]): string {
  return blocks.filter((b) => b['type'] === 'text').map((b) => String(b['text'])).join('\n')
}

describe('a browser screenshot on the production post_tool_use path', () => {
  it('Playwright: the screenshot beside the result text arrives shrunk, the text fenced, and the note outside the fence', async () => {
    const blocks = blocksOf(await post(playwrightPayload(sessionId)))
    const [data] = imageData(blocks)
    expect(data).toBeDefined()
    expect(data!.length).toBeLessThan(screenshotB64.length)
    const [fenced, note] = blocks.filter((b) => b['type'] === 'text').map((b) => String(b['text']))
    expect(withoutFenceNonces(fenced)).toContain(`<${UNTRUSTED_TOOL_TAG}>`)
    expect(fenced).toContain('Screenshot of viewport')
    expect(note).toMatch(/^token-goat shrank an inline browser screenshot/)
    expect(textOf(blocks)).not.toContain('data:image/')
  })

  it('claude-in-chrome: a repeat screenshot and its repeated tab list are both shortened behind the fence', async () => {
    await post(chromePayload(sessionId))
    const blocks = blocksOf(await post(chromePayload(sessionId)))
    expect(imageData(blocks)).toEqual([])
    expect(textOf(blocks)).toContain('identical to one already shown')
    expect(textOf(blocks)).toContain('(tabs unchanged since last check)')
    expect(textOf(blocks)).not.toContain('Available tabs')
    expect(withoutFenceNonces(textOf(blocks))).toContain(`<${UNTRUSTED_TOOL_TAG}>`)
  })

  it('an image-only result is shrunk with nothing to fence', async () => {
    const payload = { ...playwrightPayload(sessionId), tool_response: [{ type: 'image', data: screenshotB64, mimeType: 'image/png' }] }
    const blocks = blocksOf(await post(payload))
    expect(imageData(blocks)[0]!.length).toBeLessThan(screenshotB64.length)
    expect(textOf(blocks)).not.toContain(UNTRUSTED_TOOL_TAG)
  })

  it('the built bundle hands Claude Code the shrunk image as a block beside the fenced text', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of HARNESS_DETECTION_ENV_KEYS) delete env[k]
    env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    const run = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(playwrightPayload(sessionId)), encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
    expect(run.status).toBe(0)
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { updatedToolOutput?: unknown } }
    const updated = parsed.hookSpecificOutput?.updatedToolOutput
    expect(Array.isArray(updated)).toBe(true)
    const blocks = updated as Record<string, unknown>[]
    expect(imageData(blocks)[0]!.length).toBeLessThan(screenshotB64.length)
    expect(withoutFenceNonces(textOf(blocks))).toContain(`<${UNTRUSTED_TOOL_TAG}>`)
    expect(textOf(blocks)).not.toContain('data:image/')
  })
})
