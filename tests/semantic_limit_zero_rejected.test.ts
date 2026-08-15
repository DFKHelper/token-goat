// Regression: `limit: 0` translates to SQL `LIMIT 0`, which always returns zero rows regardless
// of whether matches actually exist -- silently reporting "no matches" for a query that would
// otherwise succeed, instead of surfacing the caller's mistake. `limit: 0` (or negative) must be
// rejected as an explicit invalid-argument error, and the `semantic` MCP tool's schema must reject
// it at the validation layer before the handler is even invoked.
import { describe, expect, it } from 'vitest'

import { runSemantic } from '../src/read_commands.js'
import { createMcpServer } from '../src/mcp_server.js'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

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

describe('runSemantic limit: 0 rejection (unit)', () => {
  it('returns a non-zero code and does not claim "no matches" for limit: 0', async () => {
    const result = await runSemantic('anything', { limit: 0 })
    expect(result.code).not.toBe(0)
    expect(result.text.toLowerCase()).toContain('limit')
    expect(result.text).not.toContain('No matches')
  })

  it('returns a non-zero code for a negative limit', async () => {
    const result = await runSemantic('anything', { limit: -5 })
    expect(result.code).not.toBe(0)
    expect(result.text.toLowerCase()).toContain('limit')
  })
})

describe('mcp semantic tool rejects limit: 0 (live JSON-RPC call)', () => {
  it('returns isError: true for limit: 0', async () => {
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'semantic', arguments: { query: 'anything', limit: 0 } })
      expect(result.isError).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = (result.content as any[])[0]
      expect(block.text).toContain('validation error')
    } finally {
      await close()
    }
  })
})
