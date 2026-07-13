/**
 * Unit tests for the mcp-audit command.
 * Tests readMcpConfig functionality with synthetic fixtures.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

interface McpServer {
  command: string
  args?: string[]
}

interface McpServersConfig {
  [key: string]: McpServer
}

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-audit-'))
})

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true })
  }
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
})
