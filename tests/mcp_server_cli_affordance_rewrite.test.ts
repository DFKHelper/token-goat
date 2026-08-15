// Regression: MCP tool error/ambiguity responses used to carry CLI-only text verbatim -- e.g.
// an ambiguous `read` call returned a literal shell retry command
// (`token-goat read "file::Class.method"`), and overflow markers said things like "use --json"
// or "pass --limit". An MCP client has no shell and no CLI flags, only this tool's own JSON
// params, so a model driving an MCP client would either try to shell out (which fails) or get
// stuck instead of correctly re-calling the tool with adjusted params.
//
// This drives the real `read`/`symbol` tools through the actual MCP protocol layer (same
// pattern as mcp_server.test.ts) and asserts the CLI-only phrasing is gone from the tool's
// response, replaced with MCP-appropriate guidance.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi, beforeEach } from 'vitest'

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

function candidate(filePath: string, lineStart: number, lineEnd: number): SymbolEntry {
  // docstring (not parent) deliberately holds 'Session' here -- exercises findParentName's
  // backward-compat fallback for a pre-`parent`-column row (parent: '').
  return {
    filePath,
    name: 'refresh',
    kind: 'method',
    lineStart,
    lineEnd,
    body: 'refresh() {}',
    docstring: 'Session',
    parent: '',
  }
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

describe('mcp tool responses rewrite CLI-only affordances into tool-call guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('an ambiguous read result does not leak a literal shell retry command', async () => {
    // Two distinct definitions of the same method name in the same file -> genuine same-file
    // ambiguity (formatAmbiguity's non-multiFile branch), which is what emits the CLI retry
    // command this test targets.
    querySymbolsMock.mockReturnValue([candidate('a.ts', 10, 12), candidate('a.ts', 30, 32)])

    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'read', arguments: { spec: 'a.ts::refresh' } })
      expect(result.isError).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = (result.content as any[])[0]
      expect(block.text).not.toContain('token-goat read')
      expect(block.text).toContain('the "read" tool again')
      expect(block.text).toContain('spec')
    } finally {
      await close()
    }
  })

  it('rejecting limit: 0 on the symbol tool does not leak the CLI --limit flag spelling', async () => {
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'symbol', arguments: { name: 'anything', limit: 0 } })
      expect(result.isError).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = (result.content as any[])[0]
      // Schema validation rejects limit: 0 before it ever reaches runSymbol's own
      // "--limit must be a positive number" text, so this exercises the MCP SDK's own
      // validation-error message rather than the read_commands.ts string -- assert only that
      // no CLI flag spelling leaks through either path.
      expect(block.text).not.toContain('--limit')
    } finally {
      await close()
    }
  })
})
