// Regression: the MCP confinement gate (`rejectOutsideRoot` -> `isWithinProjectRoot`) resolved a
// RELATIVE target against the resolved `projectRoot`, but the execution layer resolved the same
// target against the server process's own cwd. Two different bases meant the gate admitted
// `<projectRoot>/x` while the read served `<server cwd>/x`, so confinement only held when the
// server happened to be launched from the workspace root.
//
// Every pre-existing confinement test (tests/mcp_server_read_confinement.test.ts) passes an
// ABSOLUTE path and never changes the process's cwd, so the two bases coincide there and the
// divergence is invisible. Each test below therefore sets the server process's cwd to a directory
// that is deliberately NOT the projectRoot -- that divergence is the entire bug.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as IndexReaderModule from '../src/index_reader.js'
import type { SymbolEntry } from '../src/parser_types.js'

const querySymbolsMock = vi.fn()

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return {
    ...actual,
    querySymbols: (...args: Parameters<typeof actual.querySymbols>) => querySymbolsMock(...args) as SymbolEntry[],
  }
})

const { createMcpServer } = await import('../src/mcp_server.js')

const IN_ROOT = 'IN-ROOT-MARKER'
const SECRET = 'SECRET-MARKER-DO-NOT-LEAK'

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

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('mcp confinement: gate base must equal execution base', () => {
  let root: string
  let serverCwd: string
  let originalCwd: string
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    querySymbolsMock.mockReturnValue([])
    originalCwd = process.cwd()
    // fs.realpathSync: macOS's os.tmpdir() is a symlink (/var -> /private/var), and the gate
    // compares REAL paths -- an unrealpath'd root would not match the realpath'd target.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-div-root-')))
    serverCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-div-cwd-')))
    // Same RELATIVE names in both directories: the gate validates the copy under `root`, the
    // buggy execution layer reads the copy under the server's cwd.
    fs.writeFileSync(path.join(root, 'inside.txt'), `${IN_ROOT}\n`)
    fs.writeFileSync(path.join(serverCwd, 'inside.txt'), `${SECRET}\n`)
    fs.writeFileSync(path.join(serverCwd, 'secret.txt'), `${SECRET}\n`)
    // The divergence under test. Restored in afterEach.
    process.chdir(serverCwd)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const dir of [root, serverCwd]) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---- Symptom 1: `read` -------------------------------------------------------------------

  it('read: a relative bare-file spec is served from projectRoot, not the server cwd', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: 'inside.txt', projectRoot: root } })
    const text = textOf(result)
    expect(text).not.toContain(SECRET)
    expect(text).toContain(IN_ROOT)
  })

  it('read: a relative file@N-M line range is served from projectRoot, not the server cwd', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: 'inside.txt@1-1', projectRoot: root } })
    const text = textOf(result)
    expect(text).not.toContain(SECRET)
    expect(text).toContain(IN_ROOT)
  })

  it('read: an absolute out-of-root path is still refused with cwd != projectRoot', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'read',
      arguments: { spec: path.join(serverCwd, 'secret.txt'), projectRoot: root },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('is outside the project root. The MCP tools are confined to the workspace.')
    expect(textOf(result)).not.toContain(SECRET)
  })

  // ---- Symptom 2: `brief` ------------------------------------------------------------------

  it('brief: a relative spec resolves its symbol against projectRoot, not the server cwd', async () => {
    // Echo whatever file path the resolver asks for straight back as the symbol body, so the
    // rendered output literally carries the contents of whichever copy was resolved.
    querySymbolsMock.mockImplementation((q: { filePath?: string }) => {
      if (q.filePath === undefined || !fs.existsSync(q.filePath)) return []
      return [
        {
          filePath: q.filePath,
          name: 'Foo',
          kind: 'function',
          lineStart: 1,
          lineEnd: 1,
          body: fs.readFileSync(q.filePath, 'utf-8').trim(),
          docstring: '',
          parent: '',
        },
      ]
    })

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'brief', arguments: { spec: 'inside.txt::Foo', projectRoot: root } })
    const text = textOf(result)
    expect(text).not.toContain(SECRET)
    expect(text).toContain(IN_ROOT)
  })

  it('brief: an absolute out-of-root spec is still refused with cwd != projectRoot', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'brief',
      arguments: { spec: `${path.join(serverCwd, 'secret.txt')}::Foo`, projectRoot: root },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('is outside the project root. The MCP tools are confined to the workspace.')
    expect(textOf(result)).not.toContain(SECRET)
  })

  // ---- Symptom 3: `grep` -------------------------------------------------------------------

  it('grep: omitting path searches projectRoot, not the unconfined server cwd', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    // The pattern is a strict PREFIX of the marker, never the marker itself: runGrep echoes the
    // pattern back in its "No matches for '...'" line, so searching for the whole marker would
    // make that very refusal message satisfy a naive `toContain(SECRET)` check.
    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'SECRET-MARKER', projectRoot: root } })
    expect(textOf(result)).not.toContain(SECRET)
  })

  it('grep: omitting path still finds legitimate in-root content with cwd != projectRoot', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'grep', arguments: { pattern: IN_ROOT, projectRoot: root } })
    const text = textOf(result)
    expect(text).toContain(IN_ROOT)
    expect(text).toContain('inside.txt')
  })

  // ---- imports/exports had no confinement gate at all --------------------------------------

  it('imports: an absolute out-of-root file is refused instead of read', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'imports',
      arguments: { file: path.join(serverCwd, 'secret.txt'), projectRoot: root },
    })
    expect(textOf(result)).toContain('is outside the project root. The MCP tools are confined to the workspace.')
    expect(textOf(result)).not.toContain(SECRET)
    expect(result.isError).toBe(true)
  })

  it('exports: an absolute out-of-root file is refused instead of read', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'exports',
      arguments: { file: path.join(serverCwd, 'secret.txt'), projectRoot: root },
    })
    expect(textOf(result)).toContain('is outside the project root. The MCP tools are confined to the workspace.')
    expect(textOf(result)).not.toContain(SECRET)
    expect(result.isError).toBe(true)
  })
})
