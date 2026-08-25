/**
 * CLI handler for `token-goat mcp-audit`.
 *
 * Scans .mcp.json for MCP server definitions and estimates per-server
 * token costs from cached MCP tool calls. Correlates schema complexity
 * against real call frequency.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
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
  /** Path of the config file discovery actually read servers from, or null if none was readable. */
  configSourcePath: string | null
  /** Every path discovery checked, in order, for the "no" case's message. */
  configSourcesChecked: string[]
  /**
   * True when there is a real basis for `totalCost` -- either a config source was found (so we
   * know the declared server set, even if it's empty) or the cache recorded at least one real
   * MCP call. False means `totalCost` is not a measurement, it is the absence of one.
   */
  costKnown: boolean
  servers: Array<{
    name: string
    perCallTokens: number
    callCount: number
    totalTokens: number
  }>
  totalCost: number
}

interface McpConfigDiscovery {
  servers: McpServerConfig | null
  sourcePath: string | null
  sourcesChecked: string[]
}

function readMcpJsonFile(configPath: string): McpServerConfig | null {
  try {
    if (!fs.existsSync(configPath)) return null
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    // Support both { mcpServers: {...} } and direct {...} formats
    const servers = parsed && typeof parsed === 'object' ? (parsed.mcpServers ?? parsed) : null
    return servers && typeof servers === 'object' ? servers : null
  } catch {
    return null
  }
}

/**
 * Read .mcp.json from the project root.
 * Supports both { mcpServers: {...} } and direct {...} formats.
 */
export function readMcpConfig(projectRoot: string): McpServerConfig | null {
  return readMcpJsonFile(path.join(projectRoot, '.mcp.json'))
}

/**
 * Read this project's `mcpServers` entry out of Claude Code's own `~/.claude.json`. Claude Code
 * keys the `projects` map by the literal absolute path it saw when the session started, which on
 * Windows can be either slash form (`C:\Projects\x` from a native launch, `C:/Projects/x` from a
 * Git-Bash/WSL-interop launch) depending on how the harness was started -- both are checked
 * rather than assuming one.
 */
/**
 * `projectRoot` in and out of `resolveProjectRoot` (see resolveFilter's cwd handling in
 * dispatch.ts for the same class of case-mismatch) is canonicalized to a lowercase drive letter,
 * but `~/.claude.json` keys `projects` by whatever casing Claude Code literally saw at session
 * start (often uppercase on Windows) -- lowercasing alone would still miss it, so both drive-
 * letter cases are tried alongside both slash forms.
 */
function driveLetterCaseVariants(p: string): string[] {
  const m = /^([a-zA-Z]:)(.*)$/s.exec(p)
  if (m === null) return [p]
  const [, drive, rest] = m as unknown as [string, string, string]
  return [`${drive.toLowerCase()}${rest}`, `${drive.toUpperCase()}${rest}`]
}

function readClaudeJsonConfig(claudeJsonPath: string, projectRoot: string): McpServerConfig | null {
  try {
    if (!fs.existsSync(claudeJsonPath)) return null
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
    const projects = parsed && typeof parsed === 'object' ? parsed.projects : null
    if (!projects || typeof projects !== 'object') return null
    const slashForms = [projectRoot, projectRoot.replace(/\\/g, '/'), projectRoot.replace(/\//g, '\\')]
    const candidates = [...new Set(slashForms.flatMap(driveLetterCaseVariants))]
    for (const key of candidates) {
      const entry = (projects as Record<string, unknown>)[key]
      if (entry && typeof entry === 'object') {
        const servers = (entry as Record<string, unknown>)['mcpServers']
        if (servers && typeof servers === 'object') return servers as McpServerConfig
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Discover MCP server config from every readable on-disk source token-goat knows about: the
 * project's own `.mcp.json`, then this project's entry in Claude Code's `~/.claude.json`.
 * Plugin-provided MCP servers (`mcp__plugin_*`) have no on-disk config at all -- there is no
 * third source to add for those, which is why `printReport` always carries a caveat about them.
 */
function discoverMcpConfig(projectRoot: string, home: string): McpConfigDiscovery {
  const mcpJsonPath = path.join(projectRoot, '.mcp.json')
  const claudeJsonPath = path.join(home, '.claude.json')
  const sourcesChecked = [mcpJsonPath, claudeJsonPath]
  const fromMcpJson = readMcpJsonFile(mcpJsonPath)
  if (fromMcpJson !== null) return { servers: fromMcpJson, sourcePath: mcpJsonPath, sourcesChecked }
  const fromClaudeJson = readClaudeJsonConfig(claudeJsonPath, projectRoot)
  if (fromClaudeJson !== null) return { servers: fromClaudeJson, sourcePath: claudeJsonPath, sourcesChecked }
  return { servers: null, sourcePath: null, sourcesChecked }
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
export function buildMcpAuditReport(projectRoot: string, home: string = os.homedir()): McpAuditReport {
  const discovery = discoverMcpConfig(projectRoot, home)
  const config = discovery.servers
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
    configFound: discovery.sourcePath !== null,
    configSourcePath: discovery.sourcePath,
    configSourcesChecked: discovery.sourcesChecked,
    costKnown: discovery.sourcePath !== null || cacheMetrics.size > 0,
    servers,
    totalCost,
  }
}

export function printReport(report: McpAuditReport): void {
  const w = (text: string) => { process.stdout.write(text) }

  w('\n# token-goat mcp-audit\n')
  w(`Project: ${report.projectRoot}\n`)
  w(report.configSourcePath !== null
    ? `Config found: yes (${report.configSourcePath})\n`
    : `Config found: no (checked: ${report.configSourcesChecked.join(', ')})\n`)

  w('\n## MCP servers\n')
  if (report.servers.length === 0) {
    w(report.costKnown ? '  none\n' : '  none discovered from a readable config source\n')
  } else {
    w('| Server | Per-Call (tok) | Calls | Total (tok) |\n')
    w('|--------|---|---|---|\n')
    for (const server of report.servers) {
      w(`| ${server.name} | ${server.perCallTokens} | ${server.callCount} | ${server.totalTokens} |\n`)
    }
  }

  w(report.costKnown
    ? `\nTotal cost: ${report.totalCost} tok\n`
    : "\nTotal cost: unknown -- no readable MCP config was found and no MCP calls have been recorded in this session's cache yet\n")

  w('\nNote: plugin-provided MCP servers have no on-disk config token-goat can read, so a live session may have MCP servers this audit cannot see or price.\n')
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
