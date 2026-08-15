// Regression: only the `semantic` MCP tool accepted a `projectRoot` argument to scope
// ambiguous-match disambiguation to the client's actual workspace (see
// mcp_server_semantic_scope.test.ts). The other five tools (`read`, `symbol`, `skeleton`,
// `outline`, `section`) had no equivalent -- when `mcp-serve` is launched from outside a
// project root, a relative `file`/`spec` resolves against the wrong directory, and a bare
// symbol-name search can match an unrelated project's same-named definition anywhere in the
// machine-wide index.
//
// This mocks `../src/index_reader.js`'s `querySymbols` (and `../src/section_reader.js`'s
// `readSection`/`listSections`) and drives each tool call through the REAL MCP protocol
// layer (Client <-> McpServer over InMemoryTransport, same pattern as mcp_server.test.ts and
// mcp_server_semantic_scope.test.ts) to assert the `projectRoot` argument actually reaches the
// underlying resolution, instead of being silently dropped.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type * as IndexReaderModule from '../src/index_reader.js'
import type { SymbolEntry } from '../src/parser_types.js'
import { resolveIndexPath } from '../src/paths.js'
import { resolveProjectRoot } from '../src/project.js'
import type * as SectionReaderModule from '../src/section_reader.js'

const querySymbolsMock = vi.fn()
const readSectionMock = vi.fn()
const listSectionsMock = vi.fn()

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return {
    ...actual,
    querySymbols: (...args: Parameters<typeof actual.querySymbols>) => querySymbolsMock(...args) as SymbolEntry[],
  }
})

vi.mock('../src/section_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SectionReaderModule>()
  return {
    ...actual,
    readSection: (...args: Parameters<typeof actual.readSection>) => readSectionMock(...args) as ReturnType<typeof actual.readSection>,
    listSections: (...args: Parameters<typeof actual.listSections>) => listSectionsMock(...args) as string[],
  }
})

const { createMcpServer } = await import('../src/mcp_server.js')

function fakeSymbol(filePath: string): SymbolEntry {
  return { filePath, name: 'Foo', kind: 'function', lineStart: 1, lineEnd: 3, body: 'function Foo() {}', docstring: '', parent: '' }
}

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createMcpServer()
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

describe('mcp read/symbol/skeleton/outline/section tools accept projectRoot', () => {
  let scratchRoot: string
  let resolvedScratchRoot: string

  beforeEach(() => {
    vi.clearAllMocks()
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-scope-'))
    // The MCP layer resolves the root once and hands the RESOLVED value to the run* handler, so
    // that -- not the raw argument spelling -- is what the assertions below expect.
    resolvedScratchRoot = resolveProjectRoot({ project: scratchRoot })
    querySymbolsMock.mockReturnValue([])
    readSectionMock.mockReturnValue(null)
    listSectionsMock.mockReturnValue([])
  })

  it('symbol tool: scopes a bare name search to projectRoot via rootDir, not process.cwd()', async () => {
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'symbol', arguments: { name: 'Foo', projectRoot: scratchRoot } })
      expect(result.isError).toBe(true) // no matches from the mock -- we only care about the call args
      // A miss now triggers a second querySymbols call for the "Did you mean" near-name scan
      // (runSymbol, src/read_commands.ts); both calls must stay scoped to projectRoot.
      expect(querySymbolsMock).toHaveBeenCalledTimes(2)
      const call = querySymbolsMock.mock.calls[0]?.[0] as { rootDir?: string }
      expect(call.rootDir).toBe(resolvedScratchRoot)
      const nearNameCall = querySymbolsMock.mock.calls[1]?.[0] as { rootDir?: string }
      expect(nearNameCall.rootDir).toBe(resolvedScratchRoot)
    } finally {
      await close()
    }
  })

  it('skeleton tool: resolves a relative file against projectRoot, not process.cwd()', async () => {
    querySymbolsMock.mockReturnValue([fakeSymbol(resolveIndexPath('relative/foo.ts', scratchRoot))])
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'skeleton', arguments: { file: 'relative/foo.ts', projectRoot: scratchRoot } })
      expect(result.isError).toBe(false)
      expect(querySymbolsMock).toHaveBeenCalledTimes(1)
      const call = querySymbolsMock.mock.calls[0]?.[0] as { filePath?: string }
      expect(call.filePath).toBe(resolveIndexPath('relative/foo.ts', scratchRoot))
      expect(call.filePath).not.toBe(resolveIndexPath('relative/foo.ts', process.cwd()))
    } finally {
      await close()
    }
  })

  it('outline tool: resolves a relative file against projectRoot, not process.cwd()', async () => {
    querySymbolsMock.mockReturnValue([fakeSymbol(resolveIndexPath('relative/bar.ts', scratchRoot))])
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'outline', arguments: { file: 'relative/bar.ts', projectRoot: scratchRoot } })
      expect(result.isError).toBe(false)
      expect(querySymbolsMock).toHaveBeenCalledTimes(1)
      const call = querySymbolsMock.mock.calls[0]?.[0] as { filePath?: string }
      expect(call.filePath).toBe(resolveIndexPath('relative/bar.ts', scratchRoot))
    } finally {
      await close()
    }
  })

  it('read tool: resolves a relative file::symbol spec against projectRoot, not process.cwd()', async () => {
    querySymbolsMock.mockReturnValue([fakeSymbol(resolveIndexPath('relative/baz.ts', scratchRoot))])
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'read', arguments: { spec: 'relative/baz.ts::Foo', projectRoot: scratchRoot } })
      expect(result.isError).toBe(false)
      expect(querySymbolsMock).toHaveBeenCalled()
      const call = querySymbolsMock.mock.calls[0]?.[0] as { filePath?: string }
      expect(call.filePath).toBe(resolveIndexPath('relative/baz.ts', scratchRoot))
    } finally {
      await close()
    }
  })

  it('section tool: resolves a relative file::Heading spec against projectRoot before reading from disk', async () => {
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'section', arguments: { spec: 'relative/doc.md::Install', projectRoot: scratchRoot } })
      expect(result.isError).toBe(true) // mock returns null -- we only care about the call args
      expect(readSectionMock).toHaveBeenCalledTimes(1)
      const [calledPath] = readSectionMock.mock.calls[0] as [string, string]
      // Like every other tool in this file, section must resolve against the RESOLVED root
      // (resolvedScratchRoot), not the raw argument spelling -- passing the raw projectRoot
      // straight through, as section previously did, resolves a different, ungated path than
      // the one the confinement gate validated and pinned.
      expect(calledPath).toBe(path.resolve(resolvedScratchRoot, 'relative/doc.md'))
      expect(calledPath).not.toBe(path.resolve(process.cwd(), 'relative/doc.md'))
    } finally {
      await close()
    }
  })

  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true })
  })
})
