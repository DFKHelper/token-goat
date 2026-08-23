/**
 * Reads Copilot CLI's on-disk MCP tool-definition cache.
 *
 * Copilot publishes one aggregate number for the whole tool budget at
 * shutdown (`toolDefinitionsTokens`), and that number is the largest single
 * line in a Copilot waste report -- on a real session here it was 11,548
 * tokens against 722 of actual conversation, shipped again on every single
 * request. But one aggregate cannot tell anyone *which* server to drop, so
 * the aggregate alone is not actionable.
 *
 * Copilot caches the resolved tool list for each MCP server it connects to,
 * one JSON file per server, under its cache root. That cache is the only
 * per-server datum available without running Copilot, so it is what this
 * reads. Each file carries `serverName`, `updatedAt` and a `tools` array.
 *
 * Two things about the shape matter and are easy to get wrong:
 *
 * 1. A cached tool entry carries `annotations` and `icons` alongside `name`,
 *    `description` and `inputSchema`. Only the latter three are the tool
 *    definition a model is shown; the other two are client-side presentation.
 *    Measuring the whole file over-reports badly -- on the sample here it is
 *    17,536 bytes against 6,402 for the wire shape, close to a factor of
 *    three. So the measurement below serialises the three fields only.
 *
 * 2. The cache filename is a hash of the server name *and its config*, so
 *    changing a server's configuration writes a new file and can leave the
 *    old one behind. Summing every file would then count one server twice.
 *    Entries are therefore deduplicated by server name, newest `updatedAt`
 *    winning.
 *
 * The token figure this produces is an estimate and is labelled as one
 * everywhere it is shown. It is derived from byte length via the same
 * estimator the rest of token-goat uses, not from Copilot's tokeniser, and
 * it is deliberately never presented as a split of Copilot's own published
 * number: the built-in tools Copilot always sends are not in this cache, so
 * the per-server figures sum to less than the aggregate by design.
 */
import fs from 'node:fs'
import path from 'node:path'

import { copilotCliMcpToolsDir } from './bridges/copilot_cli_install.js'
import { estimateTokensFromLength } from './overflow_guard.js'

/** One MCP server's contribution to the per-request tool-definition budget. */
export interface CopilotMcpServerTools {
  serverName: string
  toolCount: number
  /** Bytes of the wire-shape definition: name + description + inputSchema. */
  definitionBytes: number
  /** Estimated tokens for those bytes. An estimate, never Copilot's own count. */
  estimatedTokens: number
  /** ISO timestamp Copilot last refreshed this server's cache entry. */
  updatedAt: string
  /**
   * The tool names this server contributes, exactly as cached. Needed by
   * {@link copilotMcpToolNameMap}, which reconstructs the `<server>-<tool>`
   * name Copilot puts on the wire; the byte/token measurement above does not
   * use it.
   */
  toolNames: string[]
}

export interface CopilotMcpToolsReport {
  /**
   * False when the cache directory does not exist at all, which is a
   * different fact from an existing but empty directory. The first means
   * Copilot has never cached a server here (or is not installed); the second
   * means it has looked and there are none. Reporting both as "no servers"
   * would state as measured a thing that was never measured.
   */
  cacheFound: boolean
  /** Deduplicated, largest contributor first. */
  servers: CopilotMcpServerTools[]
  /** Files that were present but could not be parsed or lacked a server name. */
  unreadable: number
}

interface CachedTool {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
}

/**
 * Serialised length of the fields a model actually receives. Missing fields
 * are dropped rather than emitted as null so a sparse entry is not credited
 * with bytes Copilot would never send.
 */
function wireShapeLength(tools: CachedTool[]): number {
  const wire = tools.map((tool) => {
    const out: Record<string, unknown> = {}
    if (typeof tool.name === 'string') out['name'] = tool.name
    if (typeof tool.description === 'string') out['description'] = tool.description
    if (tool.inputSchema !== undefined) out['inputSchema'] = tool.inputSchema
    return out
  })
  return JSON.stringify(wire).length
}

/**
 * Read the cache. Never throws on bad input: an unreadable or malformed file
 * is counted in `unreadable` and skipped, because one corrupt cache entry
 * should not take down a report whose other sections are fine.
 */
export function readCopilotMcpTools(dir: string = copilotCliMcpToolsDir()): CopilotMcpToolsReport {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return { cacheFound: false, servers: [], unreadable: 0 }
  }

  const newest = new Map<string, CopilotMcpServerTools>()
  let unreadable = 0

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))
    } catch {
      unreadable += 1
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) {
      unreadable += 1
      continue
    }
    const record = parsed as { serverName?: unknown; updatedAt?: unknown; tools?: unknown }
    const serverName = typeof record.serverName === 'string' ? record.serverName.trim() : ''
    if (serverName === '') {
      unreadable += 1
      continue
    }
    const tools = Array.isArray(record.tools) ? (record.tools as CachedTool[]) : []
    const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : ''
    const definitionBytes = wireShapeLength(tools)
    const candidate: CopilotMcpServerTools = {
      serverName,
      toolCount: tools.length,
      definitionBytes,
      estimatedTokens: estimateTokensFromLength(definitionBytes),
      updatedAt,
      // `tools` is an unchecked cast off a JSON array, so every element is
      // treated as untrusted here rather than trusted to match CachedTool.
      toolNames: (tools as unknown[])
        .map((t) => (t as { name?: unknown } | null)?.name)
        .filter((n): n is string => typeof n === 'string' && n !== ''),
    }
    const existing = newest.get(serverName)
    // Ties and unparseable timestamps keep the first entry seen rather than
    // flip-flopping on directory order, which is not stable across platforms.
    if (existing === undefined || candidate.updatedAt > existing.updatedAt) newest.set(serverName, candidate)
  }

  const servers = [...newest.values()].sort(
    (a, b) => b.definitionBytes - a.definitionBytes || a.serverName.localeCompare(b.serverName),
  )
  return { cacheFound: true, servers, unreadable }
}
