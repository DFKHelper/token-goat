import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isMcpReadOnly,
  mcpHash,
  storeMcpResult,
  getMcpResult,
  sidecarMetaPath,
  reset,
} from '../src/mcp_cache.js'

describe('mcp_cache', () => {
  beforeEach(() => {
    reset()
  })

  afterEach(() => {
    reset()
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
      const hash = mcpHash('mcp__test__tool', { key: 'value' })
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
    })

    it('produces consistent hashes', () => {
      const input = { key: 'value', number: 42 }
      const hash1 = mcpHash('mcp__test__tool', input)
      const hash2 = mcpHash('mcp__test__tool', input)
      expect(hash1).toBe(hash2)
    })

    it('produces different hashes for different tools', () => {
      const input = { key: 'value' }
      const hash1 = mcpHash('mcp__tool1', input)
      const hash2 = mcpHash('mcp__tool2', input)
      expect(hash1).not.toBe(hash2)
    })

    it('produces different hashes for different inputs', () => {
      const hash1 = mcpHash('mcp__test__tool', { key: 'value1' })
      const hash2 = mcpHash('mcp__test__tool', { key: 'value2' })
      expect(hash1).not.toBe(hash2)
    })

    it('handles empty input objects', () => {
      const hash = mcpHash('mcp__test__tool', {})
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
    })

    it('normalizes key order for consistent hashing', () => {
      const hash1 = mcpHash('mcp__test__tool', { a: 1, b: 2 })
      const hash2 = mcpHash('mcp__test__tool', { b: 2, a: 1 })
      expect(hash1).toBe(hash2)
    })
  })

  describe('sidecarMetaPath', () => {
    it('returns a valid path for valid output IDs', () => {
      const path = sidecarMetaPath('session_abc123_12345')
      expect(path).toContain('mcp_outputs')
      expect(path).toContain('session_abc123_12345.json')
    })

    it('returns null for invalid output IDs', () => {
      expect(sidecarMetaPath('../../etc/passwd')).toBeNull()
      expect(sidecarMetaPath('')).toBeNull()
      expect(sidecarMetaPath('id/with/slashes')).toBeNull()
    })
  })

  describe('MCP result caching', () => {
    it('stores and retrieves MCP results', async () => {
      const sessionId = 'test-session'
      const toolInputHash = 'abc123def456'
      const resultText = '{"result": "success"}'

      const outputId = await storeMcpResult(
        sessionId,
        toolInputHash,
        resultText,
        undefined,
        { toolName: 'mcp__test__tool', inputPreview: '{"test": "input"}' }
      )

      expect(outputId).not.toBeNull()
      expect(outputId).toContain(sessionId)

      const retrieved = await getMcpResult(sessionId, toolInputHash)
      expect(retrieved).toBe(resultText)
    })

    it('returns null for results exceeding max size', async () => {
      const sessionId = 'test-session'
      const toolInputHash = 'abc123def456'
      const largeText = 'x'.repeat(3 * 1024 * 1024)

      const outputId = await storeMcpResult(
        sessionId,
        toolInputHash,
        largeText
      )

      expect(outputId).toBeNull()
    })

    it('returns null for missing results', async () => {
      const retrieved = await getMcpResult('nonexistent', 'nonexistent')
      expect(retrieved).toBeNull()
    })

    it('stores metadata when toolName is provided', async () => {
      const sessionId = 'test-session'
      const toolInputHash = 'abc123'
      const resultText = 'test result'

      const outputId = await storeMcpResult(
        sessionId,
        toolInputHash,
        resultText,
        undefined,
        {
          toolName: 'mcp__plugin_github__get_file',
          inputPreview: '{"repo": "test"}',
        }
      )

      expect(outputId).not.toBeNull()
    })

    it('handles custom timestamps', async () => {
      const sessionId = 'test-session'
      const toolInputHash = 'abc123'
      const ts = 1234567890

      const outputId = await storeMcpResult(
        sessionId,
        toolInputHash,
        'result',
        ts
      )

      expect(outputId).toContain(String(Math.floor(ts / 1000)))
    })
  })
})
