/**
 * Copilot CLI names an MCP tool call `<serverName>-<toolName>`, never
 * `mcp__<server>__<tool>`, so every MCP-aware handler in token-goat -- MCP
 * output dedup and compression (src/hooks_mcp.ts), repeat-screenshot shrink
 * (src/hooks_browser_image.ts, src/hooks_screenshot.ts), all gated on the
 * `mcp__` prefix -- was dead code on Copilot.
 *
 * The translation is exact-match-only against Copilot's own on-disk tool
 * cache, because `preMcpHandler` *denies* a call: a shape heuristic that
 * guessed wrong would block a legitimate built-in tool call. These tests pin
 * both directions of that: a cached name canonicalises, and everything else --
 * a near miss, a built-in, an absent cache, a tool that a reconfigured server
 * no longer publishes -- does not.
 *
 * The fixture is supplied the way Copilot supplies it, through
 * `COPILOT_CACHE_HOME`, so the real cache-root resolution runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { normalizePayload } from '../src/hooks_cli.js'
import { resetCopilotMcpToolNameCache } from '../src/copilot_mcp_names.js'

let tmp: string
let savedCacheHome: string | undefined

function writeCache(fileName: string, serverName: string, updatedAt: string, toolNames: string[]): void {
  const dir = path.join(tmp, 'mcp-tools')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, fileName),
    JSON.stringify({
      serverName,
      updatedAt,
      tools: toolNames.map((name) => ({
        name,
        description: `does ${name}`,
        inputSchema: { type: 'object', properties: {} },
      })),
    }),
    'utf8',
  )
}

/** Run a pre_tool_use payload through the Copilot branch and read back the tool name. */
function nameAfterNormalize(toolName: string, harness: 'copilot_cli' | 'claude' = 'copilot_cli'): unknown {
  return normalizePayload({ tool_name: toolName, tool_input: { q: 'x' } }, harness)['tool_name']
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-mcp-names-'))
  savedCacheHome = process.env['COPILOT_CACHE_HOME']
  process.env['COPILOT_CACHE_HOME'] = tmp
  resetCopilotMcpToolNameCache()
})

afterEach(() => {
  if (savedCacheHome === undefined) delete process.env['COPILOT_CACHE_HOME']
  else process.env['COPILOT_CACHE_HOME'] = savedCacheHome
  resetCopilotMcpToolNameCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Copilot MCP tool-name canonicalization', () => {
  it('canonicalizes a name that exactly matches a cached server/tool pair', () => {
    // The server name itself contains hyphens, which is exactly why splitting
    // the wire name on a hyphen cannot work and the cache lookup is required.
    writeCache('a.json', 'github-mcp-server', '2026-01-01T00:00:00Z', ['search_code'])
    expect(nameAfterNormalize('github-mcp-server-search_code')).toBe('mcp__github-mcp-server__search_code')
  })

  it('leaves a near miss on a known server alone', () => {
    writeCache('a.json', 'github-mcp-server', '2026-01-01T00:00:00Z', ['search_code'])
    expect(nameAfterNormalize('github-mcp-server-search_issues')).toBe('github-mcp-server-search_issues')
  })

  it('never canonicalizes a built-in tool name', () => {
    writeCache('a.json', 'github-mcp-server', '2026-01-01T00:00:00Z', ['search_code'])
    for (const builtin of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Grep', 'Glob', 'task', 'ask_user']) {
      expect(nameAfterNormalize(builtin)).toBe(builtin)
    }
  })

  it('changes nothing when the cache directory does not exist', () => {
    expect(fs.existsSync(path.join(tmp, 'mcp-tools'))).toBe(false)
    expect(nameAfterNormalize('github-mcp-server-search_code')).toBe('github-mcp-server-search_code')
  })

  it('changes nothing when a cache file is malformed', () => {
    fs.mkdirSync(path.join(tmp, 'mcp-tools'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'mcp-tools', 'broken.json'), '{not json', 'utf8')
    expect(nameAfterNormalize('github-mcp-server-search_code')).toBe('github-mcp-server-search_code')
  })

  it('does not resurrect a tool a reconfigured server dropped, from its stale sibling cache file', () => {
    // Copilot's cache filename hashes the server name AND its config, so
    // reconfiguring a server writes a new file and leaves the old one behind.
    writeCache('old.json', 'github-mcp-server', '2026-01-01T00:00:00Z', ['search_code', 'delete_repo'])
    writeCache('new.json', 'github-mcp-server', '2026-06-01T00:00:00Z', ['search_code'])
    expect(nameAfterNormalize('github-mcp-server-search_code')).toBe('mcp__github-mcp-server__search_code')
    expect(nameAfterNormalize('github-mcp-server-delete_repo')).toBe('github-mcp-server-delete_repo')
  })

  it('applies only to the Copilot harness, not to every harness', () => {
    writeCache('a.json', 'github-mcp-server', '2026-01-01T00:00:00Z', ['search_code'])
    expect(nameAfterNormalize('github-mcp-server-search_code', 'claude')).toBe('github-mcp-server-search_code')
  })
})

/**
 * The branch above is only reachable in production if `harnessForNormalization()`
 * (src/relay.ts) actually resolves a Copilot session to 'copilot_cli'. Driving
 * `normalizePayload` directly proves the translation but not the wiring, so this
 * block goes through `relayInProcess` -- the single seam both the shim's
 * in-process call and `token-goat hook <event>` on stdin funnel through -- with
 * only the env var a real Copilot shim sets, and asserts the MCP dedup handler
 * (which no Copilot session could reach before) actually fires.
 */
describe('Copilot MCP canonicalization reaches the real MCP handlers', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let prevOverride: string | undefined

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-mcp-e2e-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
    prevOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    if (prevOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevOverride
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('caches the result of a Copilot-named MCP read and denies the identical repeat', async () => {
    writeCache('a.json', 'github-mcp-server', '2026-01-01T00:00:00Z', ['get_file_contents'])
    const { relayInProcess } = await import('../src/relay.js')
    const sessionId = `copilot-${path.basename(tmpHome)}`
    const payload = {
      tool_name: 'github-mcp-server-get_file_contents',
      tool_input: { owner: 'o', repo: 'r', path: 'README.md' },
      session_id: sessionId,
    }
    await relayInProcess('post_tool_use', { ...payload, tool_response: 'the file body' })
    const pre = await relayInProcess('pre_tool_use', payload)
    // The exact recall wording is hooks_mcp.ts's business; what this pins is that the
    // dedup handler ran at all for a Copilot-spelled name, which it could not do before.
    expect(pre).toContain('"decision":"block"')
  })
})
