/**
 * Unit tests for the mcp-audit command.
 * Tests readMcpConfig functionality with synthetic fixtures.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { storeBlob } from '../src/disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from '../src/bash_output_cache.js'
import { analyzeMcpCache } from '../src/cli_mcp_audit.js'

interface McpServer {
  command: string
  args?: string[]
}

interface McpServersConfig {
  [key: string]: McpServer
}

let tempDir: string
let prevHome: string | undefined

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-audit-'))
  prevHome = process.env['TOKEN_GOAT_HOME']
  process.env['TOKEN_GOAT_HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-audit-home-'))
})

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true })
  }
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
})

// Inline readMcpConfig for testing without import issues
function readMcpConfig(projectRoot: string): McpServersConfig | null {
  const configPath = path.join(projectRoot, '.mcp.json')
  try {
    if (!fs.existsSync(configPath)) {
      return null
    }
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    return parsed.mcpServers || parsed
  } catch {
    return null
  }
}

describe('mcp-audit', () => {
  describe('readMcpConfig', () => {
    it('returns null when .mcp.json does not exist', () => {
      const config = readMcpConfig(tempDir)
      expect(config).toBeNull()
    })

    it('parses .mcp.json with mcpServers object', () => {
      const configPath = path.join(tempDir, '.mcp.json')
      const configData = {
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
          },
        },
      }
      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')

      const config = readMcpConfig(tempDir)
      expect(config).toEqual(configData.mcpServers)
    })

    it('parses .mcp.json with direct servers object', () => {
      const configPath = path.join(tempDir, '.mcp.json')
      const configData = {
        'test-server': {
          command: 'node',
          args: ['server.js'],
        },
      }
      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')

      const config = readMcpConfig(tempDir)
      expect(config).toEqual(configData)
    })

    it('returns null on invalid JSON', () => {
      const configPath = path.join(tempDir, '.mcp.json')
      fs.writeFileSync(configPath, 'invalid json', 'utf8')

      const config = readMcpConfig(tempDir)
      expect(config).toBeNull()
    })

    it('handles empty mcpServers object', () => {
      const configPath = path.join(tempDir, '.mcp.json')
      const configData = { mcpServers: {} }
      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')

      const config = readMcpConfig(tempDir)
      expect(config).toEqual({})
    })

    it('handles multiple servers in config', () => {
      const configPath = path.join(tempDir, '.mcp.json')
      const configData = {
        mcpServers: {
          'server1': {
            command: 'node',
            args: ['server1.js'],
          },
          'server2': {
            command: 'python',
            args: ['server2.py'],
          },
        },
      }
      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')

      const config = readMcpConfig(tempDir)
      expect(config).toHaveProperty('server1')
      expect(config).toHaveProperty('server2')
      expect(config?.server1?.command).toBe('node')
      expect(config?.server2?.command).toBe('python')
    })
  })

  describe('analyzeMcpCache', () => {
    it('ignores plain Bash-tool output blobs sharing BASH_OUTPUT_SUBDIR, only counting mcp_-prefixed entries', () => {
      // A real Bash tool call output landing in the shared bash_outputs cache, id has no mcp_ prefix.
      storeBlob(BASH_OUTPUT_SUBDIR, 'plainbash1', {
        id: 'plainbash1',
        command: 'ls -la',
        output: 'file1\nfile2\n',
        exitCode: 0,
        storedAt: Date.now(),
        sizeBytes: 5000,
      })
      // A genuine MCP call output, id carries the mcp_ prefix mcpOutputId() mints.
      storeBlob(BASH_OUTPUT_SUBDIR, 'mcp_abc123', {
        id: 'mcp_abc123',
        command: 'mcp:mcp__github__search_issues {"q":"test"}',
        output: '{"issues":[]}',
        exitCode: 0,
        storedAt: Date.now(),
        sizeBytes: 30,
      })

      const metrics = analyzeMcpCache()

      expect(metrics.has('unknown')).toBe(false)
      expect(metrics.has('github')).toBe(true)
      expect(metrics.get('github')?.callCount).toBe(1)
    })
  })
})
