import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isMcpReadOnly,
  mcpHash,
  mcpOutputId,
  storeMcpOutput,
  getMcpOutput,
  MCP_MAX_CACHE_BYTES,
} from '../src/mcp_cache.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  clearModuleCaches()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('isMcpReadOnly', () => {
  it('returns true for read-only tools', () => {
    expect(isMcpReadOnly('mcp__plugin_github_github__get_file_contents')).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_github_github__list_issues')).toBe(true)
  })

  it('returns false for mutation tools', () => {
    expect(isMcpReadOnly('mcp__plugin_github_github__create_issue')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_github_github__update_issue')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_github_github__delete_file')).toBe(false)
  })

  it('returns false for non-mcp tools', () => {
    expect(isMcpReadOnly('some_tool')).toBe(false)
    expect(isMcpReadOnly('bash')).toBe(false)
  })

  it('handles case-insensitive mutation verbs', () => {
    expect(isMcpReadOnly('mcp__test__Create')).toBe(false)
    expect(isMcpReadOnly('mcp__test__UPDATE')).toBe(false)
  })

  it('returns false for browser-automation / state-mutating verbs', () => {
    // These chrome-devtools-mcp tool names mutate page/browser state (or their
    // result is expected to change between calls), so they must never be
    // classified as read-only/cacheable.
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__click')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill_form')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__press_key')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__type_text')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__drag')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__hover')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__handle_dialog')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__wait_for')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__emulate')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__upload_file')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__close_page')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__select_page')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__resize_page')).toBe(false)
  })

  it('returns true for genuinely read-only chrome-devtools tools, borderline ones excluded', () => {
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_pages')).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_console_message')).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages')).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_network_request')).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests')).toBe(true)
    // Borderline (triggers a page reload/navigation): conservative default is to exclude it.
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__lighthouse_audit')).toBe(false)
  })

  it('returns false for screenshot tools (not idempotent, content changes between calls)', () => {
    // Screenshots are not idempotent: the page content can change between calls,
    // so they must never be cached/dedup'd. This test ensures the pre_screenshot hook
    // can always capture a fresh screenshot within the cache TTL window.
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot')).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__browser_take_screenshot')).toBe(false)
  })
})

describe('mcpHash', () => {
  it('returns a 16-char hex string', () => {
    expect(mcpHash('mcp__test__tool', { key: 'value' })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces consistent hashes', () => {
    const input = { key: 'value', number: 42 }
    expect(mcpHash('mcp__test__tool', input)).toBe(mcpHash('mcp__test__tool', input))
  })

  it('produces different hashes for different tools', () => {
    expect(mcpHash('mcp__tool1', { key: 'value' })).not.toBe(mcpHash('mcp__tool2', { key: 'value' }))
  })

  it('produces different hashes for different inputs', () => {
    expect(mcpHash('mcp__test__tool', { key: 'value1' })).not.toBe(
      mcpHash('mcp__test__tool', { key: 'value2' }),
    )
  })

  it('normalizes key order for consistent hashing', () => {
    expect(mcpHash('mcp__test__tool', { a: 1, b: 2 })).toBe(mcpHash('mcp__test__tool', { b: 2, a: 1 }))
  })
})

describe('mcpOutputId', () => {
  it('is a fixed-length mcp_<16hex> id', () => {
    expect(mcpOutputId('session-abc', 'deadbeefdeadbeef')).toMatch(/^mcp_[0-9a-f]{16}$/)
  })

  it('is deterministic for the same (session, hash)', () => {
    expect(mcpOutputId('s', 'h')).toBe(mcpOutputId('s', 'h'))
  })

  it('is session-scoped (different sessions => different ids)', () => {
    expect(mcpOutputId('session-a', 'h')).not.toBe(mcpOutputId('session-b', 'h'))
  })

  it('stays within the 64-char blob-id budget for long session ids', () => {
    const id = mcpOutputId('x'.repeat(500), 'h')
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(/^mcp_[0-9a-f]{16}$/)
  })
})

describe('storeMcpOutput / getMcpOutput', () => {
  const sessionId = 'sess-1'
  const toolName = 'mcp__plugin_github_github__get_file_contents'
  const toolInput = { owner: 'o', repo: 'r', path: 'README.md' }

  it('persists a result and recalls its id', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'file body here')
    expect(id).not.toBeNull()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBe(id)
  })

  it('recalls across a cleared in-memory cache (disk round-trip)', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'persisted body')
    expect(id).not.toBeNull()
    // Drop every in-memory map; recall must now resolve from the blob on disk —
    // the exact cross-hook-process path the previous in-memory-only cache failed.
    clearModuleCaches()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBe(id)
    const entry = getBashOutput(id as string)
    expect(entry?.output).toBe('persisted body')
  })

  it('returns null on a miss', () => {
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBeNull()
  })

  it('does not cache results above MCP_MAX_CACHE_BYTES', () => {
    const big = 'x'.repeat(MCP_MAX_CACHE_BYTES + 1)
    expect(storeMcpOutput(sessionId, toolName, toolInput, big)).toBeNull()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBeNull()
  })

  it('does not cache empty results or empty sessions', () => {
    expect(storeMcpOutput(sessionId, toolName, toolInput, '')).toBeNull()
    expect(storeMcpOutput('', toolName, toolInput, 'body')).toBeNull()
  })

  it('scopes the cache per session', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
    expect(id).not.toBeNull()
    expect(getMcpOutput('other-session', toolName, toolInput)).toBeNull()
  })

  it('with no ttlMs given, recalls indefinitely (back-compat default)', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
    expect(id).not.toBeNull()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBe(id)
  })

  it('recalls within the given TTL window', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
      expect(id).not.toBeNull()
      vi.setSystemTime(1_000_000 + 30_000) // 30s later, inside a 60s TTL
      expect(getMcpOutput(sessionId, toolName, toolInput, 60_000)).toBe(id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an entry as a miss once it ages past the TTL window', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
      expect(id).not.toBeNull()
      vi.setSystemTime(1_000_000 + 61_000) // 61s later, outside a 60s TTL
      expect(getMcpOutput(sessionId, toolName, toolInput, 60_000)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
