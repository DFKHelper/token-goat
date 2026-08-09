import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.mock is hoisted — redirect configPath() to an isolated temp file, same
// convention as config.test.ts/config_commands.test.ts: saveConfig() writes
// straight to configPath() with no mkdir of its parent, and the real DATA_DIR
// (isolated per-worker by tests/setup/isolate-home.ts) only has its top-level
// dir pre-created, not the nested dfk-helper/token-goat subdirectory.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-hooks-screenshot-config.toml')

// Importing relay registers EVERY hook module (including hooks_screenshot) for
// its side-effects, so runHook dispatches through the real production
// registry — not a test-only handler reference. buildEvent maps a Claude Code
// payload onto a HookEvent exactly as relay() does on stdin.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-screenshot-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  invalidateConfigCache()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ok — no leftover config from a previous test
  }
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  invalidateConfigCache()
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ok
  }
})

function prePayload(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  return { tool_name: toolName, tool_input: toolInput, session_id: 'screenshot-test' }
}

describe('pre_screenshot (real runHook dispatch)', () => {
  const CHROME_DEVTOOLS_TOOL = 'mcp__chrome-devtools-mcp_chrome-devtools__take_screenshot'
  const PLAYWRIGHT_TOOL = 'mcp__plugin_playwright_playwright__browser_take_screenshot'

  it('denies a chrome-devtools screenshot call with no destination, and names filePath as the fix', async () => {
    const result = await runHook(buildEvent('pre_tool_use', prePayload(CHROME_DEVTOOLS_TOOL, { fullPage: true })))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('filePath')
      expect(result.message).toContain(CHROME_DEVTOOLS_TOOL)
    }
  })

  it('passes a chrome-devtools screenshot call that already provides filePath', async () => {
    const result = await runHook(
      buildEvent('pre_tool_use', prePayload(CHROME_DEVTOOLS_TOOL, { filePath: 'C:/tmp/shot.png' })),
    )
    expect(result.hookType).toBe('pass')
  })

  it('denies a playwright screenshot call with no destination, and names filename (its real param) as the fix', async () => {
    const result = await runHook(buildEvent('pre_tool_use', prePayload(PLAYWRIGHT_TOOL, { raw: false })))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      // Playwright's actual browser_take_screenshot tool takes `filename`, not
      // `filePath` — the deny message must point at the parameter this
      // specific tool actually accepts, not chrome-devtools-mcp's.
      expect(result.message).toContain('filename')
      expect(result.message).not.toContain('`filePath`')
    }
  })

  it('passes a playwright screenshot call that already provides filename', async () => {
    const result = await runHook(buildEvent('pre_tool_use', prePayload(PLAYWRIGHT_TOOL, { filename: 'shot.png' })))
    expect(result.hookType).toBe('pass')
  })

  it('accepts snake_case file_path too (defensive, in case some MCP server uses that convention)', async () => {
    const result = await runHook(
      buildEvent('pre_tool_use', prePayload(CHROME_DEVTOOLS_TOOL, { file_path: 'C:/tmp/shot.png' })),
    )
    expect(result.hookType).toBe('pass')
  })

  it('treats an empty-string destination as missing (still denies)', async () => {
    const result = await runHook(buildEvent('pre_tool_use', prePayload(CHROME_DEVTOOLS_TOOL, { filePath: '' })))
    expect(result.hookType).toBe('deny')
  })

  it('leaves a non-screenshot MCP tool call entirely unaffected', async () => {
    const result = await runHook(
      buildEvent(
        'pre_tool_use',
        prePayload('mcp__plugin_github_github__get_file_contents', { owner: 'o', repo: 'r' }),
      ),
    )
    expect(result.hookType).toBe('pass')
  })

  it('leaves a non-MCP tool call (Read) entirely unaffected', async () => {
    const result = await runHook(buildEvent('pre_tool_use', prePayload('Read', { file_path: 'foo.ts' })))
    expect(result.hookType).toBe('pass')
  })

  it('respects image_shrink.screenshot_redirect=false and passes through even with no destination', async () => {
    const cfg = defaultConfig()
    cfg.image_shrink.screenshot_redirect = false
    saveConfig(cfg)

    const result = await runHook(buildEvent('pre_tool_use', prePayload(CHROME_DEVTOOLS_TOOL, {})))
    expect(result.hookType).toBe('pass')
  })

  it('denies any MCP tool ending in "screenshot" (not just "take_screenshot") when called with no destination', async () => {
    // Regression test: SCREENSHOT_TOOL_RE must match tools ending in "screenshot",
    // not just "take_screenshot". A hypothetical puppeteer_screenshot tool should
    // trigger the same deny-with-hint behavior.
    const PUPPETEER_TOOL = 'mcp__some-mcp-server_puppeteer__puppeteer_screenshot'
    const result = await runHook(buildEvent('pre_tool_use', prePayload(PUPPETEER_TOOL, { fullPage: true })))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain(PUPPETEER_TOOL)
      // Since this tool doesn't match PLAYWRIGHT_SCREENSHOT_RE, it should suggest
      // filePath as the fallback parameter name
      expect(result.message).toContain('filePath')
    }
  })
})
