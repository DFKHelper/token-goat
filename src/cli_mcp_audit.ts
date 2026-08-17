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
 * MCP results share {@link BASH_OUTPUT_SUBDIR} with plain Bash-tool output
 * entries (see mcp_cache.ts's storeMcpOutput), distinguished only by the
 * `mcp_` id prefix it mints -- same filter cmdMcpHistory uses in
 * cache_session_commands.ts. Without it, ordinary Bash command output sitting
 * in the same cache falls through the `command` regex below into the
 * 'unknown' bucket and gets miscounted as MCP server cost.
 */
export function analyzeMcpCache(): Map<string, { callCount: number; perCallEstimate: number; totalBytes: number }> {
  const serverMetrics = new Map<string, { callCount: number; perCallEstimate: number; totalBytes: number }>()

  const blobs = listBlobs(BASH_OUTPUT_SUBDIR).filter((b) => b.id.startsWith('mcp_'))
  for (const { value } of blobs) {
    if (typeof value !== 'object' || value === null) continue

    const entry = value as Record<string, unknown>
    const command = typeof entry['command'] === 'string' ? entry['command'] : ''
    const sizeBytes = typeof entry['sizeBytes'] === 'number' ? entry['sizeBytes'] : 0

    // Extract server name from command like "mcp:mcp__plugin_name__...". The name is whatever the
    // harness put between the two `__` separators -- an .mcp.json key, which is free-form JSON and
    // routinely carries a dot (`my.server`, `acme.tools`) -- so it is matched lazily up to the next
    // separator rather than against a guessed character class. A dotted name used to miss the match
    // entirely and land in the bucket below, showing up twice in the report: once from config with
    // zero calls, once as unattributed cost.
    const toolMatch = command.match(/^mcp:mcp__(.+?)__/i)
    // A non-MCP label is not an MCP server with an unknown name -- it is not a server at all.
    // hooks_agent_spawn and hooks_websearch store Agent and WebSearch results through
    // storeMcpOutput so they are recallable, which mints them the same `mcp_` id prefix the filter
    // above keys on, so they reached this loop and were billed as MCP server cost under a made-up
    // 'unknown' server. On this machine every one of the 43 cached entries was an Agent or
    // WebSearch call, so the whole report was 63597 tokens of cost attributed to a server that does
    // not exist. Same reasoning as the `mcp_` prefix filter's own note above, applied to the labels
    // that get past it: no server name, no server row.
    if (!toolMatch) continue
    const toolName = toolMatch[1] as string

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
