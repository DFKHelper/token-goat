import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { buildProjectMap, formatProjectMap } from '../src/baseline.js'
import { createMcpServer } from '../src/mcp_server.js'
import { runOutline, runRead, runSection, runSkeleton, runRefs, runChanged, runGrep, runImports, runExports } from '../src/read_commands.js'
import { runGit } from '../src/util.js'

const TOOL_NAMES = [
  'read',
  'symbol',
  'section',
  'outline',
  'skeleton',
  'semantic',
  'refs',
  'map',
  'changed',
  'grep',
  'imports',
  'exports',
]

/**
 * Captures everything written to `process.stdout`/`process.stderr` during `fn()`, mirroring
 * `mcp_server.ts`'s own `captureOutput` -- used to get the "expected" text out of the `run*`
 * handlers (`runRefs`/`runChanged`/`runGrep`/`runImports`/`runExports`) that print their own
 * output and return only an exit code, the same way the MCP tool wrappers under test do.
 */
function captureStdout(fn: () => number): { code: number; text: string } {
  const chunks: string[] = []
  const record = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
    return true
  }
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(record)
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(record)
  try {
    const code = fn()
    return { code, text: chunks.join('') }
  } finally {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  }
}

/** Mirrors tests/hooks_compact_adaptive_budget.test.ts's own local helper: a minimal real scratch git repo with one commit. */
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  runGit(['init'], { cwd: dir })
  runGit(['config', 'user.email', 'test@token-goat.local'], { cwd: dir })
  runGit(['config', 'user.name', 'Token Goat Test'], { cwd: dir })
  runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello\n')
  runGit(['add', 'tracked.txt'], { cwd: dir })
  runGit(['commit', '-m', 'initial commit'], { cwd: dir })
}

