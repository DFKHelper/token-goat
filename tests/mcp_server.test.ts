import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createMcpServer } from '../src/mcp_server.js'
import { runRead } from '../src/read_commands.js'

const TOOL_NAMES = ['read', 'symbol', 'section', 'outline', 'skeleton', 'semantic']

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

  it('lists all 6 surgical-read tools over the real protocol layer', async () => {
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
})
