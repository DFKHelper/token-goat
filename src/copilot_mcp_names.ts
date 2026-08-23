/**
 * Canonicalise Copilot CLI's MCP tool names into the `mcp__<server>__<tool>`
 * shape every MCP-aware hook in token-goat gates on.
 *
 * Claude Code names an MCP tool call `mcp__<server>__<tool>`, and three
 * handlers key off that prefix: `preMcpHandler`/`postMcpHandler`
 * (src/hooks_mcp.ts, registered with `toolPattern: '^mcp__'`),
 * `postBrowserImageHandler` (src/hooks_browser_image.ts) and the screenshot
 * handler (src/hooks_screenshot.ts). Copilot CLI names the same call
 * `<serverName>-<toolName>` -- e.g. server `github-mcp-server` plus tool
 * `search_code` becomes `github-mcp-server-search_code`. Nothing in that
 * string tells the two halves apart: the server name contains hyphens of its
 * own, so splitting on the first (or the last) hyphen is guesswork. Left
 * untranslated, MCP output dedup, MCP output compression and repeat-screenshot
 * shrink are all dead code on Copilot.
 *
 * So the translation is done by exact lookup, never by shape. Copilot already
 * caches the resolved tool list for every MCP server it connects to
 * (src/copilot_mcp_tools.ts reads it for the waste report); this builds the
 * set of `<server>-<tool>` names that cache implies and canonicalises only an
 * exact member of it. That matters because `preMcpHandler` *denies* a call: a
 * heuristic that canonicalised "any name that is not a known built-in" could
 * deny a legitimate built-in tool call. An exact cache match cannot produce
 * that false positive, and when the cache is missing, unreadable or malformed
 * the map is simply empty and behaviour is identical to before.
 *
 * The map is built at most once per process. Hook cost in this project is
 * dominated by process startup rather than by handler logic, so a per-tool-name
 * disk read would be a real regression; a hook process is short-lived enough
 * that a stale memo is not a concern.
 */
import { readCopilotMcpTools } from './copilot_mcp_tools.js'

let _cached: Map<string, string> | null = null

/**
 * Copilot wire name (`<server>-<tool>`) -> canonical name
 * (`mcp__<server>__<tool>`), for every (server, tool) pair in Copilot's cache.
 *
 * Server deduplication (a reconfigured server leaves a stale sibling cache
 * file behind; newest `updatedAt` wins) is already done by
 * {@link readCopilotMcpTools}, so a tool removed from a server's configuration
 * is not resurrected here by the older file.
 */
function copilotMcpToolNameMap(): Map<string, string> {
  if (_cached) return _cached
  const map = new Map<string, string>()
  try {
    for (const server of readCopilotMcpTools().servers) {
      for (const toolName of server.toolNames) {
        map.set(`${server.serverName}-${toolName}`, `mcp__${server.serverName}__${toolName}`)
      }
    }
  } catch {
    // A hook must never fail because a cache was absent or malformed. readCopilotMcpTools
    // already swallows those itself; this is the belt to its braces.
  }
  _cached = map
  return map
}

/**
 * Return the canonical `mcp__<server>__<tool>` spelling of `toolName` when it
 * exactly matches a cached Copilot MCP tool, otherwise `toolName` unchanged.
 */
export function canonicalizeCopilotMcpToolName(toolName: string): string {
  return copilotMcpToolNameMap().get(toolName) ?? toolName
}

/** Test-only: drop the per-process memo so a fresh cache fixture is re-read. */
export function resetCopilotMcpToolNameCache(): void {
  _cached = null
}
