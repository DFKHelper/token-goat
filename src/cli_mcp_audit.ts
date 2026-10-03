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
import { claudeGlobalJsonPath } from './claude_config_dir.js'
import { copilotCliUserRoot } from './copilot_home.js'
import { listBlobs } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from './bash_output_cache.js'
import { estimateTokensFromLength } from './overflow_guard.js'
import { displaySafeText, displaySafeJson } from './paths.js'

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
  /** First path discovery read servers from, or null if none was readable; `configSourcePaths` lists every one. */
  configSourcePath: string | null
  /** Every path discovery read servers from, highest scope first. */
  configSourcePaths: string[]
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
  sourcePaths: string[]
  sourcesChecked: string[]
}

interface ClaudeJsonScopes {
  local: McpServerConfig | null
  user: McpServerConfig | null
}

function asServerMap(value: unknown): McpServerConfig | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as McpServerConfig : null
}

function readMcpJsonFile(configPath: string): McpServerConfig | null {
  try {
    if (!fs.existsSync(configPath)) return null
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    // Support both { mcpServers: {...} } and direct {...} formats; a file with only Visual Studio's `servers` key (install --visualstudio -p) registers nothing for Claude Code, so it must not read as one server named "servers".
    const servers = parsed && typeof parsed === 'object' ? (parsed.mcpServers ?? ('servers' in parsed ? null : parsed)) : null
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

/** Read Claude Code's own `~/.claude.json`: `user` is its top-level `mcpServers` (what `claude mcp add --scope user` writes) and `local` is this project's `projects[path].mcpServers`, keyed by the literal absolute path Claude Code saw at session start, which on Windows can be either slash form (`C:\Projects\x` from a native launch, `C:/Projects/x` from a Git-Bash/WSL-interop launch), so both are tried. */
function readClaudeJsonConfig(claudeJsonPath: string, projectRoot: string): ClaudeJsonScopes {
  const none: ClaudeJsonScopes = { local: null, user: null }
  try {
    if (!fs.existsSync(claudeJsonPath)) return none
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return none
    const projects = parsed.projects
    let local: McpServerConfig | null = null
    if (projects && typeof projects === 'object') {
      const slashForms = [projectRoot, projectRoot.replace(/\\/g, '/'), projectRoot.replace(/\//g, '\\')]
      const candidates = [...new Set(slashForms.flatMap(driveLetterCaseVariants))]
      for (const key of candidates) {
        const entry = (projects as Record<string, unknown>)[key]
        local = entry && typeof entry === 'object' ? asServerMap((entry as Record<string, unknown>)['mcpServers']) : null
        if (local !== null) break
      }
    }
    return { local, user: asServerMap(parsed.mcpServers) }
  } catch {
    return none
  }
}

/** Discover MCP servers the way Claude Code loads them: local scope (this project's entry in `~/.claude.json`), project scope (`.mcp.json`) and user scope (the top-level `mcpServers` of `~/.claude.json`) are merged, a name declared in several scopes listed once, and Copilot CLI's `mcp-config.json` is read only when no Claude Code scope declares anything; plugin-provided servers (`mcp__plugin_*`) have no on-disk config at all, which is why `printReport` always carries a caveat about them. */
function discoverMcpConfig(projectRoot: string, home: string): McpConfigDiscovery {
  const mcpJsonPath = path.join(projectRoot, '.mcp.json')
  const claudeJsonFile = claudeGlobalJsonPath(home)
  const copilotJsonPath = path.join(copilotCliUserRoot(home), 'mcp-config.json')
  const sourcesChecked = [mcpJsonPath, claudeJsonFile, copilotJsonPath]
  const claudeJson = readClaudeJsonConfig(claudeJsonFile, projectRoot)
  const scopes: Array<[McpServerConfig | null, string]> = [[claudeJson.local, claudeJsonFile], [readMcpJsonFile(mcpJsonPath), mcpJsonPath], [claudeJson.user, claudeJsonFile]]
  const found = scopes.filter((scope): scope is [McpServerConfig, string] => scope[0] !== null)
  if (found.length > 0) {
    const servers: McpServerConfig = Object.fromEntries(found.flatMap(([scope]) => Object.entries(scope)))
    return { servers, sourcePaths: [...new Set(found.map(([, sourcePath]) => sourcePath))], sourcesChecked }
  }
  const fromCopilotJson = readMcpJsonFile(copilotJsonPath)
  return { servers: fromCopilotJson, sourcePaths: fromCopilotJson !== null ? [copilotJsonPath] : [], sourcesChecked }
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
    // Average the per-call estimate. The divisor used to be typed out here, which is the same duplicated-arithmetic defect the saved_tokens_use_one_divisor guard exists for, so it goes through the shared helper and one pricing change reaches every caller. estimateTokensFromLength, not savedTokensFromBytes: this figure is a COST an MCP server imposes, never a saving token-goat credits itself, and the repo's split (see the note on estimateTokensFromLength) puts a cost on the guard's deliberately-high divide-by-three and a credit on the conservative divide-by-four. Byte-identical to the arithmetic it replaces for every non-negative input, so no printed number moves.
    metrics.perCallEstimate = estimateTokensFromLength(metrics.totalBytes / metrics.callCount)
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
        // Escaped here, at construction, rather than at print time: the server name is a key an
        // arbitrary repository's .mcp.json chooses, and it reaches a model verbatim through both
        // the printed table and `--json`. Unescaped, it can spell token-goat's own `[tg]` and
        // `[token-goat: ...]` markers and speak in this tool's voice inside the model's context;
        // a newline or `|` in it also breaks the markdown table apart.
        name: displaySafeText(name),
        perCallTokens,
        callCount,
        totalTokens: cost,
      })

      totalCost += cost
    }
  }

  // Add servers from cache that aren't in config
  for (const [name, metrics] of cacheMetrics) {
    if (!config || !Object.hasOwn(config, name)) {
      const cost = metrics.perCallEstimate * metrics.callCount
      servers.push({
        name: displaySafeText(name),
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
    configFound: discovery.sourcePaths.length > 0,
    configSourcePath: discovery.sourcePaths[0] ?? null,
    configSourcePaths: discovery.sourcePaths,
    configSourcesChecked: discovery.sourcesChecked,
    costKnown: discovery.sourcePaths.length > 0 || cacheMetrics.size > 0,
    servers,
    totalCost,
  }
}

export function printReport(report: McpAuditReport): void {
  const w = (text: string) => { process.stdout.write(text) }

  w('\n# token-goat mcp-audit\n')
  w(`Project: ${report.projectRoot}\n`)
  w(report.configSourcePaths.length > 0
    ? `Config found: yes (${report.configSourcePaths.join(', ')})\n`
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
    process.stdout.write(`${displaySafeJson(report, 0)}\n`)
    return
  }

  printReport(report)
}
