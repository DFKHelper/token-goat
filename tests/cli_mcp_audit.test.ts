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
import { analyzeMcpCache, buildMcpAuditReport, printReport } from '../src/cli_mcp_audit.js'
import { normalizePath } from '../src/paths.js'
import { captureStdout } from './helpers/capture-stdout.js'

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

    it('attributes a call to a server whose name contains a dot, as an .mcp.json key may', () => {
      storeBlob(BASH_OUTPUT_SUBDIR, 'mcp_dotted', {
        id: 'mcp_dotted',
        command: 'mcp:mcp__my.server__search {"q":"test"}',
        output: '{}',
        exitCode: 0,
        storedAt: Date.now(),
        sizeBytes: 30,
      })

      const metrics = analyzeMcpCache()

      expect(metrics.has('my.server')).toBe(true)
      expect(metrics.get('my.server')?.callCount).toBe(1)
      expect(metrics.has('unknown')).toBe(false)
    })

    it('does not bill an Agent or WebSearch result as MCP server cost, though both are stored under the mcp_ prefix', () => {
      // hooks_agent_spawn and hooks_websearch store their results through storeMcpOutput so they
      // are recallable, which gives them the same mcp_ id prefix a real MCP call gets.
      storeBlob(BASH_OUTPUT_SUBDIR, 'mcp_agent1', {
        id: 'mcp_agent1',
        command: 'mcp:Agent {"description":"scan"}',
        output: 'agent output',
        exitCode: 0,
        storedAt: Date.now(),
        sizeBytes: 9603,
      })
      storeBlob(BASH_OUTPUT_SUBDIR, 'mcp_websearch1', {
        id: 'mcp_websearch1',
        command: 'mcp:WebSearch {"query":"vitest"}',
        output: 'search output',
        exitCode: 0,
        storedAt: Date.now(),
        sizeBytes: 2265,
      })

      const metrics = analyzeMcpCache()

      expect(metrics.has('unknown')).toBe(false)
      expect([...metrics.keys()]).toEqual([])
    })
  })

  // These drive the REAL exported buildMcpAuditReport/printReport, not the inline copy above --
  // the inline copy is a fixture-parsing test for the old single-source .mcp.json reader and
  // does not exercise report-building, discovery breadth, or the printed unknown-vs-zero wording.
  describe('buildMcpAuditReport / printReport (real dispatch path)', () => {
    let homeDir: string

    beforeEach(() => {
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-audit-claudehome-'))
    })

    afterEach(() => {
      fs.rmSync(homeDir, { recursive: true, force: true })
    })

    // The bug: no readable config anywhere and no recorded MCP calls must render as "we don't
    // know", never as a confident "Total cost: 0 tok" -- that reads as a measurement.
    it('never prints "Total cost: 0 tok" when no config source is readable and the cache is empty', () => {
      const report = buildMcpAuditReport(tempDir, homeDir)
      expect(report.configFound).toBe(false)
      expect(report.costKnown).toBe(false)
      const output = captureStdout(() => { printReport(report) })
      expect(output).not.toContain('Total cost: 0 tok')
      expect(output).toContain('Total cost: unknown')
    })

    it('reports a genuine zero (costKnown) when .mcp.json is found but declares no servers', () => {
      fs.writeFileSync(path.join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
      const report = buildMcpAuditReport(tempDir, homeDir)
      expect(report.configFound).toBe(true)
      expect(report.costKnown).toBe(true)
      const output = captureStdout(() => { printReport(report) })
      expect(output).toContain('Total cost: 0 tok')
    })

    it('discovers servers from ~/.claude.json when .mcp.json is absent, keyed on the forward-slash project path', () => {
      const claudeJsonPath = path.join(homeDir, '.claude.json')
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        projects: {
          [tempDir.replace(/\\/g, '/')]: { mcpServers: { github: { command: 'gh-mcp' } } },
        },
      }))
      const report = buildMcpAuditReport(tempDir, homeDir)
      expect(report.configFound).toBe(true)
      expect(report.configSourcePath).toBe(claudeJsonPath)
      expect(report.servers.some((s) => s.name === 'github')).toBe(true)
    })

    it('discovers servers from ~/.claude.json keyed on the backslash project path form too', () => {
      const claudeJsonPath = path.join(homeDir, '.claude.json')
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        projects: {
          [tempDir.replace(/\//g, '\\')]: { mcpServers: { github: { command: 'gh-mcp' } } },
        },
      }))
      const report = buildMcpAuditReport(tempDir, homeDir)
      expect(report.configFound).toBe(true)
      expect(report.servers.some((s) => s.name === 'github')).toBe(true)
    })

    // resolveProjectRoot canonicalizes the drive letter to lowercase, but Claude Code's
    // ~/.claude.json keys `projects` by whatever casing it literally saw (often uppercase on
    // Windows) -- a drive-letter-case mismatch must not hide a config that is genuinely there.
    it('discovers servers from ~/.claude.json even when its key uses a different drive-letter case than the (canonicalized) project root', () => {
      if (process.platform !== 'win32' || !/^[a-zA-Z]:/.test(tempDir)) return
      const claudeJsonPath = path.join(homeDir, '.claude.json')
      const lowerDriveRoot = normalizePath(tempDir)
      const upperDriveKey = lowerDriveRoot.charAt(0).toUpperCase() + lowerDriveRoot.slice(1)
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        projects: { [upperDriveKey]: { mcpServers: { github: { command: 'gh-mcp' } } } },
      }))
      const report = buildMcpAuditReport(lowerDriveRoot, homeDir)
      expect(report.configFound).toBe(true)
      expect(report.servers.some((s) => s.name === 'github')).toBe(true)
    })

    // Plugin-provided servers have no on-disk config at all -- the report must say so rather
    // than silently omitting them, regardless of what was discovered.
    it('always prints a caveat that plugin-provided MCP servers are not visible to this audit', () => {
      const report = buildMcpAuditReport(tempDir, homeDir)
      const output = captureStdout(() => { printReport(report) })
      expect(output).toMatch(/plugin-provided mcp servers/i)
    })
  })
})
