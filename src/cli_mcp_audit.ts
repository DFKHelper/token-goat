/**
 * CLI handler for `token-goat mcp-audit`.
 *
 * Scans .mcp.json for MCP server definitions and estimates per-server
 * token costs from cached MCP tool calls. Correlates schema complexity
 * against real call frequency.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { resolveProjectRoot } from './project.js'
import { listBlobs } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from './bash_output_cache.js'

export interface McpAuditCommandOptions {
  project?: string
  json?: boolean
}

interface McpServerConfig {
  [key: string]: {
    command: string
    args?: string[]
  }
}

interface McpAuditReport {
  projectRoot: string
  configFound: boolean
  servers: Array<{
    name: string
    perCallTokens: number
    callCount: number
    totalTokens: number
  }>
  totalCost: number
}

/**
 * Read .mcp.json from the project root.
 * Supports both { mcpServers: {...} } and direct {...} formats.
 */
export function readMcpConfig(projectRoot: string): McpServerConfig | null {
  const configPath = path.join(projectRoot, '.mcp.json')
  try {
    if (!fs.existsSync(configPath)) {
      return null
    }
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    // Support both { mcpServers: {...} } and direct {...} formats
    return parsed.mcpServers || parsed
  } catch {
    return null
  }
}

/**
 * Analyze bash output cache for MCP server calls.
 * Returns a map of server name -> call metrics.
 */
export function analyzeMcpCache(): Map<string, { callCount: number; perCallEstimate: number; totalBytes: number }> {
  const serverMetrics = new Map<string, { callCount: number; perCallEstimate: number; totalBytes: number }>()

  const blobs = listBlobs(BASH_OUTPUT_SUBDIR)
  for (const { value } of blobs) {
    if (typeof value !== 'object' || value === null) continue

    const entry = value as Record<string, unknown>
    const command = typeof entry['command'] === 'string' ? entry['command'] : ''
    const sizeBytes = typeof entry['sizeBytes'] === 'number' ? entry['sizeBytes'] : 0

    // Extract server name from command like "mcp:mcp__plugin_name__..."
    const toolMatch = command.match(/^mcp:mcp__([a-z0-9_-]+)__/i)
    const toolName = (toolMatch?.[1]) ?? 'unknown'

    if (!serverMetrics.has(toolName)) {
      serverMetrics.set(toolName, { callCount: 0, perCallEstimate: 0, totalBytes: 0 })
    }

    const metrics = serverMetrics.get(toolName)!
    metrics.callCount += 1
    metrics.totalBytes += sizeBytes
    // Average the per-call estimate
    metrics.perCallEstimate = Math.floor(metrics.totalBytes / metrics.callCount / 3) + 1
  }

  return serverMetrics
}

/**
 * Build the audit report by merging config and cache data.
 */
export function buildMcpAuditReport(projectRoot: string): McpAuditReport {
  const config = readMcpConfig(projectRoot)
  const cacheMetrics = analyzeMcpCache()

  const servers: McpAuditReport['servers'] = []
  let totalCost = 0

  // Add servers from config
  if (config) {
    for (const [name] of Object.entries(config)) {
      const metrics = cacheMetrics.get(name)
      const callCount = metrics?.callCount ?? 0
      const perCallTokens = metrics?.perCallEstimate ?? 0
      const cost = perCallTokens * callCount

      servers.push({
        name,
        perCallTokens,
        callCount,
        totalTokens: cost,
      })

      totalCost += cost
    }
  }

  // Add servers from cache that aren't in config
  for (const [name, metrics] of cacheMetrics) {
    if (!config || !(name in config)) {
      const cost = metrics.perCallEstimate * metrics.callCount
      servers.push({
        name,
        perCallTokens: metrics.perCallEstimate,
        callCount: metrics.callCount,
        totalTokens: cost,
      })
      totalCost += cost
    }
  }

  // Sort by total cost descending
  servers.sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    projectRoot,
    configFound: config !== null,
    servers,
    totalCost,
  }
}

function printReport(report: McpAuditReport): void {
  const w = (text: string) => { process.stdout.write(text) }

  w('\n# token-goat mcp-audit\n')
  w(`Project: ${report.projectRoot}\n`)
  w(`Config found: ${report.configFound ? 'yes' : 'no'}\n`)

  w('\n## MCP servers\n')
  if (report.servers.length === 0) {
    w('  none\n')
  } else {
    w('| Server | Per-Call (tok) | Calls | Total (tok) |\n')
    w('|--------|---|---|---|\n')
    for (const server of report.servers) {
      w(`| ${server.name} | ${server.perCallTokens} | ${server.callCount} | ${server.totalTokens} |\n`)
    }
  }

  w(`\nTotal cost: ${report.totalCost} tok\n`)
}

/** Run the `token-goat mcp-audit` command. */
export async function runMcpAuditCommand(opts: McpAuditCommandOptions = {}): Promise<void> {
  const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})

  const report = buildMcpAuditReport(projectRoot)

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }

  printReport(report)
}
