/**
 * Copilot's per-server MCP tool-definition cache, and the waste section built on it.
 *
 * The renderer is driven through `runWasteCommand` rather than by exporting
 * `printCopilotReport` for the test's benefit. Both fixtures are supplied the
 * way Copilot itself supplies them, through `COPILOT_HOME` and
 * `COPILOT_CACHE_HOME`, so the path under test is the shipping path: the real
 * cache-root resolution runs, and nothing here injects a value that the
 * shipping code would have obtained some other way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readCopilotMcpTools } from '../src/copilot_mcp_tools.js'
import { runWasteCommand } from '../src/cli_waste.js'

let tmp: string
let savedCacheHome: string | undefined
let savedHome: string | undefined

/** A cached tool as Copilot writes it: wire fields plus client-side extras. */
function tool(name: string, description: string, extraSchemaPad = ''): unknown {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: extraSchemaPad } } },
    // Present in every real cache entry and never sent to a model. If these
    // are counted the estimate roughly triples, so a test has to pin it.
    annotations: { readOnlyHint: true, title: 'x'.repeat(200) },
    icons: [{ src: 'data:image/png;base64,' + 'A'.repeat(400) }],
  }
}

function writeCache(fileName: string, body: unknown): void {
  const dir = path.join(tmp, 'cache', 'mcp-tools')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(body), 'utf8')
}

function cacheDir(): string {
  return path.join(tmp, 'cache', 'mcp-tools')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cpmcp-'))
  savedCacheHome = process.env['COPILOT_CACHE_HOME']
  savedHome = process.env['COPILOT_HOME']
  process.env['COPILOT_CACHE_HOME'] = path.join(tmp, 'cache')
})

