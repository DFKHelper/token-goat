// Regression: none of the MCP server's tool handlers accepted a root/cwd/project argument, so
// they all inherited whatever process.cwd() the MCP server process happened to be launched
// with -- opaque and often NOT the actual workspace root for an MCP client. `semantic` is the
// only exposed MCP tool among the now project-scoped commands (map/semantic/find/dead/stats --
// the rest of that set are CLI-only, not MCP tools), so it's the one that needed a projectRoot
// parameter threaded through to searchSemantic's rootDir argument.
//
// searchSemantic needs a real sqlite-vec-backed DB plus the embedding model to exercise
// end-to-end (expensive to fixture -- see semantic_project_scope.test.ts for that), so this
// mocks searchSemantic (same pattern as semantic_overflow_guard.test.ts) and drives the tool
// call through the REAL MCP protocol layer (Client <-> McpServer over InMemoryTransport, same
// pattern as mcp_server.test.ts) to assert the projectRoot argument actually reaches
// searchSemantic's rootDir parameter, instead of being silently dropped.
//
// The mock resolves a non-empty hit so runSemantic's success path never falls through to the
// real FTS fallback (searchSymbolsFts) -- that fallback queries the real, order-dependent
// global.db, which would make this test's pass/fail flaky depending on what other test files
// ran earlier in the same worker process.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import { resolveProjectRoot } from '../src/project.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

const { createMcpServer } = await import('../src/mcp_server.js')

function fakeHit(): SearchHit {
  return { filePath: 'scoped.ts', startLine: 1, endLine: 5, kind: 'window', distance: 0.1, text: 'scoped result' }
}

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

describe('mcp semantic tool projectRoot scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchSemanticMock.mockResolvedValue([fakeHit()])
  })

  it('passes an explicit projectRoot argument through to searchSemantic as rootDir, not process.cwd()', async () => {
    // Must be a real, absolute, existing directory -- runSemantic now validates projectRoot
    // (see mcp_server_semantic_projectroot_validation.test.ts) and rejects anything else before
    // it ever reaches searchSemantic.
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-sem-scope-'))
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'semantic', arguments: { query: 'anything', projectRoot: scratchRoot } })

      expect(result.isError).toBe(false)
      expect(searchSemanticMock).toHaveBeenCalledTimes(1)
      const call = searchSemanticMock.mock.calls[0]
      // rootDir is searchSemantic's 6th positional argument (db, query, topK, modelName, maxDistance, rootDir).
      // The MCP layer resolves the root once and passes the RESOLVED value on, so the raw
      // argument spelling is deliberately not what arrives here.
      expect(call?.[5]).toBe(resolveProjectRoot({ project: scratchRoot }))
      expect(call?.[5]).not.toBe(process.cwd())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = (result.content as any[])[0]
      expect(block.text).toContain('scoped.ts')
    } finally {
      await close()
      fs.rmSync(scratchRoot, { recursive: true, force: true })
    }
  })

  it('falls back to the resolved project root (not the raw process.cwd()) when no projectRoot argument is given', async () => {
    // Regression: the default used to be the raw `process.cwd()`, which silently scoped a
    // `semantic` call made from a project subdirectory to that subtree only. It must now resolve
    // up to the actual project root the same way runFind/runChanged already do.
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'semantic', arguments: { query: 'anything' } })

      expect(result.isError).toBe(false)
      expect(searchSemanticMock).toHaveBeenCalledTimes(1)
      const call = searchSemanticMock.mock.calls[0]
      expect(call?.[5]).toBe(resolveProjectRoot({ project: process.cwd() }))
    } finally {
      await close()
    }
  })
})
