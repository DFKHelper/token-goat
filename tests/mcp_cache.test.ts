import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})