afterEach(() => {
  if (savedCacheHome === undefined) delete process.env['COPILOT_CACHE_HOME']
  else process.env['COPILOT_CACHE_HOME'] = savedCacheHome
  if (savedHome === undefined) delete process.env['COPILOT_HOME']
  else process.env['COPILOT_HOME'] = savedHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('readCopilotMcpTools', () => {
  it('reports a missing cache directory as not found, distinct from an empty one', () => {
    const missing = readCopilotMcpTools()
    expect(missing.cacheFound).toBe(false)
    expect(missing.servers).toEqual([])

    fs.mkdirSync(cacheDir(), { recursive: true })
    const empty = readCopilotMcpTools()
    expect(empty.cacheFound).toBe(true)
    expect(empty.servers).toEqual([])
  })

  it('resolves the cache directory through COPILOT_CACHE_HOME with no argument passed', () => {
    writeCache('a.json', { serverName: 'srv', updatedAt: '2026-01-01T00:00:00Z', tools: [tool('t', 'd')] })
    // Called with no argument on purpose: this is what buildCopilotWasteReport
    // does, so a break in the default resolution chain has to fail here.
    const report = readCopilotMcpTools()
    expect(report.cacheFound).toBe(true)
    expect(report.servers.map((s) => s.serverName)).toEqual(['srv'])
  })

  it('measures only the fields a model is sent, not annotations and icons', () => {
    const tools = [tool('search', 'Search the thing')]
    writeCache('a.json', { serverName: 'srv', updatedAt: '2026-01-01T00:00:00Z', tools })
    const [server] = readCopilotMcpTools(cacheDir()).servers
    expect(server).toBeDefined()

    const wireOnly = JSON.stringify(
      tools.map((t) => {
        const { name, description, inputSchema } = t as Record<string, unknown>
        return { name, description, inputSchema }
      }),
    ).length
    expect(server?.definitionBytes).toBe(wireOnly)

    // The whole entry is far larger. Without this the test would still pass if
    // the implementation summed the entire file, because both are "some number".
    const wholeEntry = JSON.stringify(tools).length
    expect(wholeEntry).toBeGreaterThan(wireOnly * 2)
    expect(server?.definitionBytes).toBeLessThan(wholeEntry)
    expect(server?.toolCount).toBe(1)
    expect(server?.estimatedTokens).toBeGreaterThan(0)
  })

  it('counts a server once when a config change left an older cache file behind', () => {
    const older = { serverName: 'srv', updatedAt: '2026-01-01T00:00:00Z', tools: [tool('a', 'old')] }
    const newer = {
      serverName: 'srv',
      updatedAt: '2026-06-01T00:00:00Z',
      tools: [tool('a', 'new'), tool('b', 'also new')],
    }
    writeCache('old-hash.json', older)
    writeCache('new-hash.json', newer)

    const report = readCopilotMcpTools(cacheDir())
    expect(report.servers).toHaveLength(1)
    expect(report.servers[0]?.toolCount).toBe(2)
  })

  it('skips unreadable entries without losing the readable ones', () => {
    writeCache('good.json', { serverName: 'srv', updatedAt: '2026-01-01T00:00:00Z', tools: [tool('t', 'd')] })
    fs.writeFileSync(path.join(cacheDir(), 'broken.json'), '{not json', 'utf8')
    writeCache('nameless.json', { updatedAt: '2026-01-01T00:00:00Z', tools: [tool('t', 'd')] })

    const report = readCopilotMcpTools(cacheDir())
    expect(report.servers.map((s) => s.serverName)).toEqual(['srv'])
    expect(report.unreadable).toBe(2)
  })

  it('orders servers by weight, heaviest first', () => {
    writeCache('small.json', { serverName: 'small', updatedAt: '2026-01-01T00:00:00Z', tools: [tool('a', 'x')] })
    writeCache('big.json', {
      serverName: 'big',
      updatedAt: '2026-01-01T00:00:00Z',
      tools: [tool('a', 'y'.repeat(400)), tool('b', 'z'.repeat(400))],
    })
    expect(readCopilotMcpTools(cacheDir()).servers.map((s) => s.serverName)).toEqual(['big', 'small'])
  })
})

describe('waste --copilot per-server section', () => {
  function writeSession(): void {
    const dir = path.join(tmp, 'home', 'session-state', 'sess-1')
    fs.mkdirSync(dir, { recursive: true })
    const shutdown = {
      type: 'session.shutdown',
      data: { systemTokens: 1000, toolDefinitionsTokens: 4000, conversationTokens: 100, currentTokens: 5100 },
    }
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(shutdown)}\n`, 'utf8')
    process.env['COPILOT_HOME'] = path.join(tmp, 'home')
  }

  async function render(): Promise<string> {
    const chunks: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((text: any) => { chunks.push(String(text)); return true }) as any
    try {
      await runWasteCommand({ copilot: true })
    } finally {
      process.stdout.write = original
    }
    return chunks.join('')
  }

  it('names each server with its tool count and estimated cost', async () => {
    writeSession()
    writeCache('a.json', {
      serverName: 'github-mcp-server',
      updatedAt: '2026-01-01T00:00:00Z',
      tools: [tool('search_code', 'Search code'), tool('get_file', 'Get a file')],
    })
    const out = await render()
    expect(out).toContain('## Tool definitions by MCP server (estimated)')
    expect(out).toMatch(/github-mcp-server: 2 tools, \d+ B, ~\d+ tok/)
    expect(out).toContain('re-sent every request')
    // The share must be against Copilot's own aggregate, not against itself.
    expect(out).toContain('Copilot counted 4,000 tok of tool definitions in total')
  })

  it('says a missing cache is missing rather than reporting zero servers', async () => {
    writeSession()
    const out = await render()
    expect(out).toContain('No MCP tool cache at')
    expect(out).toContain('not the same as having no MCP servers')
    expect(out).not.toContain('re-sent every request')
  })

  it('distinguishes an empty cache from an absent one', async () => {
    writeSession()
    fs.mkdirSync(cacheDir(), { recursive: true })
    const out = await render()
    expect(out).toContain('Cache is present but holds no servers')
    expect(out).not.toContain('No MCP tool cache at')
  })

  it('discloses cache files it could not read', async () => {
    writeSession()
    writeCache('good.json', { serverName: 'srv', updatedAt: '2026-01-01T00:00:00Z', tools: [tool('t', 'd')] })
    fs.writeFileSync(path.join(cacheDir(), 'broken.json'), 'nope', 'utf8')
    const out = await render()
    expect(out).toContain('1 cache file could not be read')
  })
})