/**
 * Connects a real MCP Client to a real McpServer via the SDK's own in-memory transport pair —
 * this drives the actual protocol layer (JSON-RPC framing, schema validation, request routing),
 * not a bare function call to a tool handler.
 */
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('mcp_server', () => {
  let tempDir: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    if (tempDir !== undefined) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('lists all 12 surgical-read tools over the real protocol layer', async () => {
    const { client, close } = await connectedClient()
    cleanup = close
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...TOOL_NAMES].sort())
  })

  it('calls the read tool against a real fixture file and matches runRead()\'s own output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-'))
    const fixture = path.join(tempDir, 'fixture.txt')
    const content = 'hello from the mcp read tool\nsecond line'
    fs.writeFileSync(fixture, content)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: fixture } })
    const expected = runRead({ spec: fixture })

    expect(result.isError).toBe(false)
    expect(Array.isArray(result.content)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.type).toBe('text')
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('hello from the mcp read tool')
  })

  it('surfaces a read miss as an MCP tool error (isError: true) with the same message runRead() returns', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const missingPath = path.join(os.tmpdir(), 'tg-mcp-server-nonexistent-file.txt')
    const result = await client.callTool({ name: 'read', arguments: { spec: missingPath } })
    const expected = runRead({ spec: missingPath })

    expect(result.isError).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
  })

  // `LIMIT 0` in SQL always returns zero rows -- a symbol that genuinely exists would otherwise
  // be reported as "no matches" instead of surfacing the caller's mistake. `limit: 0` must be
  // rejected as invalid input at the schema layer, not silently queried against.
  it('rejects limit: 0 on the symbol tool as a schema validation error instead of a false "no matches"', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'symbol', arguments: { name: 'anything', limit: 0 } })

    expect(result.isError).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toContain('validation error')
    expect(block.text).not.toContain('No matches')
  })

  it('rejects limit: 0 on the semantic tool as a schema validation error', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'semantic', arguments: { query: 'anything', limit: 0 } })

    expect(result.isError).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toContain('validation error')
  })

  // The section/skeleton/outline tools had zero successful-call coverage before this: only
  // 'read' and 'symbol' were ever actually invoked (plus a limit:0 rejection for 'symbol' and
  // 'semantic'). A broken handler wiring for any of these three -- a typo'd run* call, a
  // dropped required param mapping -- would have shipped with every existing test green.
  it('calls the section tool against a real markdown fixture and matches runSection()\'s own output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-section-'))
    const fixture = path.join(tempDir, 'doc.md')
    fs.writeFileSync(fixture, '# Intro\n\nHello from the section tool.\n\n# Other\n\nUnrelated.\n')

    const { client, close } = await connectedClient()
    cleanup = close

    const spec = `${fixture}::Intro`
    const result = await client.callTool({ name: 'section', arguments: { spec } })
    const expected = runSection({ spec })

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('Hello from the section tool')
    expect(block.text).not.toContain('Unrelated')
  })

  it('calls the skeleton tool against a real fixture file, with minLines passed through', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-skeleton-'))
    const fixture = path.join(tempDir, 'fixture.ts')
    fs.writeFileSync(
      fixture,
      'function short() {\n  return 1\n}\n\nfunction longer() {\n  let x = 1\n  x += 1\n  x += 1\n  return x\n}\n',
    )

    const { client, close } = await connectedClient()
    cleanup = close

    // forceRefresh: true so the fresh fixture is indexed synchronously before querying --
    // otherwise a file never touched by the worker daemon has no indexed symbols at all.
    const result = await client.callTool({ name: 'skeleton', arguments: { file: fixture, forceRefresh: true } })
    const expected = runSkeleton({ file: fixture })
    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('short')
    expect(block.text).toContain('longer')

    // minLines must reach runSkeleton and actually filter -- confirms the param is wired, not
    // just accepted and silently dropped. Index is already warm from the call above.
    const filtered = await client.callTool({ name: 'skeleton', arguments: { file: fixture, minLines: 4 } })
    const expectedFiltered = runSkeleton({ file: fixture, minLines: 4 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    block = (filtered.content as any[])[0]
    expect(block.text).toBe(expectedFiltered.text)
    expect(block.text).not.toContain('short')
    expect(block.text).toContain('longer')
  })

  it('calls the outline tool against a real fixture file and matches runOutline()\'s own output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-outline-'))
    const fixture = path.join(tempDir, 'fixture.ts')
    fs.writeFileSync(fixture, '/** Docs for foo */\nfunction foo() {\n  return 1\n}\n')

    const { client, close } = await connectedClient()
    cleanup = close

    // forceRefresh: true so the fresh fixture is indexed synchronously before querying.
    const result = await client.callTool({ name: 'outline', arguments: { file: fixture, forceRefresh: true } })
    const expected = runOutline({ file: fixture })

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('foo')
  })

  it('passes the symbol tool\'s kind and file params through to runSymbol (not just name)', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-symbol-'))
    const fixture = path.join(tempDir, 'fixture.ts')
    fs.writeFileSync(fixture, 'const target = 1\nfunction target() {\n  return 2\n}\n')

    // The symbol tool's schema has no forceRefresh param, so index the fixture via a direct
    // runSkeleton({ forceRefresh: true }) call first -- same effect as a warm worker daemon.
    runSkeleton({ file: fixture, forceRefresh: true })

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'symbol',
      arguments: { name: 'target', file: fixture, kind: 'function' },
    })
    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    // kind: 'function' must narrow to just the function match, not the const of the same name.
    expect(block.text).toContain('(function)')
    expect(block.text).not.toContain('(const)')
    expect(block.text).not.toContain('(variable)')
  })

  // refs/changed/grep/imports/exports wrap run* handlers that print their own output and return
  // only an exit code (unlike the { text, code }-returning handlers above) -- the MCP server must
  // capture those writes rather than let them hit the real process.stdout an MCP stdio transport
  // also uses for JSON-RPC framing. These tests confirm the captured text matches what the same
  // handler prints when called directly, proving the capture-and-adapt wiring is correct end to
  // end (a broken capture would either lose the text or, worse, still leak it to real stdout,
  // which command_matrix_e2e.test.ts's real-process `mcp-serve` smoke test would catch as a
  // corrupted JSON-RPC stream).
  it('calls the refs tool against a real fixture file and matches runRefs()\'s own captured output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-refs-'))
    const fixture = path.join(tempDir, 'fixture.ts')
    fs.writeFileSync(fixture, 'function helper() {\n  return 1\n}\n\nfunction caller() {\n  return helper() + helper()\n}\n')
    // forceRefresh: true so the fresh fixture is indexed synchronously before querying.
    runSkeleton({ file: fixture, forceRefresh: true })

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'refs', arguments: { spec: 'helper' } })
    const expected = captureStdout(() => runRefs({ spec: 'helper' }))

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    // ref.context is the enclosing symbol's name, not the raw source line, so the reference
    // line reads "fixture.ts:<n>: caller" rather than literally containing "helper".
    expect(block.text).toContain('fixture.ts')
    expect(block.text).toContain('caller')
  })

  it('calls the map tool against a real fixture directory and matches buildProjectMap/formatProjectMap\'s own output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-map-'))
    fs.writeFileSync(path.join(tempDir, 'fixture.ts'), 'function mapped() {\n  return 1\n}\n')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'map', arguments: { projectRoot: tempDir, compact: true } })
    const map = buildProjectMap(tempDir, { compact: true })
    const expectedText = formatProjectMap(map, map.compact)

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expectedText)
    expect(block.text).toContain('Files: 1')
  })

  it('calls the changed tool against a real scratch git repo and matches runChanged()\'s own captured output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-changed-'))
    initRepo(tempDir)
    fs.writeFileSync(path.join(tempDir, 'new.txt'), 'new content\n')
    runGit(['add', 'new.txt'], { cwd: tempDir })
    runGit(['commit', '-m', 'second commit'], { cwd: tempDir })

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'changed', arguments: { ref: 'HEAD~1', projectRoot: tempDir } })
    const expected = captureStdout(() => runChanged({ ref: 'HEAD~1', projectRoot: tempDir }))

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('new.txt')
  })

  it('calls the grep tool against a real fixture file and matches runGrep()\'s own captured output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-grep-'))
    const fixture = path.join(tempDir, 'fixture.txt')
    fs.writeFileSync(fixture, 'alpha\nneedle-line\nbeta\n')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'needle', path: [tempDir] } })
    const expected = captureStdout(() => runGrep({ pattern: 'needle', path: [tempDir] }))

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('needle-line')
  })

  it('calls the imports tool against a real fixture file and matches runImports()\'s own captured output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-imports-'))
    const fixture = path.join(tempDir, 'fixture.ts')
    fs.writeFileSync(fixture, "import { thing } from './other.js'\n\nconsole.log(thing)\n")

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'imports', arguments: { file: fixture } })
    const expected = captureStdout(() => runImports({ file: fixture }))

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('./other.js')
  })

  it('calls the exports tool against a real fixture file and matches runExports()\'s own captured output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-server-exports-'))
    const fixture = path.join(tempDir, 'fixture.ts')
    fs.writeFileSync(fixture, 'export function shown() {\n  return 1\n}\n')
    // Index the fixture so the index-side heuristic in runExports has a row to match against.
    runSkeleton({ file: fixture, forceRefresh: true })

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'exports', arguments: { file: fixture } })
    const expected = captureStdout(() => runExports({ file: fixture }))

    expect(result.isError).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (result.content as any[])[0]
    expect(block.text).toBe(expected.text)
    expect(block.text).toContain('shown')
  })
})
